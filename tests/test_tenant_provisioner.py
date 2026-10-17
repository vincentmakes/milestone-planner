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
