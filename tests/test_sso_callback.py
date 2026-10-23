"""Tests for the SSO OAuth-state handling and callback tenant recovery.

Organization SSO shares one callback URL with no /t/{slug}/ prefix, so the
tenant slug must travel inside the signed OAuth ``state`` and be recovered in the
callback. These tests cover the state round-trip and the defensive fallback that
keeps the callback from 500-ing when it runs without tenant context.
"""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.routers.auth import (
    SSO_NONCE_COOKIE,
    _parse_sso_state,
    _sign_sso_state,
    _sso_state_nonce,
)
from app.services.sso import OrgSSOLookupError, SSOService


def browser_state(client, slug: str | None) -> str:
    """
    Sign a state and give ``client`` the matching ``sso_nonce`` cookie.

    /auth/sso/login sets that cookie; the callback requires it (B1-8).
    """
    state = _sign_sso_state(slug)
    client.cookies.set(SSO_NONCE_COOKIE, _sso_state_nonce(state))
    return state


# ---------------------------------------------------------------------------
# Signed OAuth state round-trip
# ---------------------------------------------------------------------------


def test_state_roundtrips_tenant_slug():
    """A slug embedded at login is recovered and validated in the callback."""
    state = _sign_sso_state("acme")
    slug, valid = _parse_sso_state(state)
    assert valid is True
    assert slug == "acme"


def test_state_without_slug_is_valid_with_none():
    """Single-tenant mode signs an empty slug; it validates and yields None."""
    state = _sign_sso_state(None)
    slug, valid = _parse_sso_state(state)
    assert valid is True
    assert slug is None


def test_state_rejects_tampered_slug():
    """Swapping the slug (to hit another tenant) breaks the signature."""
    state = _sign_sso_state("acme")
    _, nonce, sig = state.split(":")
    tampered = f"evil:{nonce}:{sig}"
    slug, valid = _parse_sso_state(tampered)
    assert valid is False
    assert slug is None


def test_state_rejects_tampered_nonce():
    state = _sign_sso_state("acme")
    slug_part, _, sig = state.split(":")
    tampered = f"{slug_part}:forged-nonce:{sig}"
    _, valid = _parse_sso_state(tampered)
    assert valid is False


def test_state_rejects_garbage_and_empty():
    assert _parse_sso_state(None) == (None, False)
    assert _parse_sso_state("") == (None, False)
    assert _parse_sso_state("nocolon") == (None, False)


def test_legacy_two_part_state_still_validates():
    """A pre-existing {nonce}:{sig} state (no slug) stays valid across deploy."""
    from app.routers.auth import _sso_state_sig

    nonce = "legacy-nonce-value"
    legacy = f"{nonce}:{_sso_state_sig(nonce)}"
    slug, valid = _parse_sso_state(legacy)
    assert valid is True
    assert slug is None


# ---------------------------------------------------------------------------
# Callback must not 500 when the tenant-level config query fails
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_effective_config_fallback_swallows_db_error():
    """If the tenant-level SSOConfig query raises, resolution returns (None, none)."""
    db = MagicMock()
    db.execute = AsyncMock(side_effect=RuntimeError('relation "sso_config" does not exist'))
    svc = SSOService(db)
    svc.settings = MagicMock(multi_tenant=False)

    config, source = await svc.get_effective_sso_config(None)
    assert config is None
    assert source == "none"


# ---------------------------------------------------------------------------
# Callback endpoint wiring — early exits are 302 redirects, never 500
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_callback_bad_state_redirects_not_500(app_client):
    resp = await app_client.get(
        "/api/auth/sso/callback?code=abc&state=tampered", follow_redirects=False
    )
    assert resp.status_code == 302
    assert "sso_error" in resp.headers["location"]


@pytest.mark.asyncio
async def test_callback_missing_code_redirects(app_client):
    resp = await app_client.get("/api/auth/sso/callback", follow_redirects=False)
    assert resp.status_code == 302
    assert "sso_error" in resp.headers["location"]


@pytest.mark.asyncio
async def test_callback_provider_error_redirects(app_client):
    resp = await app_client.get(
        "/api/auth/sso/callback?error=access_denied", follow_redirects=False
    )
    assert resp.status_code == 302
    assert "sso_error" in resp.headers["location"]


# ---------------------------------------------------------------------------
# The token exchange: what the user is told when Entra says no
# ---------------------------------------------------------------------------


def sso_error_of(response) -> str:
    """Read the message the callback sent the user back with."""
    query = parse_qs(urlparse(response.headers["location"]).query)
    return query["sso_error"][0]


def resolved_tenant(db):
    """
    Stand in for the callback's tenant recovery.

    Organization SSO arrives with no tenant prefix, so the callback opens a
    session against the tenant named in the signed state. These tests are about
    what happens *after* that, so the recovery is short-circuited to the mocked
    session.
    """

    @asynccontextmanager
    async def _resolved(request, default_db, tenant_slug):
        yield db, {"id": "tenant-uuid", "slug": tenant_slug}

    return patch("app.routers.auth._resolve_sso_tenant_session", _resolved)


ORG_CONFIG = {
    "enabled": True,
    "provider": "entra",
    "tenant_id": "d9c7995d-4c06-40b7-829c-3921bdc751ed",
    "client_id": "1e03c280-f98d-4cc4-a673-837bb7b4fd47",
    "client_secret": "a-real-secret",
    "redirect_uri": "https://example.test/api/auth/sso/callback",
    "auto_create_users": False,
    "default_role": "user",
    "required_group_ids": [],
    "group_membership_mode": "any",
}


def entra_rejection(code: str) -> httpx.Response:
    return httpx.Response(
        400,
        json={
            "error": "invalid_client",
            "error_description": f"{code}: something Microsoft says.",
            "error_codes": [int(code.removeprefix("AADSTS"))],
        },
    )


@pytest.mark.asyncio
async def test_callback_reports_the_aadsts_cause(app_client, mock_db_session):
    """A rejected exchange must name the cause, not say 'it failed'."""
    state = browser_state(app_client, "acme")

    with (
        resolved_tenant(mock_db_session),
        patch.object(
            SSOService,
            "get_effective_sso_config",
            AsyncMock(return_value=(ORG_CONFIG, "organization")),
        ),
        patch(
            "httpx.AsyncClient.post",
            AsyncMock(return_value=entra_rejection("AADSTS9002327")),
        ),
    ):
        resp = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    assert resp.status_code == 302
    assert resp.headers["location"].startswith("/t/acme/")
    assert "AADSTS9002327" in sso_error_of(resp)


@pytest.mark.asyncio
async def test_callback_redeems_with_the_resolved_redirect_uri(app_client, mock_db_session):
    """The code must be redeemed against the same URI the sign-in used."""
    state = browser_state(app_client, "acme")
    post = AsyncMock(return_value=entra_rejection("AADSTS54005"))

    with (
        resolved_tenant(mock_db_session),
        patch.object(
            SSOService,
            "get_effective_sso_config",
            AsyncMock(return_value=(ORG_CONFIG, "organization")),
        ),
        patch("httpx.AsyncClient.post", post),
    ):
        await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    url = post.await_args.args[0]
    sent = post.await_args.kwargs["data"]
    assert url == (
        "https://login.microsoftonline.com/d9c7995d-4c06-40b7-829c-3921bdc751ed/oauth2/v2.0/token"
    )
    assert sent["redirect_uri"] == ORG_CONFIG["redirect_uri"]
    assert sent["client_id"] == ORG_CONFIG["client_id"]
    assert sent["client_secret"] == ORG_CONFIG["client_secret"]
    assert sent["grant_type"] == "authorization_code"
    assert sent["scope"] == "openid profile email User.Read"


@pytest.mark.asyncio
async def test_callback_refuses_to_send_an_empty_client_secret(app_client, mock_db_session):
    """An empty secret earns 'invalid client' from Entra — say what's wrong."""
    state = browser_state(app_client, "acme")
    post = AsyncMock()

    with (
        resolved_tenant(mock_db_session),
        patch.object(
            SSOService,
            "get_effective_sso_config",
            AsyncMock(return_value=({**ORG_CONFIG, "client_secret": "  "}, "organization")),
        ),
        patch("httpx.AsyncClient.post", post),
    ):
        resp = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    post.assert_not_awaited()
    assert "client secret" in sso_error_of(resp)


@pytest.mark.asyncio
async def test_callback_never_falls_back_when_the_org_lookup_fails(app_client, mock_db_session):
    """
    A failed organization lookup must not redeem against the tenant config.

    Falling back means exchanging the code against a different client and
    redirect URI than the one Entra issued it for — which comes back as a
    redirect-URI mismatch and sends everyone hunting in the wrong place.
    """
    state = browser_state(app_client, "acme")
    post = AsyncMock()

    with (
        resolved_tenant(mock_db_session),
        patch.object(
            SSOService,
            "get_effective_sso_config",
            AsyncMock(side_effect=OrgSSOLookupError("master DB down")),
        ),
        patch("httpx.AsyncClient.post", post),
    ):
        resp = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    post.assert_not_awaited()
    assert resp.status_code == 302
    assert "temporarily unavailable" in sso_error_of(resp)


@pytest.mark.asyncio
async def test_effective_config_does_not_swallow_an_org_lookup_failure():
    """The distinction has to survive get_effective_sso_config itself."""
    db = MagicMock()
    db.execute = AsyncMock()
    svc = SSOService(db)
    svc.settings = MagicMock(multi_tenant=True)

    with (
        patch.object(
            SSOService,
            "_get_organization_sso_config",
            AsyncMock(side_effect=OrgSSOLookupError("decrypt failed")),
        ),
        pytest.raises(OrgSSOLookupError),
    ):
        await svc.get_effective_sso_config({"id": "tenant-uuid"})

    # And the tenant-level table was never consulted.
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_callback_reports_a_responder_that_is_not_microsoft(app_client, mock_db_session):
    """A proxy block page has no AADSTS code — say so, don't blame the config."""
    state = browser_state(app_client, "acme")
    block_page = httpx.Response(403, text="<html><body>Blocked by corporate gateway</body></html>")

    with (
        resolved_tenant(mock_db_session),
        patch.object(
            SSOService,
            "get_effective_sso_config",
            AsyncMock(return_value=(ORG_CONFIG, "organization")),
        ),
        patch("httpx.AsyncClient.post", AsyncMock(return_value=block_page)),
    ):
        resp = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    message = sso_error_of(resp)
    assert "did not respond as expected" in message
    assert "HTTP 403" in message
    assert "gateway" not in message


@pytest.mark.asyncio
async def test_callback_reports_an_unreachable_identity_provider(app_client, mock_db_session):
    """A blocked egress used to surface as an opaque 500 with no explanation."""
    state = browser_state(app_client, "acme")

    with (
        resolved_tenant(mock_db_session),
        patch.object(
            SSOService,
            "get_effective_sso_config",
            AsyncMock(return_value=(ORG_CONFIG, "organization")),
        ),
        patch(
            "httpx.AsyncClient.post",
            AsyncMock(side_effect=httpx.ConnectError("connection refused")),
        ),
    ):
        resp = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    assert resp.status_code == 302
    assert "Could not reach the identity provider" in sso_error_of(resp)


# ---------------------------------------------------------------------------
# Code scanning: nothing derived from the secret is logged, and every SSO
# redirect stays a same-origin path
# ---------------------------------------------------------------------------


def test_config_fingerprint_logs_only_the_presence_of_the_secret():
    """Neither the secret nor a digest of it reaches the log line."""
    import hashlib

    from app.routers.auth import _config_fingerprint

    secret = ORG_CONFIG["client_secret"]
    line = _config_fingerprint(ORG_CONFIG, "organization")
    assert "secret=set" in line
    assert secret not in line
    assert hashlib.sha256(secret.encode()).hexdigest()[:8] not in line
    assert "secret=missing" in _config_fingerprint({**ORG_CONFIG, "client_secret": " "}, "tenant")
    assert "secret=missing" in _config_fingerprint({**ORG_CONFIG, "client_secret": None}, "tenant")


@pytest.mark.asyncio
async def test_callback_log_carries_no_secret_digest(app_client, mock_db_session, caplog):
    """The callback's own log lines (both hops' fingerprint) hold no secret material."""
    import hashlib
    import logging

    state = browser_state(app_client, "acme")
    entra = MagicMock()
    entra.post = AsyncMock(return_value=entra_rejection("AADSTS7000215"))
    entra.__aenter__ = AsyncMock(return_value=entra)
    entra.__aexit__ = AsyncMock(return_value=False)
    with (
        caplog.at_level(logging.INFO, logger="app.routers.auth"),
        resolved_tenant(mock_db_session),
        patch.object(
            SSOService,
            "get_effective_sso_config",
            AsyncMock(return_value=(ORG_CONFIG, "organization")),
        ),
        patch("app.routers.auth.httpx.AsyncClient", return_value=entra),
    ):
        resp = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    assert resp.status_code == 302
    secret = ORG_CONFIG["client_secret"]
    digest = hashlib.sha256(secret.encode()).hexdigest()[:8]
    assert "secret=set" in caplog.text
    assert secret not in caplog.text
    assert digest not in caplog.text


@pytest.mark.parametrize(
    "slug, home",
    [
        ("acme", "/t/acme/"),
        ("a", "/t/a/"),
        ("acme-2", "/t/acme-2/"),
        (None, "/"),
        ("", "/"),
        ("/evil.example", "/"),
        ("evil.example/x", "/"),
        ("..", "/"),
        ("Acme", "/"),
        ("acme-", "/"),
        ("a\\b", "/"),
    ],
)
def test_tenant_home_accepts_only_tenant_slugs(slug, home):
    from app.routers.auth import _tenant_home

    assert _tenant_home(slug) == home


@pytest.mark.parametrize(
    "path, expected",
    [
        ("/", "/"),
        ("/t/acme/", "/t/acme/"),
        ("/milestone/", "/milestone/"),
        ("//evil.example/", "/"),
        ("/\\evil.example/", "/"),
        ("https://evil.example/", "/"),
        ("evil.example/", "/"),
        ("", "/"),
    ],
)
def test_local_redirect_path_keeps_same_origin_paths_only(path, expected):
    from app.routers.auth import _local_redirect_path

    assert _local_redirect_path(path) == expected


@pytest.mark.asyncio
async def test_error_redirect_with_a_signed_but_malformed_slug_lands_on_root(app_client):
    """Even a validly signed state cannot steer the redirect off the tenant paths."""
    state = browser_state(app_client, "evil.example")
    resp = await app_client.get(
        f"/api/auth/sso/callback?error=access_denied&state={state}", follow_redirects=False
    )
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("/?sso_error=")


async def _successful_legacy_callback(app_client, mock_db_session, redirect_uri):
    """Run a successful callback with a slug-less state and the given redirect URI."""
    from app.services.session import SessionService

    state = browser_state(app_client, None)
    config = {**ORG_CONFIG, "auto_create_users": True, "redirect_uri": redirect_uri}
    lookup = MagicMock()
    lookup.scalar_one_or_none.return_value = None
    mock_db_session.execute.return_value = lookup
    entra = MagicMock()
    entra.post = AsyncMock(return_value=httpx.Response(200, json={"access_token": "tok"}))
    entra.get = AsyncMock(
        return_value=httpx.Response(
            200,
            json={"mail": "new@acme.test", "givenName": "N", "surname": "P", "id": "oid"},
        )
    )
    entra.__aenter__ = AsyncMock(return_value=entra)
    entra.__aexit__ = AsyncMock(return_value=False)
    with (
        resolved_tenant(mock_db_session),
        patch.object(
            SSOService, "get_effective_sso_config", AsyncMock(return_value=(config, "tenant"))
        ),
        patch("app.routers.auth.httpx.AsyncClient", return_value=entra),
        patch.object(SessionService, "create_session", AsyncMock(return_value="sid")),
    ):
        return await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )


@pytest.mark.asyncio
async def test_legacy_callback_lands_on_the_redirect_uri_prefix(app_client, mock_db_session):
    resp = await _successful_legacy_callback(
        app_client, mock_db_session, "https://host/milestone/api/auth/sso/callback"
    )
    assert resp.status_code == 302
    assert resp.headers["location"] == "/milestone/"


@pytest.mark.asyncio
async def test_legacy_callback_never_redirects_off_origin(app_client, mock_db_session):
    """A redirect URI whose path starts with // must not become a scheme-relative redirect."""
    resp = await _successful_legacy_callback(
        app_client, mock_db_session, "https://host//evil.example/api/auth/sso/callback"
    )
    assert resp.status_code == 302
    assert resp.headers["location"] == "/"
