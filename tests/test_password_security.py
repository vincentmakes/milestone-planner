"""
Password-handling security fixes.

- B1-2: the admin portal's tenant admin password reset stores a bcrypt hash,
  never the plaintext; legacy plaintext comparison survives non-ASCII values.
- B1-3: bcrypt's 72-byte limit never surfaces as a 500 (bcrypt 5.x raises).
- change-password loads the real user row (the session snapshot has no hash)
  and ends the user's other sessions.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.user import User
from app.services.encryption import (
    PASSWORD_TOO_LONG_MESSAGE,
    PasswordTooLongError,
    hash_password,
    hash_user_password,
    verify_password,
    verify_user_password,
)
from app.services.session import SessionService
from tests.conftest import FakeUser

# ---------------------------------------------------------------------------
# encryption helpers
# ---------------------------------------------------------------------------


def test_hash_rejects_passwords_over_72_bytes():
    with pytest.raises(PasswordTooLongError) as exc:
        hash_user_password("x" * 73)
    assert isinstance(exc.value, ValueError)
    assert str(exc.value) == PASSWORD_TOO_LONG_MESSAGE


def test_hash_limit_counts_bytes_not_characters():
    # 37 two-byte characters = 74 bytes
    with pytest.raises(PasswordTooLongError):
        hash_user_password("é" * 37)


def test_hash_accepts_exactly_72_bytes():
    hashed = hash_user_password("y" * 72)
    assert verify_user_password("y" * 72, hashed)


def test_verify_returns_false_for_over_long_password():
    hashed = hash_user_password("short-pass")
    assert verify_user_password("z" * 200, hashed) is False
    # The admin-portal verifier has a bcrypt branch too
    assert verify_password("z" * 200, hashed) is False


def test_verify_returns_false_for_malformed_bcrypt_hash():
    assert verify_user_password("whatever", "$2b$12$not-a-real-hash") is False


def test_legacy_plaintext_non_ascii_compares_without_exception():
    assert verify_user_password("pässwörd", "pässwörd") is True
    assert verify_user_password("password", "pässwörd") is False
    assert verify_user_password("pässwörd", "password") is False


def test_admin_pbkdf2_unaffected():
    stored = hash_password("x" * 100)  # PBKDF2 has no 72-byte limit
    assert verify_password("x" * 100, stored) is True


# ---------------------------------------------------------------------------
# Login / change-password routes
# ---------------------------------------------------------------------------


def orm_user(password_hash: str) -> User:
    user = User(
        id=7,
        email="u7@example.com",
        password=password_hash,
        first_name="A",
        last_name="B",
        role="user",
        max_capacity=100,
        active=1,
        is_system=0,
    )
    user.sites = []
    return user


@pytest.mark.asyncio
async def test_login_with_over_long_password_is_401_not_500(app_client, mock_db_session):
    result = MagicMock()
    result.scalar_one_or_none.return_value = orm_user(hash_user_password("real-pass"))
    mock_db_session.execute.return_value = result

    resp = await app_client.post(
        "/api/auth/login", json={"email": "u7@example.com", "password": "p" * 100}
    )

    assert resp.status_code == 401
    assert "Invalid" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_change_password_hashes_and_ends_other_sessions(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))
    user = orm_user(hash_user_password("old-pass"))
    result = MagicMock()
    result.scalar_one_or_none.return_value = user
    mock_db_session.execute.return_value = result

    with patch.object(SessionService, "destroy_user_sessions", new_callable=AsyncMock) as destroy:
        resp = await client.post(
            "/api/auth/change-password",
            json={"currentPassword": "old-pass", "newPassword": "new-pass-123"},
            cookies={"connect.sid": "s%3Amy-sid."},
        )

    assert resp.status_code == 200
    assert verify_user_password("new-pass-123", user.password)
    destroy.assert_awaited_once_with(7, except_session_id="my-sid", commit=False)
    mock_db_session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_change_password_over_72_bytes_is_400(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))
    user = orm_user(hash_user_password("old-pass"))
    result = MagicMock()
    result.scalar_one_or_none.return_value = user
    mock_db_session.execute.return_value = result

    resp = await client.post(
        "/api/auth/change-password",
        json={"currentPassword": "old-pass", "newPassword": "n" * 80},
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == PASSWORD_TOO_LONG_MESSAGE
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_change_password_wrong_current_password_is_400_not_401(
    authed_client, mock_db_session
):
    """A typo in the current password must not look like an expired session:
    the frontend logs the user out on any 401 from the tenant API."""
    client, set_user = authed_client
    set_user(FakeUser(7, "user"))
    user = orm_user(hash_user_password("old-pass"))
    original_hash = user.password
    result = MagicMock()
    result.scalar_one_or_none.return_value = user
    mock_db_session.execute.return_value = result

    resp = await client.post(
        "/api/auth/change-password",
        json={"currentPassword": "not-the-old-pass", "newPassword": "new-pass-123"},
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Current password is incorrect"
    assert user.password == original_hash
    mock_db_session.commit.assert_not_awaited()


# ---------------------------------------------------------------------------
# Admin portal: reset tenant admin password (B1-2)
# ---------------------------------------------------------------------------


def _tenant():
    tenant = MagicMock()
    tenant.id = "tenant-uuid"
    tenant.database_name = "milestone_acme"
    tenant.database_user = "acme_user"
    tenant.admin_email = "admin@acme.test"
    tenant.credentials.encrypted_password = "iv:tag:cipher"
    return tenant


async def _run_reset(password: str | None, conn: MagicMock):
    from app.routers.admin.tenants import reset_tenant_admin_password
    from app.schemas.tenant import ResetAdminPasswordRequest

    db = MagicMock()
    db.execute = AsyncMock(
        return_value=MagicMock(scalar_one_or_none=MagicMock(return_value=_tenant()))
    )
    db.commit = AsyncMock()

    with (
        patch("app.routers.admin.tenants.decrypt", return_value="db-pass"),
        patch(
            "app.routers.admin.tenants.check_tenant_database",
            AsyncMock(return_value={"accessible": True}),
        ),
        patch("app.routers.admin.tenants.add_audit_log", AsyncMock()),
        patch("asyncpg.connect", AsyncMock(return_value=conn)),
    ):
        return await reset_tenant_admin_password(
            "tenant-uuid",
            ResetAdminPasswordRequest(password=password) if password else None,
            admin=MagicMock(email="portal@example.com"),
            db=db,
        )


def _conn():
    conn = MagicMock()
    conn.execute = AsyncMock(return_value="UPDATE 1")
    conn.fetchrow = AsyncMock(return_value={"id": 3})
    conn.fetch = AsyncMock(
        return_value=[
            {"sid": "s-admin", "sess": json.dumps({"user": {"id": 3}})},
            {"sid": "s-other", "sess": json.dumps({"user": {"id": 33}})},
        ]
    )
    conn.close = AsyncMock()
    return conn


@pytest.mark.asyncio
async def test_reset_admin_password_stores_bcrypt_hash():
    conn = _conn()
    result = await _run_reset("Fresh-Pässword-1", conn)

    update_call = conn.execute.await_args_list[0]
    stored = update_call.args[1]
    assert stored != "Fresh-Pässword-1"
    assert stored.startswith("$2")
    assert verify_user_password("Fresh-Pässword-1", stored)
    # The plaintext is only handed back once, to the portal admin
    assert result["password"] == "Fresh-Pässword-1"
    conn.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_reset_admin_password_generated_is_hashed_and_sessions_ended():
    conn = _conn()
    result = await _run_reset(None, conn)

    stored = conn.execute.await_args_list[0].args[1]
    assert verify_user_password(result["password"], stored)
    delete_call = conn.execute.await_args_list[-1]
    assert "DELETE FROM sessions" in delete_call.args[0]
    assert delete_call.args[1] == ["s-admin"]


@pytest.mark.asyncio
async def test_reset_admin_password_over_72_bytes_is_400():
    from fastapi import HTTPException

    conn = _conn()
    with pytest.raises(HTTPException) as exc:
        await _run_reset("q" * 90, conn)
    assert exc.value.status_code == 400
    conn.execute.assert_not_awaited()
