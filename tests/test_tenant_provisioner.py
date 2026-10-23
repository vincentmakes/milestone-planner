"""
Tests for tenant database provisioning.

The provisioner seeds the tenant's admin user with a *hash* of the admin
password and returns the plaintext to the caller (the admin portal shows it
once). Those two must describe the same password, otherwise the newly
provisioned admin can never log in and the real password is unrecoverable.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.services.encryption import PasswordTooLongError, verify_user_password
from app.services.tenant_provisioner import provision_tenant_database


@pytest.fixture
def seeded_hash_capture():
    """
    Patch out every external effect of provisioning and capture the password
    hash that gets seeded into the tenant's users table.
    """
    captured: dict[str, str] = {}

    async def fake_run_seed_data(conn, admin_email, admin_password_hash):
        captured["hash"] = admin_password_hash

    with (
        patch(
            "app.services.tenant_provisioner.get_admin_connection",
            AsyncMock(return_value=AsyncMock()),
        ),
        patch("app.services.tenant_provisioner.asyncpg.connect", AsyncMock()),
        patch("app.services.tenant_provisioner.run_seed_data", fake_run_seed_data),
    ):
        yield captured


async def test_returned_admin_password_matches_the_seeded_hash(seeded_hash_capture):
    """A generated admin password must verify against the hash that was seeded."""
    result = await provision_tenant_database(
        tenant_id="t-1",
        database_name="milestone_acme",
        database_user="milestone_acme_user",
        database_password="db-secret",
        admin_email="admin@acme.com",
    )

    seeded = seeded_hash_capture["hash"]
    assert verify_user_password(result["admin_password"], seeded), (
        "the returned admin password does not match the hash seeded into the "
        "tenant database, so the new admin cannot log in"
    )


async def test_caller_supplied_admin_password_is_returned_unchanged(seeded_hash_capture):
    """An explicitly supplied admin password must be seeded and returned as-is."""
    result = await provision_tenant_database(
        tenant_id="t-2",
        database_name="milestone_acme",
        database_user="milestone_acme_user",
        database_password="db-secret",
        admin_email="admin@acme.com",
        admin_password="chosen-by-caller",
    )

    assert result["admin_password"] == "chosen-by-caller"
    assert verify_user_password("chosen-by-caller", seeded_hash_capture["hash"])


async def test_tenant_admin_is_seeded_with_a_bcrypt_hash(seeded_hash_capture):
    """Tenant users are bcrypt; the admin-portal PBKDF2 scheme must not leak in."""
    await provision_tenant_database(
        tenant_id="t-4",
        database_name="milestone_acme",
        database_user="milestone_acme_user",
        database_password="db-secret",
        admin_email="admin@acme.com",
        admin_password="chosen-by-caller",
    )

    assert seeded_hash_capture["hash"].startswith("$2b$12$")


async def test_over_long_admin_password_fails_before_touching_postgres():
    connect = AsyncMock()
    with (
        patch("app.services.tenant_provisioner.get_admin_connection", connect),
        pytest.raises(PasswordTooLongError),
    ):
        await provision_tenant_database(
            tenant_id="t-5",
            database_name="milestone_acme",
            database_user="milestone_acme_user",
            database_password="db-secret",
            admin_email="admin@acme.com",
            admin_password="x" * 73,
        )
    connect.assert_not_awaited()


async def test_provision_route_turns_an_over_long_admin_password_into_a_400():
    from app.routers.admin.tenants import provision_tenant
    from app.schemas.tenant import TenantProvisionRequest

    tenant = MagicMock(slug="acme", admin_email="admin@acme.com")
    db = MagicMock()
    db.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=tenant))
    )
    db.commit = AsyncMock()

    with (
        patch("app.routers.admin.tenants.decrypt", return_value="db-pass"),
        patch(
            "app.routers.admin.tenants.provision_tenant_database",
            AsyncMock(side_effect=PasswordTooLongError()),
        ),
        pytest.raises(HTTPException) as exc,
    ):
        await provision_tenant(
            "tenant-uuid",
            TenantProvisionRequest(admin_password="x" * 73),
            admin=MagicMock(email="portal@example.com"),
            db=db,
        )

    assert exc.value.status_code == 400
    assert "72" in exc.value.detail
    db.commit.assert_not_awaited()


async def test_returned_admin_password_is_not_the_postgres_admin_password(
    seeded_hash_capture,
):
    """Provisioning must never hand back the PostgreSQL admin credential."""
    with patch("app.services.tenant_provisioner.get_settings") as mock_settings:
        mock_settings.return_value.pg_admin_user = "postgres"
        mock_settings.return_value.pg_admin_password = "pg-superuser-secret"
        mock_settings.return_value.db_host = "localhost"
        mock_settings.return_value.db_port = 5432
        mock_settings.return_value.db_user = "milestone"
        mock_settings.return_value.db_password = "milestone-db-secret"

        result = await provision_tenant_database(
            tenant_id="t-3",
            database_name="milestone_acme",
            database_user="milestone_acme_user",
            database_password="db-secret",
            admin_email="admin@acme.com",
        )

    assert result["admin_password"] != "pg-superuser-secret"
    assert result["admin_password"] != "milestone-db-secret"


# ---------------------------------------------------------------------------
# "Seed demo data": the demo set replaces the bare defaults
# ---------------------------------------------------------------------------


@pytest.fixture
def seed_capture():
    """Patch both seeders and record which one provisioning picked."""
    calls: dict[str, object] = {}

    async def fake_run_seed_data(conn, admin_email, admin_password_hash):
        calls["default"] = (admin_email, admin_password_hash)

    async def fake_insert_demo_data(conn, demo, *, admin_password_hash=None):
        calls["demo"] = (demo, admin_password_hash)
        return {"sites": 2}

    with (
        patch(
            "app.services.tenant_provisioner.get_admin_connection",
            AsyncMock(return_value=AsyncMock()),
        ),
        patch("app.services.tenant_provisioner.asyncpg.connect", AsyncMock()),
        patch("app.services.tenant_provisioner.run_seed_data", fake_run_seed_data),
        patch("app.services.tenant_provisioner.insert_demo_data", fake_insert_demo_data),
    ):
        yield calls


async def test_seed_demo_data_loads_the_demo_set_with_the_tenant_admin(seed_capture):
    result = await provision_tenant_database(
        tenant_id="t-6",
        database_name="milestone_acme",
        database_user="milestone_acme_user",
        database_password="db-secret",
        admin_email="owner@acme.example",
        seed_demo_data=True,
        instance_title="Acme Labs",
    )

    assert "default" not in seed_capture, "the bare defaults (Main Site) must not be seeded too"
    demo, seeded_hash = seed_capture["demo"]
    assert demo.admin_email == "owner@acme.example"
    assert ("instance_title", "Acme Labs") in demo.settings
    assert [u["email"] for u in demo.users if u["is_system"]] == ["owner@acme.example"]
    assert verify_user_password(result["admin_password"], seeded_hash)
    assert result["seed_demo_data"] is True


async def test_seed_demo_data_defaults_the_title_when_none_is_given(seed_capture):
    await provision_tenant_database(
        tenant_id="t-7",
        database_name="milestone_acme",
        database_user="milestone_acme_user",
        database_password="db-secret",
        admin_email="owner@acme.example",
        admin_password="chosen-by-caller",
        seed_demo_data=True,
    )
    demo, seeded_hash = seed_capture["demo"]
    assert ("instance_title", "Demo Instance") in demo.settings
    assert verify_user_password("chosen-by-caller", seeded_hash)


async def test_without_the_flag_only_the_defaults_are_seeded(seed_capture):
    result = await provision_tenant_database(
        tenant_id="t-8",
        database_name="milestone_acme",
        database_user="milestone_acme_user",
        database_password="db-secret",
        admin_email="admin@acme.com",
    )
    assert "demo" not in seed_capture
    assert seed_capture["default"][0] == "admin@acme.com"
    assert result["seed_demo_data"] is False


def test_provision_request_accepts_the_flag_under_both_spellings():
    from app.schemas.tenant import TenantProvisionRequest

    assert TenantProvisionRequest().seed_demo_data is False
    assert TenantProvisionRequest(seedDemoData=True).seed_demo_data is True
    assert TenantProvisionRequest(seed_demo_data=True).seed_demo_data is True


async def test_provision_route_forwards_the_flag_and_audits_it():
    from app.routers.admin.tenants import provision_tenant
    from app.schemas.tenant import TenantProvisionRequest

    tenant = MagicMock(slug="acme", admin_email="admin@acme.com")
    tenant.name = "Acme Labs"  # `name=` would name the mock itself
    db = MagicMock()
    db.execute = AsyncMock(
        return_value=MagicMock(
            scalar_one_or_none=MagicMock(return_value=tenant),
            scalar_one=MagicMock(return_value=tenant),
        )
    )
    db.commit = AsyncMock()
    provision = AsyncMock(
        return_value={
            "admin_email": "admin@acme.com",
            "admin_password": "pw",
            "seed_demo_data": True,
        }
    )
    audit = AsyncMock()

    with (
        patch("app.routers.admin.tenants.decrypt", return_value="db-pass"),
        patch("app.routers.admin.tenants.provision_tenant_database", provision),
        patch("app.routers.admin.tenants.add_audit_log", audit),
        patch("app.routers.admin.tenants._reset_tenant_runtime_state", AsyncMock()),
    ):
        response = await provision_tenant(
            "tenant-uuid",
            TenantProvisionRequest(seedDemoData=True),
            admin=MagicMock(email="portal@example.com"),
            db=db,
        )

    assert provision.await_args.kwargs["seed_demo_data"] is True
    assert provision.await_args.kwargs["instance_title"] == "Acme Labs"
    assert audit.await_args.kwargs["details"] == {
        "admin_email": "admin@acme.com",
        "seed_demo_data": True,
    }
    assert response["adminPassword"] == "pw"
    assert tenant.status == "active"
    db.commit.assert_awaited_once()


async def test_provision_route_without_a_body_seeds_the_defaults():
    from app.routers.admin.tenants import provision_tenant

    tenant = MagicMock(slug="acme", admin_email="admin@acme.com")
    tenant.name = "Acme"
    db = MagicMock()
    db.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=tenant))
    )
    db.commit = AsyncMock()
    provision = AsyncMock(return_value={"admin_email": "admin@acme.com", "admin_password": "pw"})

    with (
        patch("app.routers.admin.tenants.decrypt", return_value="db-pass"),
        patch("app.routers.admin.tenants.provision_tenant_database", provision),
        patch("app.routers.admin.tenants.add_audit_log", AsyncMock()),
        patch("app.routers.admin.tenants._reset_tenant_runtime_state", AsyncMock()),
    ):
        await provision_tenant(
            "tenant-uuid", None, admin=MagicMock(email="portal@example.com"), db=db
        )

    assert provision.await_args.kwargs["seed_demo_data"] is False


async def test_seed_data_seeds_roles_and_policies_before_the_admin_user():
    """users.role references roles.key: the roles must exist before the admin row."""
    from app.services.tenant_provisioner import (
        RBAC_SEED_POLICIES_SQL,
        RBAC_SEED_ROLES_SQL,
        run_seed_data,
    )

    conn = AsyncMock()
    await run_seed_data(conn, "admin@acme.com", "$2b$12$hash")

    executed = [call.args[0] for call in conn.execute.await_args_list]
    admin = next(i for i, sql in enumerate(executed) if sql.startswith("INSERT INTO users"))
    assert executed.index(RBAC_SEED_ROLES_SQL) < admin
    assert executed.index(RBAC_SEED_POLICIES_SQL) < admin
    assert conn.execute.await_args_list[admin].args[1:] == ("admin@acme.com", "$2b$12$hash")


class _SeedConn:
    """asyncpg stand-in recording execute / fetchval in one ordered list."""

    def __init__(self, dashboard_id):
        self.dashboard_id = dashboard_id
        self.calls: list[tuple[str, tuple]] = []

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return "OK"

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        return self.dashboard_id

    def sql(self) -> list[str]:
        return [sql for sql, _ in self.calls]

    def args_of(self, sql: str) -> list[tuple]:
        return [args for s, args in self.calls if s == sql]


async def test_seed_data_seeds_the_base_dashboard_after_the_roles():
    """A new tenant gets the Overview (bound parameters, no JSON in the SQL)
    right after the RBAC seeds, then the (here no-op) dashboard grants."""
    from app.services.dashboard_seed import base_dashboard_rows
    from app.services.tenant_provisioner import (
        DASHBOARD_PERMISSION_BACKFILL_PG_SQL,
        DASHBOARD_SEED_PG_SQL,
        DASHBOARD_WIDGET_SEED_PG_SQL,
        RBAC_SEED_POLICIES_SQL,
        RBAC_SEED_ROLES_SQL,
        run_seed_data,
    )

    conn = _SeedConn(dashboard_id=5)
    await run_seed_data(conn, "admin@acme.com", "$2b$12$hash")

    sql = conn.sql()
    dashboard_at = sql.index(DASHBOARD_SEED_PG_SQL)
    assert sql.index(RBAC_SEED_ROLES_SQL) < dashboard_at
    assert sql.index(RBAC_SEED_POLICIES_SQL) < dashboard_at
    dashboard, widgets = base_dashboard_rows()
    ((name, description, visibility, is_default, created, updated),) = conn.args_of(
        DASHBOARD_SEED_PG_SQL
    )
    assert (name, description, visibility, is_default) == tuple(dashboard.values())
    assert created == updated and created.tzinfo is None
    assert conn.args_of(DASHBOARD_WIDGET_SEED_PG_SQL) == [
        (5, w["kind"], w["title"], w["query"], w["options"], w["layout"], w["sort_order"])
        for w in widgets
    ]
    assert conn.args_of(DASHBOARD_PERMISSION_BACKFILL_PG_SQL) == [
        ("views.dashboards", "superuser", "views.dashboards"),
        ("views.dashboards", "user", "views.dashboards"),
        ("dashboards.manage", "superuser", "dashboards.manage"),
    ]
    # Widgets after their dashboard, grants after the widgets.
    assert sql.index(DASHBOARD_WIDGET_SEED_PG_SQL) > dashboard_at
    assert sql.index(DASHBOARD_PERMISSION_BACKFILL_PG_SQL) > max(
        i for i, s in enumerate(sql) if s == DASHBOARD_WIDGET_SEED_PG_SQL
    )
    # No JSON literal inside any statement text.
    for statement in sql:
        assert '{"' not in statement


async def test_seed_data_skips_the_widgets_when_a_default_dashboard_exists():
    from app.services.tenant_provisioner import (
        DASHBOARD_PERMISSION_BACKFILL_PG_SQL,
        DASHBOARD_SEED_PG_SQL,
        DASHBOARD_WIDGET_SEED_PG_SQL,
        run_seed_data,
    )

    conn = _SeedConn(dashboard_id=None)  # ON CONFLICT DO NOTHING: no id back
    await run_seed_data(conn, "admin@acme.com", "$2b$12$hash")

    assert len(conn.args_of(DASHBOARD_SEED_PG_SQL)) == 1
    assert conn.args_of(DASHBOARD_WIDGET_SEED_PG_SQL) == []
    assert len(conn.args_of(DASHBOARD_PERMISSION_BACKFILL_PG_SQL)) == 3


async def test_seed_data_without_dashboards_writes_none():
    """init_db on a database that already has the dashboards tables."""
    from app.services.tenant_provisioner import (
        DASHBOARD_PERMISSION_BACKFILL_PG_SQL,
        DASHBOARD_SEED_PG_SQL,
        DASHBOARD_WIDGET_SEED_PG_SQL,
        run_seed_data,
    )

    conn = _SeedConn(dashboard_id=5)
    await run_seed_data(conn, "admin@acme.com", "$2b$12$hash", seed_dashboards=False)

    for sql in (
        DASHBOARD_SEED_PG_SQL,
        DASHBOARD_WIDGET_SEED_PG_SQL,
        DASHBOARD_PERMISSION_BACKFILL_PG_SQL,
    ):
        assert sql not in conn.sql()
    assert any(s.startswith("INSERT INTO users") for s in conn.sql())


async def test_provisioning_runs_the_default_seed_with_its_dashboards(seed_capture):
    """A new tenant without demo data goes through run_seed_data (which seeds
    the Overview); with demo data, insert_demo_data seeds it instead."""
    await provision_tenant_database(
        tenant_id="t-9",
        database_name="milestone_acme",
        database_user="milestone_acme_user",
        database_password="db-secret",
        admin_email="admin@acme.com",
    )
    assert "default" in seed_capture and "demo" not in seed_capture
