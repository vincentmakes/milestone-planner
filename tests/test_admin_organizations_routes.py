"""
Route tests for /api/admin/organizations — organization CRUD, the
organization SSO config (read / write / delete), tenant attach/detach and the
tenant group-access PATCH.

Admin-portal routes on the master DB: ``get_current_admin`` and
``get_master_db`` are overridden as in tests/test_sso_default_role.py. The SSO
diagnostic (POST /{id}/sso/test) is covered in tests/test_admin_org_sso_test.py.
"""

import uuid
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.models.organization import Organization, OrganizationSSOConfig
from app.models.tenant import AdminUser, Tenant, TenantAuditLog
from tests.support import scalar_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)
ORG_ID = uuid.UUID("11111111-2222-3333-4444-555555555555")
TENANT_ID = uuid.UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")


def make_org(*, sso: OrganizationSSOConfig | None = None, tenants=None) -> Organization:
    org = Organization(
        id=ORG_ID,
        name="Contoso",
        slug="contoso",
        description="HQ",
        created_at=STAMP,
        updated_at=STAMP,
    )
    org.sso_config = sso
    org.tenants = list(tenants or [])
    return org


def make_sso(**overrides) -> OrganizationSSOConfig:
    values = {
        "organization_id": ORG_ID,
        "enabled": 1,
        "provider": "entra",
        "entra_tenant_id": "entra-tid",
        "client_id": "client-id",
        "client_secret_encrypted": "iv:tag:cipher",
        "redirect_uri": "https://app.example.com/api/auth/sso/callback",
        "auto_create_users": 1,
        "default_user_role": "superuser",
    }
    values.update(overrides)
    return OrganizationSSOConfig(**values)


def make_tenant(org_id=None, **overrides) -> Tenant:
    values = {
        "id": TENANT_ID,
        "name": "Lab A",
        "slug": "lab-a",
        "database_name": "milestone_lab_a",
        "database_user": "lab_a",
        "status": "active",
        "admin_email": "a@example.com",
        "organization_id": org_id,
        "required_group_ids": ["g1"],
        "group_membership_mode": "all",
    }
    values.update(overrides)
    return Tenant(**values)


def audit_logs(db) -> list[TenantAuditLog]:
    return [c.args[0] for c in db.add.call_args_list if isinstance(c.args[0], TenantAuditLog)]


@pytest_asyncio.fixture
async def portal_client(test_settings, mock_db_session):
    with patch("app.config.get_settings", return_value=test_settings):
        from app.main import create_app
        from app.routers.admin.auth import get_current_admin
        from app.services.master_db import get_master_db

        app = create_app()
        admin = AdminUser(id=1, email="portal@example.com", role="admin", must_change_password=0)
        app.dependency_overrides[get_current_admin] = lambda: admin
        app.dependency_overrides[get_master_db] = lambda: mock_db_session

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            yield c

        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_portal_routes_require_an_admin_session(test_settings, mock_db_session):
    with patch("app.config.get_settings", return_value=test_settings):
        from app.main import create_app
        from app.services.master_db import get_master_db

        app = create_app()
        app.dependency_overrides[get_master_db] = lambda: mock_db_session
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            response = await c.get("/api/admin/organizations")
        app.dependency_overrides.clear()

    assert response.status_code == 401
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# Organization CRUD
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_organizations_with_counts(portal_client, mock_db_session):
    rows = MagicMock()
    other = make_org()
    other.id, other.name, other.slug = uuid.uuid4(), "Fabrikam", "fabrikam"
    rows.all.return_value = [(make_org(sso=make_sso()), 3), (other, 0)]
    mock_db_session.execute.return_value = rows

    response = await portal_client.get("/api/admin/organizations")

    assert response.status_code == 200
    assert [(o["slug"], o["tenant_count"], o["sso_enabled"]) for o in response.json()] == [
        ("contoso", 3, True),
        ("fabrikam", 0, False),
    ]
    sql = str(mock_db_session.execute.await_args.args[0])
    assert "LEFT OUTER JOIN tenants" in sql
    assert "GROUP BY organizations.id" in sql


@pytest.mark.asyncio
async def test_create_organization(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)

    async def refresh(obj):
        obj.created_at = STAMP

    mock_db_session.refresh.side_effect = refresh

    response = await portal_client.post(
        "/api/admin/organizations",
        json={"name": "Contoso", "slug": "contoso", "description": "HQ"},
    )

    assert response.status_code == 201
    body = response.json()
    assert (body["name"], body["slug"], body["tenant_count"], body["sso_enabled"]) == (
        "Contoso",
        "contoso",
        0,
        False,
    )
    (org,) = (c.args[0] for c in mock_db_session.add.call_args_list)
    assert isinstance(org.id, uuid.UUID)
    assert body["id"] == str(org.id)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_organization_duplicate_slug_409(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(make_org())

    response = await portal_client.post(
        "/api/admin/organizations", json={"name": "Again", "slug": "contoso"}
    )

    assert response.status_code == 409
    assert "contoso" in response.json()["detail"]
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("slug", ["Contoso", "-bad", "bad-", "has space", ""])
async def test_create_organization_rejects_bad_slug(portal_client, mock_db_session, slug):
    response = await portal_client.post(
        "/api/admin/organizations", json={"name": "X", "slug": slug}
    )

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_get_organization_detail(portal_client, mock_db_session):
    tenant = make_tenant(ORG_ID, required_group_ids=None, group_membership_mode=None)
    mock_db_session.execute.return_value = scalar_result(make_org(sso=make_sso(), tenants=[tenant]))

    response = await portal_client.get(f"/api/admin/organizations/{ORG_ID}")

    assert response.status_code == 200
    body = response.json()
    assert body["sso_config"]["enabled"] is True
    assert body["sso_config"]["configured"] is True
    assert body["sso_config"]["defaultUserRole"] == "superuser"
    assert "client_secret" not in str(body)
    assert body["tenants"] == [
        {
            "id": str(TENANT_ID),
            "name": "Lab A",
            "slug": "lab-a",
            "status": "active",
            "required_group_ids": [],
            "group_membership_mode": "any",
        }
    ]


@pytest.mark.asyncio
async def test_get_organization_without_sso(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(make_org())

    response = await portal_client.get(f"/api/admin/organizations/{ORG_ID}")

    assert response.status_code == 200
    assert response.json()["sso_config"] is None
    assert response.json()["tenants"] == []


@pytest.mark.asyncio
async def test_get_organization_404(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)

    response = await portal_client.get(f"/api/admin/organizations/{ORG_ID}")

    assert response.status_code == 404
    assert response.json()["detail"] == "Organization not found"


@pytest.mark.asyncio
async def test_update_organization(portal_client, mock_db_session):
    org = make_org(sso=make_sso(enabled=0))
    mock_db_session.execute.side_effect = [scalar_result(org), scalar_result(2)]

    response = await portal_client.put(
        f"/api/admin/organizations/{ORG_ID}", json={"name": "Contoso AG", "description": "New"}
    )

    assert response.status_code == 200
    body = response.json()
    assert (body["name"], body["description"], body["tenant_count"], body["sso_enabled"]) == (
        "Contoso AG",
        "New",
        2,
        False,
    )
    assert org.updated_at != STAMP  # touched
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_organization_404(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)

    response = await portal_client.put(f"/api/admin/organizations/{ORG_ID}", json={"name": "X"})

    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_organization_clears_tenant_group_rules(portal_client, mock_db_session):
    tenant = make_tenant(ORG_ID)
    org = make_org(tenants=[tenant])
    mock_db_session.execute.return_value = scalar_result(org)

    response = await portal_client.delete(f"/api/admin/organizations/{ORG_ID}")

    assert response.status_code == 200
    assert response.json() == {"success": True, "message": "Organization 'Contoso' deleted"}
    assert (tenant.required_group_ids, tenant.group_membership_mode) == ([], "any")
    mock_db_session.delete.assert_awaited_once_with(org)
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_organization_404(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)

    response = await portal_client.delete(f"/api/admin/organizations/{ORG_ID}")

    assert response.status_code == 404
    mock_db_session.delete.assert_not_awaited()


# ---------------------------------------------------------------------------
# Organization SSO config
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_sso_config(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(make_org(sso=make_sso()))

    response = await portal_client.get(f"/api/admin/organizations/{ORG_ID}/sso")

    assert response.status_code == 200
    body = response.json()
    assert (body["enabled"], body["configured"], body["autoCreateUsers"]) == (True, True, True)
    assert body["entraTenantId"] == "entra-tid"
    assert "cipher" not in response.text


@pytest.mark.asyncio
async def test_get_sso_config_defaults_when_absent(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(make_org())

    response = await portal_client.get(f"/api/admin/organizations/{ORG_ID}/sso")

    assert response.status_code == 200
    body = response.json()
    assert (body["enabled"], body["configured"], body["defaultUserRole"]) == (
        False,
        False,
        "user",
    )


@pytest.mark.asyncio
async def test_get_sso_config_404(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)

    response = await portal_client.get(f"/api/admin/organizations/{ORG_ID}/sso")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_put_sso_config_creates_and_encrypts_secret(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(make_org())

    with patch("app.routers.admin_organizations.encrypt", return_value="ENC(secret)") as enc:
        response = await portal_client.put(
            f"/api/admin/organizations/{ORG_ID}/sso",
            json={
                "enabled": True,
                "entraTenantId": " entra-tid\n",
                "clientId": "client-id",
                "clientSecret": "s3cret",
                "redirectUri": "https://app.example.com/api/auth/sso/callback",
                "autoCreateUsers": True,
                "defaultUserRole": "admin",
            },
        )

    assert response.status_code == 200
    (config,) = (c.args[0] for c in mock_db_session.add.call_args_list)
    assert isinstance(config, OrganizationSSOConfig)
    assert config.organization_id == ORG_ID
    assert config.entra_tenant_id == "entra-tid"  # pasted whitespace stripped
    assert config.client_secret_encrypted == "ENC(secret)"
    enc.assert_called_once_with("s3cret")
    body = response.json()
    assert (body["enabled"], body["configured"], body["defaultUserRole"]) == (
        True,
        True,
        "admin",
    )
    assert "s3cret" not in response.text


@pytest.mark.asyncio
async def test_put_sso_config_partial_update_keeps_secret(portal_client, mock_db_session):
    sso = make_sso()
    mock_db_session.execute.return_value = scalar_result(make_org(sso=sso))

    with patch("app.routers.admin_organizations.encrypt") as enc:
        response = await portal_client.put(
            f"/api/admin/organizations/{ORG_ID}/sso",
            json={"enabled": False, "clientSecret": "   ", "autoCreateUsers": False},
        )

    assert response.status_code == 200
    enc.assert_not_called()  # whitespace-only secret means "leave as is"
    assert (sso.enabled, sso.auto_create_users, sso.client_secret_encrypted) == (
        0,
        0,
        "iv:tag:cipher",
    )
    mock_db_session.add.assert_not_called()


@pytest.mark.asyncio
async def test_put_sso_config_404(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)

    response = await portal_client.put(
        f"/api/admin/organizations/{ORG_ID}/sso", json={"enabled": True}
    )

    assert response.status_code == 404
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_sso_config(portal_client, mock_db_session):
    sso = make_sso()
    mock_db_session.execute.return_value = scalar_result(make_org(sso=sso))

    response = await portal_client.delete(f"/api/admin/organizations/{ORG_ID}/sso")

    assert response.status_code == 200
    mock_db_session.delete.assert_awaited_once_with(sso)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("org", "detail"),
    [(None, "Organization not found"), (make_org(), "SSO config not found")],
)
async def test_delete_sso_config_404(portal_client, mock_db_session, org, detail):
    mock_db_session.execute.return_value = scalar_result(org)

    response = await portal_client.delete(f"/api/admin/organizations/{ORG_ID}/sso")

    assert response.status_code == 404
    assert response.json()["detail"] == detail
    mock_db_session.delete.assert_not_awaited()


# ---------------------------------------------------------------------------
# Tenant attach / detach
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_attach_tenant_with_group_rules(portal_client, mock_db_session):
    tenant = make_tenant(None)
    mock_db_session.execute.side_effect = [scalar_result(make_org()), scalar_result(tenant)]

    response = await portal_client.put(
        f"/api/admin/organizations/{ORG_ID}/tenants/{TENANT_ID}",
        json={"requiredGroupIds": ["g2", "g3"], "groupMembershipMode": "any"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "message": "Tenant 'Lab A' added to organization 'Contoso'",
        "tenant_had_own_sso": False,
    }
    assert tenant.organization_id == ORG_ID
    assert (tenant.required_group_ids, tenant.group_membership_mode) == (["g2", "g3"], "any")
    (log,) = audit_logs(mock_db_session)
    assert (log.action, log.actor) == ("organization_assigned", "portal@example.com")
    assert log.details == {"organization_id": str(ORG_ID), "organization_name": "Contoso"}
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_attach_tenant_reports_overridden_tenant_sso(portal_client, mock_db_session):
    tenant = make_tenant(None)
    mock_db_session.execute.side_effect = [
        scalar_result(make_org(sso=make_sso(enabled=1))),
        scalar_result(tenant),
    ]

    with patch(
        "app.routers.admin_organizations._tenant_has_own_sso_enabled",
        AsyncMock(return_value=True),
    ) as probe:
        response = await portal_client.put(f"/api/admin/organizations/{ORG_ID}/tenants/{TENANT_ID}")

    assert response.status_code == 200
    assert response.json()["tenant_had_own_sso"] is True
    probe.assert_awaited_once_with(tenant)
    assert tenant.required_group_ids == ["g1"]  # no body: group rules untouched


@pytest.mark.asyncio
async def test_attach_tenant_rejects_bad_membership_mode(portal_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(make_org()), scalar_result(make_tenant())]

    response = await portal_client.put(
        f"/api/admin/organizations/{ORG_ID}/tenants/{TENANT_ID}",
        json={"groupMembershipMode": "most"},
    )

    assert response.status_code == 400
    assert audit_logs(mock_db_session) == []
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("org", "tenant", "detail"),
    [(None, None, "Organization not found"), (make_org(), None, "Tenant not found")],
)
async def test_attach_tenant_404(portal_client, mock_db_session, org, tenant, detail):
    mock_db_session.execute.side_effect = [scalar_result(org), scalar_result(tenant)]

    response = await portal_client.put(f"/api/admin/organizations/{ORG_ID}/tenants/{TENANT_ID}")

    assert response.status_code == 404
    assert response.json()["detail"] == detail
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_detach_tenant_clears_org_and_groups(portal_client, mock_db_session):
    tenant = make_tenant(ORG_ID)
    mock_db_session.execute.return_value = scalar_result(tenant)

    response = await portal_client.delete(f"/api/admin/organizations/{ORG_ID}/tenants/{TENANT_ID}")

    assert response.status_code == 200
    assert (tenant.organization_id, tenant.required_group_ids, tenant.group_membership_mode) == (
        None,
        [],
        "any",
    )
    (log,) = audit_logs(mock_db_session)
    assert log.action == "organization_removed"
    assert log.details == {"organization_id": str(ORG_ID)}


@pytest.mark.asyncio
async def test_detach_tenant_of_other_org_400(portal_client, mock_db_session):
    tenant = make_tenant(uuid.uuid4())
    mock_db_session.execute.return_value = scalar_result(tenant)

    response = await portal_client.delete(f"/api/admin/organizations/{ORG_ID}/tenants/{TENANT_ID}")

    assert response.status_code == 400
    assert response.json()["detail"] == "Tenant is not in this organization"
    assert tenant.organization_id is not None
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_detach_unknown_tenant_404(portal_client, mock_db_session):
    mock_db_session.execute.return_value = scalar_result(None)

    response = await portal_client.delete(f"/api/admin/organizations/{ORG_ID}/tenants/{TENANT_ID}")

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Tenant group access PATCH
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_groups_moves_tenant_and_sets_rules(portal_client, mock_db_session):
    tenant = make_tenant(None)
    mock_db_session.execute.side_effect = [scalar_result(tenant), scalar_result(make_org())]

    response = await portal_client.patch(
        f"/api/admin/organizations/tenants/{TENANT_ID}/groups",
        json={
            "organizationId": str(ORG_ID),
            "requiredGroupIds": ["x"],
            "groupMembershipMode": "any",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "organization_id": str(ORG_ID),
        "required_group_ids": ["x"],
        "group_membership_mode": "any",
    }
    assert tenant.organization_id == ORG_ID
    mock_db_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_patch_groups_only_rules(portal_client, mock_db_session):
    tenant = make_tenant(None, required_group_ids=None)
    mock_db_session.execute.side_effect = [scalar_result(tenant)]

    response = await portal_client.patch(
        f"/api/admin/organizations/tenants/{TENANT_ID}/groups",
        json={"groupMembershipMode": "all"},
    )

    assert response.status_code == 200
    assert response.json()["organization_id"] is None
    assert response.json()["required_group_ids"] == []
    assert mock_db_session.execute.await_count == 1  # no org lookup


@pytest.mark.asyncio
async def test_patch_groups_unknown_org_404(portal_client, mock_db_session):
    tenant = make_tenant(None)
    mock_db_session.execute.side_effect = [scalar_result(tenant), scalar_result(None)]

    response = await portal_client.patch(
        f"/api/admin/organizations/tenants/{TENANT_ID}/groups",
        json={"organizationId": str(ORG_ID)},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Organization not found"
    assert tenant.organization_id is None
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_patch_groups_bad_mode_400(portal_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(make_tenant(None))]

    response = await portal_client.patch(
        f"/api/admin/organizations/tenants/{TENANT_ID}/groups",
        json={"groupMembershipMode": "some"},
    )

    assert response.status_code == 400
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_patch_groups_unknown_tenant_404(portal_client, mock_db_session):
    mock_db_session.execute.side_effect = [scalar_result(None)]

    response = await portal_client.patch(
        f"/api/admin/organizations/tenants/{TENANT_ID}/groups", json={"requiredGroupIds": []}
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Tenant not found"


@pytest.mark.asyncio
async def test_patch_groups_rejects_non_uuid_org(portal_client, mock_db_session):
    response = await portal_client.patch(
        f"/api/admin/organizations/tenants/{TENANT_ID}/groups",
        json={"organizationId": "not-a-uuid"},
    )

    assert response.status_code == 422
    mock_db_session.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# _tenant_has_own_sso_enabled (advisory probe of the tenant DB)
# ---------------------------------------------------------------------------


def _tenant_with_credentials(password="iv:tag:ct"):
    return SimpleNamespace(
        slug="lab-a",
        database_name="milestone_lab_a",
        database_user="lab_a",
        credentials=SimpleNamespace(encrypted_password=password) if password else None,
    )


def _manager(config=None, *, factory=True, error=None):
    tdb = AsyncMock()
    tdb.execute.return_value = scalar_result(config)
    session_cm = MagicMock()
    session_cm.__aenter__ = AsyncMock(return_value=tdb)
    session_cm.__aexit__ = AsyncMock(return_value=False)
    manager = MagicMock()
    manager.get_pool_from_info = AsyncMock(side_effect=error)
    manager.get_session_factory.return_value = (lambda: session_cm) if factory else None
    return manager


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("manager", "expected"),
    [
        (_manager(SimpleNamespace(enabled=1)), True),
        (_manager(SimpleNamespace(enabled=0)), False),
        (_manager(None), False),
        (_manager(factory=False), False),
        (_manager(error=RuntimeError("db down")), False),
    ],
)
async def test_tenant_has_own_sso_enabled(manager, expected):
    from app.routers.admin_organizations import _tenant_has_own_sso_enabled

    with patch("app.services.tenant_manager.tenant_connection_manager", manager):
        assert await _tenant_has_own_sso_enabled(_tenant_with_credentials()) is expected

    info = manager.get_pool_from_info.await_args.args[0]
    assert info == {
        "slug": "lab-a",
        "database_name": "milestone_lab_a",
        "database_user": "lab_a",
        "encrypted_password": "iv:tag:ct",
    }


@pytest.mark.asyncio
async def test_tenant_without_credentials_is_not_probed():
    from app.routers.admin_organizations import _tenant_has_own_sso_enabled

    manager = _manager(SimpleNamespace(enabled=1))
    with patch("app.services.tenant_manager.tenant_connection_manager", manager):
        assert await _tenant_has_own_sso_enabled(_tenant_with_credentials(None)) is False

    manager.get_pool_from_info.assert_not_awaited()
