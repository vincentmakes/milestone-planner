"""Tests for organization-level SSO login behaviour.

Covers the three defects that made org SSO fail silently:
- failed logins redirected to "/" (bounced to the admin portal, error dropped)
- a failed Graph group lookup was indistinguishable from "member of no groups"
- the tenant SSO settings screen never received the organization's values
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.organization import OrganizationSSOConfig
from app.routers.auth import _sso_error_redirect, get_sso_config_full
from app.services.sso import OrgSSOLookupError, SSOService

# ---------------------------------------------------------------------------
# _sso_error_redirect
# ---------------------------------------------------------------------------


def test_error_redirect_returns_to_the_tenant_login_screen():
    """With a slug from the signed state, failures land back inside the tenant."""
    response = _sso_error_redirect("acme", "SSO not configured")

    assert response.status_code == 302
    assert response.headers["location"] == "/t/acme/?sso_error=SSO+not+configured"


def test_error_redirect_falls_back_to_root_without_a_slug():
    """Pre-state failures have no tenant to return to."""
    response = _sso_error_redirect(None, "Invalid SSO state")

    assert response.headers["location"] == "/?sso_error=Invalid+SSO+state"


def test_error_redirect_encodes_the_message():
    """The message travels as a query parameter, so it must be escaped."""
    response = _sso_error_redirect("acme", "No account found. Contact administrator.")

    location = response.headers["location"]
    assert location.startswith("/t/acme/?sso_error=")
    assert " " not in location


# ---------------------------------------------------------------------------
# SSOService.fetch_user_groups / validate_group_membership
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_user_groups_returns_none_when_the_lookup_fails():
    """A Graph failure is 'unknown', not 'member of nothing'."""
    svc = SSOService(MagicMock())

    response = MagicMock(status_code=403, text="Insufficient privileges")
    client = AsyncMock()
    client.get = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.services.sso.httpx.AsyncClient", return_value=client):
        assert await svc.fetch_user_groups("token") is None


@pytest.mark.asyncio
async def test_fetch_user_groups_returns_group_ids_on_success():
    svc = SSOService(MagicMock())

    response = MagicMock(status_code=200)
    response.json = MagicMock(
        return_value={
            "value": [
                {"@odata.type": "#microsoft.graph.group", "id": "group-1"},
                {"@odata.type": "#microsoft.graph.user", "id": "not-a-group"},
            ]
        }
    )
    client = AsyncMock()
    client.get = AsyncMock(return_value=response)
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.services.sso.httpx.AsyncClient", return_value=client):
        assert await svc.fetch_user_groups("token") == ["group-1"]


def test_validate_group_membership_denies_when_user_has_no_groups():
    """An empty list is still a real answer: the user is in none of them."""
    svc = SSOService(MagicMock())

    assert svc.validate_group_membership([], ["group-1"], "any") is False
    assert svc.validate_group_membership(["group-1"], ["group-1"], "any") is True


# ---------------------------------------------------------------------------
# OrganizationSSOConfig.is_configured
# ---------------------------------------------------------------------------


def test_org_sso_is_not_configured_without_a_redirect_uri():
    """Otherwise the login page advertises SSO that /auth/sso/login rejects."""
    config = OrganizationSSOConfig(
        entra_tenant_id="tenant",
        client_id="client",
        client_secret_encrypted="iv:tag:cipher",
        redirect_uri=None,
    )
    assert config.is_configured is False

    config.redirect_uri = "https://host/api/auth/sso/callback"
    assert config.is_configured is True


# ---------------------------------------------------------------------------
# SSOConfig.is_configured (tenant level)
# ---------------------------------------------------------------------------


def test_tenant_sso_is_not_configured_without_a_client_secret():
    """A row with no secret cannot sign anyone in, so it must not advertise SSO."""
    from app.models.settings import SSOConfig

    config = SSOConfig(
        tenant_id="tenant",
        client_id="client",
        client_secret=None,
        redirect_uri="https://host/t/acme/api/auth/sso/callback",
    )
    assert config.is_configured is False

    config.client_secret = "a-real-secret"
    assert config.is_configured is True


# ---------------------------------------------------------------------------
# A failed organization lookup is not "no organization SSO"
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_org_lookup_raises_when_the_master_db_is_unreachable():
    svc = SSOService(MagicMock())

    with (
        patch(
            "app.services.master_db.master_db.session",
            MagicMock(side_effect=RuntimeError("master DB down")),
        ),
        pytest.raises(OrgSSOLookupError),
    ):
        await svc._get_organization_sso_config("tenant-uuid")


@pytest.mark.asyncio
async def test_org_lookup_raises_when_the_secret_cannot_be_decrypted():
    """A rotated TENANT_ENCRYPTION_KEY must not read as 'no organization SSO'."""
    svc = SSOService(MagicMock())
    tenant = MagicMock(
        organization=MagicMock(
            id="org-uuid",
            name="Acme",
            slug="acme",
            sso_config=MagicMock(
                is_enabled=True,
                is_configured=True,
                client_secret_encrypted="iv:tag:cipher",
            ),
        )
    )
    session = MagicMock()
    session.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=tenant))
    )
    session_cm = MagicMock()
    session_cm.__aenter__ = AsyncMock(return_value=session)
    session_cm.__aexit__ = AsyncMock(return_value=False)

    with (
        patch("app.services.master_db.master_db.session", MagicMock(return_value=session_cm)),
        patch("app.services.sso.decrypt", MagicMock(side_effect=ValueError("bad key"))),
        pytest.raises(OrgSSOLookupError),
    ):
        await svc._get_organization_sso_config("tenant-uuid")


@pytest.mark.asyncio
async def test_sso_login_fails_closed_when_the_org_lookup_fails():
    """Better a 503 than starting a sign-in against the wrong app registration."""
    from fastapi import HTTPException

    from app.routers.auth import sso_login

    request = MagicMock()
    request.state.tenant = {"id": "tenant-uuid", "slug": "acme"}

    with (
        patch.object(
            SSOService,
            "get_effective_sso_config",
            AsyncMock(side_effect=OrgSSOLookupError("master DB down")),
        ),
        pytest.raises(HTTPException) as exc,
    ):
        await sso_login(request=request, db=MagicMock())

    assert exc.value.status_code == 503


# ---------------------------------------------------------------------------
# GET /sso/config/full with organization SSO active
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_config_full_reports_the_organization_settings(mock_db_session):
    """The settings screen must show what is actually in effect, read-only."""
    mock_db_session.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=None))
    )

    org_sso = {
        "enabled": True,
        "tenant_id": "entra-tenant-id",
        "client_id": "entra-client-id",
        "client_secret": "super-secret-value",
        "redirect_uri": "https://host/api/auth/sso/callback",
        "auto_create_users": True,
        "default_role": "superuser",
        "organization": {"name": "Acme"},
    }

    with patch("app.routers.auth._active_org_sso", AsyncMock(return_value=org_sso)):
        response = await get_sso_config_full(
            request=MagicMock(), db=mock_db_session, admin=MagicMock()
        )

    assert response["org_sso_active"] is True
    assert response["organization"] == {"name": "Acme"}
    assert response["enabled"] == 1
    assert response["tenant_id"] == "entra-tenant-id"
    assert response["client_id"] == "entra-client-id"
    assert response["redirect_uri"] == "https://host/api/auth/sso/callback"
    assert response["auto_create_users"] == 1
    assert response["default_role"] == "superuser"

    # The secret is never returned, only a masked hint.
    assert "client_secret" not in response
    assert response["client_secret_masked"] == "****alue"


@pytest.mark.asyncio
async def test_config_full_leaves_the_tenant_row_alone_without_org_sso(mock_db_session):
    """Without org SSO the endpoint keeps reporting the tenant's own config."""
    tenant_config = MagicMock(
        id=1,
        enabled=1,
        tenant_id="tenant-level-id",
        client_id="tenant-client",
        client_secret="tenant-secret",
        redirect_uri="https://host/t/acme/api/auth/sso/callback",
        auto_create_users=0,
        default_role="user",
    )
    mock_db_session.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=tenant_config))
    )

    with patch("app.routers.auth._active_org_sso", AsyncMock(return_value=None)):
        response = await get_sso_config_full(
            request=MagicMock(), db=mock_db_session, admin=MagicMock()
        )

    assert response["org_sso_active"] is False
    assert response["tenant_id"] == "tenant-level-id"
    assert response["client_secret_masked"] == "****cret"
