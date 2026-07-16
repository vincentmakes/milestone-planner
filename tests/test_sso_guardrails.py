"""Tests for organization-vs-tenant SSO guardrails.

Covers:
- SSOService.get_active_organization_sso (thin wrapper over the master-DB lookup)
- _reject_if_org_sso_active (409 guard used by the tenant-level SSO write endpoints)
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.routers.auth import _reject_if_org_sso_active
from app.schemas.auth import SSOConfigUpdate
from app.services.sso import SSOService

# ---------------------------------------------------------------------------
# SSOService.get_active_organization_sso
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_active_organization_sso_returns_config_when_org_active():
    """When the org lookup yields a config, it is returned verbatim."""
    svc = SSOService(MagicMock())
    org_config = {"enabled": True, "organization": {"name": "Acme"}}
    with patch.object(
        SSOService, "_get_organization_sso_config", AsyncMock(return_value=org_config)
    ) as mocked:
        result = await svc.get_active_organization_sso("11111111-1111-1111-1111-111111111111")
    assert result is org_config
    mocked.assert_awaited_once_with("11111111-1111-1111-1111-111111111111")


@pytest.mark.asyncio
async def test_get_active_organization_sso_none_when_no_org():
    """No org SSO -> None."""
    svc = SSOService(MagicMock())
    with patch.object(SSOService, "_get_organization_sso_config", AsyncMock(return_value=None)):
        assert await svc.get_active_organization_sso("some-id") is None


@pytest.mark.asyncio
async def test_get_active_organization_sso_none_when_no_tenant_id():
    """A missing tenant id short-circuits to None without hitting the master DB."""
    svc = SSOService(MagicMock())
    with patch.object(
        SSOService, "_get_organization_sso_config", AsyncMock(return_value={"x": 1})
    ) as mocked:
        assert await svc.get_active_organization_sso(None) is None
    mocked.assert_not_awaited()


# ---------------------------------------------------------------------------
# _reject_if_org_sso_active
# ---------------------------------------------------------------------------


def test_reject_raises_409_when_org_active_and_enabling():
    """Enabling tenant SSO while org SSO is active is a 409 with the org name."""
    data = SSOConfigUpdate(enabled=True)
    org_sso = {"organization": {"name": "Acme"}}
    with pytest.raises(HTTPException) as exc:
        _reject_if_org_sso_active(data, org_sso)
    assert exc.value.status_code == 409
    assert "Acme" in exc.value.detail


def test_reject_allows_disabling_while_org_active():
    """Disabling/clearing tenant SSO stays allowed even when org SSO is active."""
    data = SSOConfigUpdate(enabled=False)
    _reject_if_org_sso_active(data, {"organization": {"name": "Acme"}})  # no raise


def test_reject_noop_when_no_org_sso():
    """No org SSO -> never blocks, regardless of enabled."""
    _reject_if_org_sso_active(SSOConfigUpdate(enabled=True), None)  # no raise


def test_reject_noop_when_enabled_not_set():
    """A partial update that doesn't touch `enabled` is allowed."""
    _reject_if_org_sso_active(SSOConfigUpdate(tenant_id="x"), {"organization": {}})  # no raise
