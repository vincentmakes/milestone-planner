"""Tests for the SSO OAuth-state handling and callback tenant recovery.

Organization SSO shares one callback URL with no /t/{slug}/ prefix, so the
tenant slug must travel inside the signed OAuth ``state`` and be recovered in the
callback. These tests cover the state round-trip and the defensive fallback that
keeps the callback from 500-ing when it runs without tenant context.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.routers.auth import _parse_sso_state, _sign_sso_state
from app.services.sso import SSOService

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
