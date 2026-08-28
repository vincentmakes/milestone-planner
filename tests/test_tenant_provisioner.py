"""
Tests for tenant database provisioning.

The provisioner seeds the tenant's admin user with a *hash* of the admin
password and returns the plaintext to the caller (the admin portal shows it
once). Those two must describe the same password, otherwise the newly
provisioned admin can never log in and the real password is unrecoverable.
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.services.encryption import verify_password
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
    assert verify_password(result["admin_password"], seeded), (
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
    assert verify_password("chosen-by-caller", seeded_hash_capture["hash"])


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
