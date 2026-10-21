"""
Tenant-level SSO client secret encrypted at rest (B1-5) and the masked-secret
convention on every SSO write route (B1-20).
"""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.settings import SSOConfig
from app.services.encryption import encrypt
from app.services.sso import (
    SSOService,
    apply_secret_update,
    is_encrypted_secret,
    mask_secret,
    read_tenant_client_secret,
    store_tenant_client_secret,
)
from tests.conftest import FakeUser

SECRET = "entra~client~secret~VALUE1234"


def sso_row(**overrides) -> SSOConfig:
    row = SSOConfig(
        id=1,
        enabled=1,
        tenant_id="entra-tenant",
        client_id="client-id",
        client_secret=None,
        redirect_uri="https://example.test/api/auth/sso/callback",
        auto_create_users=0,
        default_role="user",
    )
    for key, value in overrides.items():
        setattr(row, key, value)
    return row


def returning(row):
    result = MagicMock()
    result.scalar_one_or_none.return_value = row
    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def test_encrypt_output_is_recognised_and_plaintext_is_not():
    assert is_encrypted_secret(encrypt(SECRET))
    assert not is_encrypted_secret(SECRET)
    assert not is_encrypted_secret("abc:def:123")
    assert not is_encrypted_secret(None)
    assert not is_encrypted_secret("")


def test_store_then_read_round_trips_and_is_not_plaintext():
    row = sso_row()
    store_tenant_client_secret(row, SECRET)

    assert row.client_secret != SECRET
    assert SECRET not in row.client_secret
    assert is_encrypted_secret(row.client_secret)
    assert len(row.client_secret) <= 500  # fits VARCHAR(500)
    assert read_tenant_client_secret(row) == SECRET


def test_store_fits_the_column_at_the_schema_limit():
    row = sso_row()
    store_tenant_client_secret(row, "s" * 200)  # SSOConfigUpdate max_length
    assert len(row.client_secret) <= 500


def test_legacy_plaintext_is_still_readable():
    assert read_tenant_client_secret(sso_row(client_secret=SECRET)) == SECRET


def test_undecryptable_secret_reads_as_none_not_500():
    row = sso_row(client_secret=encrypt(SECRET))
    with patch("app.services.sso.decrypt", side_effect=ValueError("wrong key")):
        assert read_tenant_client_secret(row) is None


@pytest.mark.parametrize("submitted", [None, "****1234", "****"])
def test_apply_secret_update_keeps_the_stored_secret(submitted):
    stored = encrypt(SECRET)
    row = sso_row(client_secret=stored)
    assert apply_secret_update(row, submitted) is False
    assert row.client_secret == stored


def test_apply_secret_update_replaces_and_encrypts():
    row = sso_row(client_secret=encrypt("old-secret"))
    assert apply_secret_update(row, SECRET) is True
    assert is_encrypted_secret(row.client_secret)
    assert read_tenant_client_secret(row) == SECRET


def test_apply_secret_update_empty_string_clears():
    row = sso_row(client_secret=encrypt(SECRET))
    assert apply_secret_update(row, "") is True
    assert row.client_secret == ""
    assert read_tenant_client_secret(row) is None


def test_mask_secret():
    assert mask_secret(SECRET) == "****1234"
    assert mask_secret(None) is None
    assert mask_secret("") is None


# ---------------------------------------------------------------------------
# get_effective_sso_config: decrypt on read, lazy upgrade
# ---------------------------------------------------------------------------


def service_for(row) -> tuple[SSOService, MagicMock]:
    db = MagicMock()
    db.execute = AsyncMock(return_value=returning(row))
    db.commit = AsyncMock()
    db.rollback = AsyncMock()
    svc = SSOService(db)
    svc.settings = MagicMock(multi_tenant=False)
    return svc, db


@pytest.mark.asyncio
async def test_effective_config_decrypts_the_stored_secret():
    row = sso_row(client_secret=encrypt(SECRET))
    svc, db = service_for(row)

    config, source = await svc.get_effective_sso_config(None)

    assert source == "tenant"
    assert config["client_secret"] == SECRET
    db.commit.assert_not_awaited()  # nothing to upgrade


@pytest.mark.asyncio
async def test_effective_config_upgrades_a_legacy_plaintext_secret():
    row = sso_row(client_secret=SECRET)
    svc, db = service_for(row)

    config, source = await svc.get_effective_sso_config(None)

    assert config["client_secret"] == SECRET
    assert is_encrypted_secret(row.client_secret)
    assert read_tenant_client_secret(row) == SECRET
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_effective_config_survives_a_failed_upgrade_commit():
    row = sso_row(client_secret=SECRET)
    svc, db = service_for(row)
    db.commit = AsyncMock(side_effect=RuntimeError("read-only replica"))

    config, source = await svc.get_effective_sso_config(None)

    assert source == "tenant"
    assert config["client_secret"] == SECRET
    db.rollback.assert_awaited()


@pytest.mark.asyncio
async def test_effective_config_with_undecryptable_secret_is_not_configured():
    row = sso_row(client_secret=encrypt(SECRET))
    svc, _ = service_for(row)

    with patch("app.services.sso.decrypt", side_effect=ValueError("wrong key")):
        config, source = await svc.get_effective_sso_config(None)

    assert (config, source) == (None, "none")


# ---------------------------------------------------------------------------
# The three write routes and GET /sso/config/full
# ---------------------------------------------------------------------------

WRITE_ROUTES = ["/api/sso/config", "/api/auth/sso/config", "/api/settings/sso"]


@pytest.mark.asyncio
@pytest.mark.parametrize("path", WRITE_ROUTES)
async def test_write_route_stores_the_secret_encrypted(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = sso_row()
    mock_db_session.execute.return_value = returning(row)

    resp = await client.put(path, json={"client_secret": SECRET, "enabled": False})

    assert resp.status_code == 200, resp.text
    assert is_encrypted_secret(row.client_secret)
    assert read_tenant_client_secret(row) == SECRET
    assert SECRET not in resp.text


@pytest.mark.asyncio
@pytest.mark.parametrize("path", WRITE_ROUTES)
async def test_write_route_keeps_secret_on_masked_echo(authed_client, mock_db_session, path):
    """Echoing client_secret_masked back must not overwrite the real secret."""
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    stored = encrypt(SECRET)
    row = sso_row(client_secret=stored)
    mock_db_session.execute.return_value = returning(row)

    resp = await client.put(path, json={"client_secret": mask_secret(SECRET), "enabled": False})

    assert resp.status_code == 200, resp.text
    assert row.client_secret == stored
    assert read_tenant_client_secret(row) == SECRET


@pytest.mark.asyncio
async def test_write_route_rejects_an_oversized_secret(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    mock_db_session.execute.return_value = returning(sso_row())

    resp = await client.put("/api/sso/config", json={"client_secret": "x" * 201})

    assert resp.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("stored", [SECRET, "ENCRYPTED"])
async def test_full_config_returns_the_secret_masked_only(authed_client, mock_db_session, stored):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    stored_value = encrypt(SECRET) if stored == "ENCRYPTED" else stored
    mock_db_session.execute.return_value = returning(sso_row(client_secret=stored_value))

    resp = await client.get("/api/sso/config/full")

    assert resp.status_code == 200
    body = resp.json()
    assert "client_secret" not in body
    assert body["client_secret_masked"] == "****1234"
    assert SECRET not in resp.text
    assert stored_value not in resp.text


# ---------------------------------------------------------------------------
# In-process auto-migration step
# ---------------------------------------------------------------------------


def migration_conn(stored):
    """A fake AsyncConnection: to_regclass, then SELECT client_secret, then UPDATE."""
    conn = MagicMock()
    exists = MagicMock()
    exists.scalar.return_value = "sso_config"
    current = MagicMock()
    current.scalar.return_value = stored
    conn.execute = AsyncMock(side_effect=[exists, current, MagicMock()])
    conn.commit = AsyncMock()
    conn.rollback = AsyncMock()
    return conn


@pytest.mark.asyncio
async def test_auto_migration_encrypts_a_plaintext_secret():
    from app.services.tenant_manager import encrypt_tenant_sso_secret

    conn = migration_conn(SECRET)
    assert await encrypt_tenant_sso_secret(conn, "acme") is True

    update = conn.execute.await_args_list[2]
    assert "UPDATE sso_config" in str(update.args[0])
    params = update.args[1]
    assert params["old"] == SECRET
    assert is_encrypted_secret(params["new"])
    conn.commit.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("stored", [None, "", "ENCRYPTED"])
async def test_auto_migration_is_idempotent(stored):
    from app.services.tenant_manager import encrypt_tenant_sso_secret

    conn = migration_conn(encrypt(SECRET) if stored == "ENCRYPTED" else stored)
    assert await encrypt_tenant_sso_secret(conn, "acme") is False
    assert conn.execute.await_count == 2  # no UPDATE
    conn.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_auto_migration_skips_a_database_without_sso_config():
    from app.services.tenant_manager import encrypt_tenant_sso_secret

    conn = MagicMock()
    missing = MagicMock()
    missing.scalar.return_value = None
    conn.execute = AsyncMock(return_value=missing)
    assert await encrypt_tenant_sso_secret(conn, "acme") is False
    assert conn.execute.await_count == 1


@pytest.mark.asyncio
async def test_auto_migration_never_raises():
    from app.services.tenant_manager import encrypt_tenant_sso_secret

    conn = MagicMock()
    conn.execute = AsyncMock(side_effect=RuntimeError("boom"))
    conn.rollback = AsyncMock()
    assert await encrypt_tenant_sso_secret(conn, "acme") is False
    conn.rollback.assert_awaited()


@pytest.mark.asyncio
async def test_single_tenant_auto_migrations_reach_the_secret_step_and_data_hook():
    """run_single_tenant_auto_migrations -> _run_auto_migrations -> both new steps."""
    from app.services import tenant_manager

    conn = MagicMock()
    conn.execute = AsyncMock(side_effect=RuntimeError("every built-in step fails"))
    conn.commit = AsyncMock()
    conn.rollback = AsyncMock()

    @asynccontextmanager
    async def connect():
        yield conn

    engine = MagicMock()
    engine.connect = connect

    with (
        patch.object(tenant_manager, "encrypt_tenant_sso_secret", AsyncMock()) as secret_step,
        patch(
            "app.services.tenant_data_migrations.run_data_migrations",
            AsyncMock(side_effect=RuntimeError("hook failure is contained")),
        ) as hook,
    ):
        await tenant_manager.run_single_tenant_auto_migrations(engine)

    secret_step.assert_awaited_once_with(conn, "single-tenant")
    hook.assert_awaited_once_with(conn)


# ---------------------------------------------------------------------------
# The SSO default role on every write route: an existing non-admin role key
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("path", WRITE_ROUTES)
@pytest.mark.parametrize(("found", "status"), [("team_lead", 200), (None, 400)])
async def test_write_route_checks_a_custom_default_role(
    authed_client, mock_db_session, path, found, status
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    row = sso_row()
    role_lookup = MagicMock()
    role_lookup.scalar_one_or_none.return_value = found
    mock_db_session.execute = AsyncMock(side_effect=[returning(row), role_lookup])

    resp = await client.put(path, json={"default_role": "team_lead"})

    assert resp.status_code == status, resp.text
    assert row.default_role == ("team_lead" if found else "user")
