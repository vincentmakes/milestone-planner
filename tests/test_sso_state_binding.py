"""
OAuth state bound to the browser (B1-8).

/auth/sso/login sets a short-lived HttpOnly ``sso_nonce`` cookie carrying the
nonce of the signed state; the callback refuses a state whose nonce does not
match the cookie (login CSRF, replay) and clears the cookie on every outcome.
"""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.routers.auth import SSO_NONCE_COOKIE, _sign_sso_state, _sso_state_nonce
from app.services.sso import SSOService

CONFIG = {
    "enabled": True,
    "provider": "entra",
    "tenant_id": "entra-tenant",
    "client_id": "client-id",
    "client_secret": "secret",
    "redirect_uri": "https://example.test/api/auth/sso/callback",
    "auto_create_users": False,
    "default_role": "user",
    "required_group_ids": [],
    "group_membership_mode": "any",
}


def resolved_tenant(db):
    @asynccontextmanager
    async def _resolved(request, default_db, tenant_slug):
        yield db, {"id": "tenant-uuid", "slug": tenant_slug}

    return patch("app.routers.auth._resolve_sso_tenant_session", _resolved)


def effective_config():
    return patch.object(
        SSOService, "get_effective_sso_config", AsyncMock(return_value=(CONFIG, "tenant"))
    )


def sso_error_of(response) -> str:
    return parse_qs(urlparse(response.headers["location"]).query)["sso_error"][0]


def nonce_cookie_header(response) -> str:
    headers = [h for h in response.headers.get_list("set-cookie") if h.startswith(SSO_NONCE_COOKIE)]
    assert headers, "no sso_nonce Set-Cookie header"
    return headers[0]


def test_state_nonce_extraction():
    state = _sign_sso_state("acme")
    assert _sso_state_nonce(state) == state.split(":")[1]
    assert _sso_state_nonce("nonce:sig") == "nonce"
    assert _sso_state_nonce(None) is None
    assert _sso_state_nonce("garbage") is None


@pytest.mark.asyncio
async def test_login_sets_an_httponly_nonce_cookie_matching_the_state(app_client):
    with effective_config():
        resp = await app_client.get("/api/auth/sso/login")

    assert resp.status_code == 200
    state = parse_qs(urlparse(resp.json()["url"]).query)["state"][0]
    header = nonce_cookie_header(resp)
    assert f"{SSO_NONCE_COOKIE}={_sso_state_nonce(state)}" in header
    lowered = header.lower()
    assert "httponly" in lowered
    assert "max-age=600" in lowered
    assert "path=/" in lowered
    assert "samesite=lax" in lowered


@pytest.mark.asyncio
async def test_callback_without_the_cookie_is_refused(app_client, mock_db_session):
    """A valid signed state minted elsewhere (login CSRF) does not sign anyone in."""
    state = _sign_sso_state("acme")
    post = AsyncMock()

    with (
        resolved_tenant(mock_db_session),
        effective_config(),
        patch("httpx.AsyncClient.post", post),
    ):
        resp = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    assert resp.status_code == 302
    assert resp.headers["location"].startswith("/t/acme/")
    assert "expired or was started elsewhere" in sso_error_of(resp)
    post.assert_not_awaited()


@pytest.mark.asyncio
async def test_callback_with_another_sign_ins_cookie_is_refused(app_client, mock_db_session):
    state = _sign_sso_state("acme")
    app_client.cookies.set(SSO_NONCE_COOKIE, _sso_state_nonce(_sign_sso_state("acme")))
    post = AsyncMock()

    with (
        resolved_tenant(mock_db_session),
        effective_config(),
        patch("httpx.AsyncClient.post", post),
    ):
        resp = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    assert "expired or was started elsewhere" in sso_error_of(resp)
    post.assert_not_awaited()


@pytest.mark.asyncio
async def test_callback_with_the_matching_cookie_proceeds_and_clears_it(
    app_client, mock_db_session
):
    state = _sign_sso_state("acme")
    app_client.cookies.set(SSO_NONCE_COOKIE, _sso_state_nonce(state))
    post = AsyncMock(return_value=httpx.Response(400, json={"error": "invalid_grant"}))

    with (
        resolved_tenant(mock_db_session),
        effective_config(),
        patch("httpx.AsyncClient.post", post),
    ):
        resp = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    post.assert_awaited_once()  # got past the binding check to the token exchange
    header = nonce_cookie_header(resp).lower()
    assert "max-age=0" in header or "expires=thu, 01 jan 1970" in header


@pytest.mark.asyncio
async def test_a_state_cannot_be_replayed_after_the_callback(app_client, mock_db_session):
    """Real round trip: login sets the cookie, the callback consumes it."""
    post = AsyncMock(return_value=httpx.Response(400, json={"error": "invalid_grant"}))

    with (
        resolved_tenant(mock_db_session),
        effective_config(),
        patch("httpx.AsyncClient.post", post),
    ):
        login = await app_client.get("/api/auth/sso/login")
        state = parse_qs(urlparse(login.json()["url"]).query)["state"][0]
        first = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )
        replay = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    assert "expired or was started elsewhere" not in sso_error_of(first)
    assert post.await_count == 1
    assert "expired or was started elsewhere" in sso_error_of(replay)


@pytest.mark.asyncio
async def test_early_callback_failures_also_clear_the_cookie(app_client):
    app_client.cookies.set(SSO_NONCE_COOKIE, "whatever")
    resp = await app_client.get(
        "/api/auth/sso/callback?error=access_denied", follow_redirects=False
    )
    assert resp.status_code == 302
    nonce_cookie_header(resp)


@pytest.mark.asyncio
async def test_an_unexpected_callback_error_still_clears_the_cookie(app_client, mock_db_session):
    """No opaque 500 with the cookie left behind: the failure is rolled back,
    logged, and redirected to the tenant's sign-in screen."""
    state = _sign_sso_state("acme")
    app_client.cookies.set(SSO_NONCE_COOKIE, _sso_state_nonce(state))
    boom = AsyncMock(side_effect=RuntimeError("database went away"))

    with (
        resolved_tenant(mock_db_session),
        patch.object(SSOService, "get_effective_sso_config", boom),
    ):
        resp = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    boom.assert_awaited_once()
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("/t/acme/")
    assert sso_error_of(resp) == "SSO sign-in failed. Please try again."
    header = nonce_cookie_header(resp).lower()
    assert "max-age=0" in header or "expires=thu, 01 jan 1970" in header
    mock_db_session.rollback.assert_awaited()
