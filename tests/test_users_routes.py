"""
Route tests for /api/users — the superuser/admin permission matrix (B2-1) and
session revocation on privilege changes (B1-1).

A superuser may edit plain users' basic fields, but may not touch an admin
account at all, may not change anyone else's email or password, and may not
change roles or active status. Admins keep full rights (minus the is_system
protections). Role changes, deactivation, deletion and password changes end the
target's existing sessions.
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.user import User
from app.services.encryption import verify_user_password
from app.services.session import SessionService
from tests.conftest import FakeUser


def make_user(user_id: int, role: str = "user", *, is_system: int = 0, active: int = 1) -> User:
    user = User(
        id=user_id,
        email=f"u{user_id}@example.com",
        password="$2b$12$existinghashexistinghashexistinghashexistinghashexist",
        first_name="First",
        last_name=f"Last{user_id}",
        job_title="Engineer",
        role=role,
        max_capacity=100,
        active=active,
        is_system=is_system,
        created_at=datetime(2026, 1, 1),
    )
    user.sites = []
    user.skills = []
    return user


def route_db(mock_db_session, target: User | None) -> None:
    """Every select returns ``target``; the duplicate-email check finds nobody."""
    result = MagicMock()
    result.unique.return_value.scalar_one_or_none.return_value = target
    result.scalar_one_or_none.return_value = None
    mock_db_session.execute = AsyncMock(return_value=result)


def lookup_db(mock_db_session, target: User | None) -> None:
    """For handlers that read the user with a plain scalar_one_or_none()."""
    result = MagicMock()
    result.scalar_one_or_none.return_value = target
    mock_db_session.execute = AsyncMock(return_value=result)
    mock_db_session.delete = AsyncMock()


@pytest.fixture
def destroy_sessions():
    with patch.object(SessionService, "destroy_user_sessions", new_callable=AsyncMock) as mock:
        mock.return_value = 0
        yield mock


# ---------------------------------------------------------------------------
# B2-1 — superuser restrictions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_superuser_cannot_edit_admin(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    route_db(mock_db_session, make_user(1, "admin"))

    resp = await client.put("/api/users/1", json={"first_name": "Renamed"})

    assert resp.status_code == 403
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_cannot_reset_system_admin_password(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    admin = make_user(1, "admin", is_system=1)
    original = admin.password
    route_db(mock_db_session, admin)

    resp = await client.put("/api/users/1", json={"password": "pwned123"})

    assert resp.status_code == 403
    assert admin.password == original
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_cannot_set_another_users_password(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    target = make_user(7, "user")
    original = target.password
    route_db(mock_db_session, target)

    resp = await client.put("/api/users/7", json={"password": "newpass123"})

    assert resp.status_code == 403
    assert target.password == original
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_cannot_change_another_users_email(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    target = make_user(7, "user")
    route_db(mock_db_session, target)

    resp = await client.put("/api/users/7", json={"email": "attacker@example.com"})

    assert resp.status_code == 403
    assert target.email == "u7@example.com"
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_can_edit_basic_fields_of_plain_user(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    target = make_user(7, "user")
    route_db(mock_db_session, target)

    # The settings form re-sends the unchanged email; that is not a change.
    resp = await client.put(
        "/api/users/7",
        json={
            "first_name": "Alice",
            "job_title": "Lab lead",
            "email": "U7@example.com",
        },
    )

    assert resp.status_code == 200
    assert target.first_name == "Alice"
    assert target.job_title == "Lab lead"
    assert target.email == "u7@example.com"  # re-sent email is a no-op
    mock_db_session.commit.assert_awaited()
    destroy_sessions.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_can_change_own_email(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    me = make_user(5, "superuser")
    route_db(mock_db_session, me)

    resp = await client.put("/api/users/5", json={"email": "new-me@example.com"})

    assert resp.status_code == 200
    assert me.email == "new-me@example.com"


@pytest.mark.asyncio
async def test_superuser_cannot_elevate_role(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    route_db(mock_db_session, make_user(7, "user"))

    resp = await client.put("/api/users/7", json={"role": "admin"})

    assert resp.status_code == 403
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_superuser_cannot_deactivate(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    route_db(mock_db_session, make_user(7, "user"))

    resp = await client.put("/api/users/7", json={"active": 0})
    assert resp.status_code == 403

    # toggle-active and delete are admin-only
    assert (await client.put("/api/users/7/toggle-active")).status_code == 403
    assert (await client.delete("/api/users/7")).status_code == 403
    assert (await client.post("/api/users", json={})).status_code in (403, 422)


# ---------------------------------------------------------------------------
# Admin rights + session revocation (B1-1)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_admin_sets_password_hashed_and_sessions_destroyed(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7, "user")
    route_db(mock_db_session, target)

    resp = await client.put("/api/users/7", json={"password": "brand-new-pass"})

    assert resp.status_code == 200
    assert target.password.startswith("$2")
    assert verify_user_password("brand-new-pass", target.password)
    destroy_sessions.assert_awaited_once_with(7, except_session_id=None, commit=False)


@pytest.mark.asyncio
async def test_password_over_72_bytes_is_400(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    route_db(mock_db_session, make_user(7, "user"))

    resp = await client.put("/api/users/7", json={"password": "x" * 73})

    assert resp.status_code == 400
    assert "72 bytes" in resp.json()["detail"]
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_admin_role_change_destroys_sessions(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7, "admin")
    route_db(mock_db_session, target)

    resp = await client.put("/api/users/7", json={"role": "user"})

    assert resp.status_code == 200
    assert target.role == "user"
    destroy_sessions.assert_awaited_once_with(7, except_session_id=None, commit=False)


@pytest.mark.asyncio
async def test_admin_deactivate_via_put_destroys_sessions(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    route_db(mock_db_session, make_user(7, "user"))

    resp = await client.put("/api/users/7", json={"active": 0})

    assert resp.status_code == 200
    destroy_sessions.assert_awaited_once()


@pytest.mark.asyncio
async def test_unchanged_role_does_not_destroy_sessions(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    route_db(mock_db_session, make_user(7, "user"))

    resp = await client.put("/api/users/7", json={"role": "user", "last_name": "New"})

    assert resp.status_code == 200
    destroy_sessions.assert_not_awaited()


@pytest.mark.asyncio
async def test_toggle_active_off_destroys_sessions(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7, "user", active=1)
    lookup_db(mock_db_session, target)

    resp = await client.put("/api/users/7/toggle-active")

    assert resp.status_code == 200
    assert target.active == 0
    destroy_sessions.assert_awaited_once_with(7, commit=False)


@pytest.mark.asyncio
async def test_toggle_active_on_keeps_sessions(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7, "user", active=0)
    lookup_db(mock_db_session, target)

    resp = await client.put("/api/users/7/toggle-active")

    assert resp.status_code == 200
    assert target.active == 1
    destroy_sessions.assert_not_awaited()


@pytest.mark.asyncio
async def test_toggle_active_refuses_system_admin(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    lookup_db(mock_db_session, make_user(2, "admin", is_system=1))

    resp = await client.put("/api/users/2/toggle-active")

    assert resp.status_code == 403
    mock_db_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_user_destroys_sessions(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(1, "admin"))
    target = make_user(7, "user")
    lookup_db(mock_db_session, target)

    resp = await client.delete("/api/users/7")

    assert resp.status_code == 200
    destroy_sessions.assert_awaited_once_with(7, commit=False)
    mock_db_session.delete.assert_awaited_once_with(target)
