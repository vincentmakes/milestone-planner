"""
SSO default-role validation (F3-5 / B1-6) and secret-free SSO logging (B1-4).

An organization SSO ``default_user_role`` outside the tenant ``users`` role set
used to be stored as-is; the callback then inserted it into ``users.role`` and
every first-time sign-in in the organization failed with a 500.

Since RBAC the stored default is resolved per tenant at sign-in
(``resolve_sso_default_role``): a key that exists in the tenant's ``roles``
and is not ``admin``, otherwise ``user`` -- an auto-created account never
becomes an administrator.
"""

import logging
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.models.user import User
from app.routers.auth import SSO_NONCE_COOKIE, _sign_sso_state, _sso_state_nonce
from app.schemas.auth import SSOConfigUpdate
from app.schemas.organization import OrganizationSSOConfigCreate
from app.services.session import SessionService
from app.services.sso import SSOService, resolve_sso_default_role
from tests.conftest import FakeUser
from tests.support import scalar_result
from tests.test_sso_callback import ORG_CONFIG, resolved_tenant

# ---------------------------------------------------------------------------
# Write-side validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["user", "superuser"])
def test_org_sso_accepts_valid_roles(role):
    assert OrganizationSSOConfigCreate(defaultUserRole=role).default_user_role == role


@pytest.mark.parametrize("role", ["viewer", "Admin", "admin", "", "member"])
def test_org_sso_rejects_invalid_roles(role):
    with pytest.raises(ValidationError):
        OrganizationSSOConfigCreate(defaultUserRole=role)


def test_org_sso_role_is_optional():
    assert OrganizationSSOConfigCreate().default_user_role is None


@pytest.mark.parametrize("role", ["admin", "Admin", "not a key", ""])
def test_tenant_sso_rejects_the_admin_role_and_malformed_keys(role):
    # Never the admin role (sign-in never creates an administrator); a custom
    # role key passes the schema and is checked against ``roles`` by the route.
    with pytest.raises(ValidationError):
        SSOConfigUpdate(default_role=role)


@pytest.mark.parametrize("role", ["user", "superuser", "team_lead"])
def test_tenant_sso_schema_accepts_role_keys(role):
    assert SSOConfigUpdate(default_role=role).default_role == role


@pytest.mark.asyncio
async def test_org_sso_put_with_invalid_role_is_422(test_settings):
    with patch("app.config.get_settings", return_value=test_settings):
        from app.main import create_app
        from app.routers.admin.auth import get_current_admin
        from app.services.master_db import get_master_db

        app = create_app()
        master_db = MagicMock()
        master_db.execute = AsyncMock()
        app.dependency_overrides[get_current_admin] = lambda: MagicMock(email="p@example.com")
        app.dependency_overrides[get_master_db] = lambda: master_db

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.put(
                "/api/admin/organizations/org-uuid/sso", json={"defaultUserRole": "viewer"}
            )

        app.dependency_overrides.clear()

    assert resp.status_code == 422
    master_db.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# Read-side fallback
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("stored", "expected"),
    [
        ("user", "user"),
        ("superuser", "superuser"),
        (" Superuser ", "superuser"),
        # Never an administrator by default, whatever is stored.
        ("admin", "user"),
        (" Admin ", "user"),
        ("", "user"),
        ("   ", "user"),
        (None, "user"),
        (3, "user"),
    ],
)
async def test_resolve_sso_default_role_without_a_lookup(stored, expected, mock_db_session):
    """System roles always exist; non-strings and admin never reach the database."""
    assert await resolve_sso_default_role(mock_db_session, stored) == expected
    mock_db_session.execute.assert_not_awaited()


async def test_resolve_sso_default_role_accepts_an_existing_custom_role(mock_db_session):
    mock_db_session.execute.return_value = scalar_result("team_lead")

    assert await resolve_sso_default_role(mock_db_session, "team_lead") == "team_lead"
    sql = str(
        mock_db_session.execute.await_args.args[0].compile(compile_kwargs={"literal_binds": True})
    )
    assert "roles.key = 'team_lead'" in sql


async def test_resolve_sso_default_role_falls_back_for_an_unknown_role(mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)

    assert await resolve_sso_default_role(mock_db_session, "viewer") == "user"


async def test_resolve_sso_default_role_skips_the_lookup_for_a_malformed_key(mock_db_session):
    assert await resolve_sso_default_role(mock_db_session, "Not a key!") == "user"
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("stored", ["viewer", "admin"])
async def test_callback_auto_creates_user_with_fallback_role(app_client, mock_db_session, stored):
    """A stored 'viewer' default creates a 'user', not an IntegrityError/500; 'admin' too."""
    config = {**ORG_CONFIG, "auto_create_users": True, "default_role": stored}
    state = _sign_sso_state("acme")
    # /auth/sso/login sets this cookie; the callback requires it (B1-8).
    app_client.cookies.set(SSO_NONCE_COOKIE, _sso_state_nonce(state))

    lookup = MagicMock()
    lookup.scalar_one_or_none.return_value = None  # no existing user

    # Only the callback's own client is faked; the test client is httpx too.
    entra = MagicMock()
    entra.post = AsyncMock(return_value=httpx.Response(200, json={"access_token": "tok"}))
    entra.get = AsyncMock(
        return_value=httpx.Response(
            200,
            json={
                "mail": "new.person@acme.test",
                "givenName": "New",
                "surname": "Person",
                "id": "entra-oid",
            },
        )
    )
    entra.__aenter__ = AsyncMock(return_value=entra)
    entra.__aexit__ = AsyncMock(return_value=False)
    mock_db_session.execute.return_value = lookup

    with (
        resolved_tenant(mock_db_session),
        patch.object(
            SSOService,
            "get_effective_sso_config",
            AsyncMock(return_value=(config, "organization")),
        ),
        patch("app.routers.auth.httpx.AsyncClient", return_value=entra),
        patch.object(SessionService, "create_session", AsyncMock(return_value="new-sid")),
    ):
        resp = await app_client.get(
            f"/api/auth/sso/callback?code=abc&state={state}", follow_redirects=False
        )

    assert resp.status_code == 302
    assert resp.headers["location"] == "/t/acme/"
    created = [c.args[0] for c in mock_db_session.add.call_args_list]
    users = [u for u in created if isinstance(u, User)]
    assert len(users) == 1
    assert users[0].role == "user"


# ---------------------------------------------------------------------------
# B1-4 — the SSO client secret never reaches the log
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sso_config_update_does_not_log_client_secret(authed_client, mock_db_session, caplog):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    result = MagicMock()
    result.scalar_one_or_none.return_value = None
    mock_db_session.execute.return_value = result

    secret = "SUPER-SECRET-ENTRA-VALUE"
    with caplog.at_level(logging.DEBUG):
        resp = await client.put(
            "/api/sso/config",
            json={"enabled": False, "client_id": "cid", "client_secret": secret},
        )

    assert resp.status_code == 200
    assert caplog.records, "expected the update to be logged"
    assert all(secret not in record.getMessage() for record in caplog.records)
