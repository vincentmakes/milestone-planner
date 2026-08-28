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

from app.routers.auth import _parse_sso_state, _sign_sso_state
from app.services.sso import OrgSSOLookupError, SSOService

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
    state = _sign_sso_state("acme")

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
    state = _sign_sso_state("acme")
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
    state = _sign_sso_state("acme")
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
    state = _sign_sso_state("acme")
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
