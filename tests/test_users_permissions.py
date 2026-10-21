"""
/api/users on permission keys (RBAC Task 3), and app/services/user_access.py.

Each kind of change needs its key (``users.edit``, ``users.edit_admins``,
``users.edit_credentials``, ``users.change_role``, ``users.toggle_active``,
``users.create``, ``users.delete``). Two guards hold for everyone:

- escalation: a caller assigns only roles whose permissions they hold
  themselves (the admin role: admins only), and changes the role only of users
  whose current role they could have assigned;
- the last active administrator is never demoted, deactivated or deleted.
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.user import User
from app.services.permissions import PermissionSet, default_modes
from app.services.session import SessionService
from app.services.user_access import (
    ASSIGN_ADMIN_DETAIL,
    LAST_ADMIN_DETAIL,
    ROLE_CHANGE_OF_STRONGER_DETAIL,
    ROLE_ESCALATION_DETAIL,
    role_within,
)
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result

STAMP = datetime(2026, 1, 1, 12, 0, 0)

# An HR role: the user defaults plus account management, but no project keys.
HR = {
    **default_modes("user"),
    "users.view": "allow",
    "users.edit": "allow",
    "users.change_role": "allow",
    "users.toggle_active": "allow",
    "users.create": "allow",
    "users.delete": "allow",
}


def make_user(user_id: int, role: str = "user", *, active: int = 1, is_system: int = 0) -> User:
    user = User(
        id=user_id,
        email=f"u{user_id}@example.com",
        password="$2b$12$existinghashexistinghashexistinghashexistinghashexist",
        first_name="First",
        last_name=f"Last{user_id}",
        role=role,
        max_capacity=100,
        active=active,
        is_system=is_system,
        created_at=STAMP,
    )
    user.sites = []
    user.skills = []
    user.teams = []
    return user


def lookup(target: User) -> MagicMock:
    result = MagicMock()
    result.unique.return_value.scalar_one_or_none.return_value = target
    result.scalar_one_or_none.return_value = target
    return result


@pytest.fixture
def destroy_sessions():
    with patch.object(SessionService, "destroy_user_sessions", new_callable=AsyncMock) as mock:
        mock.return_value = 0
        yield mock


@pytest.fixture
def role_sets():
    """``load_permission_set`` answering every role from the catalogue defaults."""

    async def load(_db, role_key):
        return PermissionSet(role_key, default_modes(role_key))

    with patch("app.services.user_access.load_permission_set", side_effect=load) as mock:
        yield mock


# ---------------------------------------------------------------------------
# role_within
# ---------------------------------------------------------------------------


def test_role_within_compares_modes():
    holder = PermissionSet("hr", HR)
    assert role_within(PermissionSet("user", default_modes("user")), holder)
    assert not role_within(PermissionSet("superuser", default_modes("superuser")), holder)
    assert not role_within(PermissionSet("admin", {}), holder)
    assert role_within(
        PermissionSet("superuser", default_modes("superuser")), PermissionSet("admin")
    )


def test_role_within_approval_needs_some_mode_and_allow_needs_allow():
    approving = PermissionSet("x", {"assignments.self_create": "approval"})
    allowing = PermissionSet("y", {"assignments.self_create": "allow"})
    assert role_within(approving, allowing)
    assert not role_within(allowing, approving)
    assert not role_within(approving, PermissionSet("z", {}))


# ---------------------------------------------------------------------------
# Role changes: key + escalation guard
# ---------------------------------------------------------------------------


async def test_a_role_within_mine_can_be_assigned(
    authed_client, mock_db_session, destroy_sessions, role_sets
):
    client, set_user = authed_client
    set_user(FakeUser(3, "hr", HR))
    target = make_user(7, "viewer")
    mock_db_session.execute = AsyncMock(side_effect=[lookup(target)])

    resp = await client.put("/api/users/7", json={"role": "user"})

    assert resp.status_code == 200
    assert target.role == "user"
    destroy_sessions.assert_awaited_once()


async def test_a_role_beyond_mine_cannot_be_assigned(
    authed_client, mock_db_session, destroy_sessions, role_sets
):
    client, set_user = authed_client
    set_user(FakeUser(3, "hr", HR))
    target = make_user(7, "user")
    mock_db_session.execute = AsyncMock(side_effect=[lookup(target)])

    resp = await client.put("/api/users/7", json={"role": "superuser"})

    assert resp.status_code == 403
    assert resp.json()["detail"] == ROLE_ESCALATION_DETAIL
    assert target.role == "user"
    mock_db_session.commit.assert_not_awaited()


async def test_only_admins_assign_the_admin_role(
    authed_client, mock_db_session, destroy_sessions, role_sets
):
    client, set_user = authed_client
    set_user(FakeUser(3, "hr", HR))
    target = make_user(7, "user")
    mock_db_session.execute = AsyncMock(side_effect=[lookup(target)])

    resp = await client.put("/api/users/7", json={"role": "admin"})

    assert resp.status_code == 403
    assert resp.json()["detail"] == ASSIGN_ADMIN_DETAIL


async def test_a_stronger_users_role_cannot_be_changed(
    authed_client, mock_db_session, destroy_sessions, role_sets
):
    client, set_user = authed_client
    set_user(FakeUser(3, "hr", HR))
    target = make_user(7, "superuser")
    mock_db_session.execute = AsyncMock(side_effect=[lookup(target)])

    resp = await client.put("/api/users/7", json={"role": "user"})

    assert resp.status_code == 403
    assert resp.json()["detail"] == ROLE_CHANGE_OF_STRONGER_DETAIL
    assert target.role == "superuser"


async def test_changing_a_role_needs_change_role(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(5, "superuser"))
    mock_db_session.execute = AsyncMock(side_effect=[lookup(make_user(7, "user"))])

    resp = await client.put("/api/users/7", json={"role": "viewer"})

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Permission required: users.change_role"


async def test_nobody_changes_their_own_role(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(3, "hr", HR))
    mock_db_session.execute = AsyncMock(side_effect=[lookup(make_user(3, "hr"))])

    resp = await client.put("/api/users/3", json={"role": "user"})

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Cannot change your own role"


# ---------------------------------------------------------------------------
# Administrator targets and the last active administrator
# ---------------------------------------------------------------------------


async def test_an_admin_account_needs_edit_admins(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(3, "hr", HR))
    mock_db_session.execute = AsyncMock(side_effect=[lookup(make_user(1, "admin"))])

    resp = await client.put("/api/users/1", json={"first_name": "X"})

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Permission required: users.edit_admins"


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PUT", "/api/users/1/toggle-active", None),
        ("PUT", "/api/users/1", {"active": 0}),
        ("DELETE", "/api/users/1", None),
    ],
    ids=["toggle-active", "put-active", "delete"],
)
async def test_the_last_active_admin_stays(
    authed_client, mock_db_session, destroy_sessions, method, path, body
):
    client, set_user = authed_client
    set_user(FakeUser(3, "hr", {**HR, "users.edit_admins": "allow"}))
    admin = make_user(1, "admin")
    mock_db_session.execute = AsyncMock(side_effect=[lookup(admin), scalar_result(0)])

    resp = await client.request(method, path, json=body)

    assert resp.status_code == 400
    assert resp.json()["detail"] == LAST_ADMIN_DETAIL
    assert admin.active == 1
    count_sql = str(mock_db_session.execute.await_args_list[1].args[0])
    assert "count" in count_sql.lower() and "users.active" in count_sql
    mock_db_session.commit.assert_not_awaited()


async def test_an_admin_with_another_active_admin_can_be_deactivated(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(3, "hr", {**HR, "users.edit_admins": "allow"}))
    admin = make_user(1, "admin")
    # The target, the active-admin count, then their pending approval requests.
    mock_db_session.execute = AsyncMock(
        side_effect=[lookup(admin), scalar_result(1), scalars_result([])]
    )

    resp = await client.put("/api/users/1/toggle-active")

    assert resp.status_code == 200
    assert admin.active == 0


async def test_an_admin_caller_needs_no_count(authed_client, mock_db_session, destroy_sessions):
    client, set_user = authed_client
    set_user(FakeUser(2, "admin"))
    admin = make_user(1, "admin")
    # The target, then their pending approval requests: no active-admin count.
    mock_db_session.execute = AsyncMock(side_effect=[lookup(admin), scalars_result([])])

    resp = await client.put("/api/users/1/toggle-active")

    assert resp.status_code == 200
    assert mock_db_session.execute.await_count == 2


# ---------------------------------------------------------------------------
# Credentials, sites, create
# ---------------------------------------------------------------------------


async def test_edit_credentials_changes_another_users_email(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(3, "helpdesk", {"users.edit_credentials"}))
    target = make_user(7, "user")
    mock_db_session.execute = AsyncMock(side_effect=[lookup(target), scalar_result(None)])

    resp = await client.put("/api/users/7", json={"email": "new@example.com"})

    assert resp.status_code == 200
    assert target.email == "new@example.com"


async def test_sites_outside_the_live_visible_set_cannot_be_assigned(
    authed_client, mock_db_session, destroy_sessions
):
    client, set_user = authed_client
    set_user(FakeUser(3, "hr", HR, site_ids=[1]))
    mock_db_session.execute = AsyncMock(side_effect=[lookup(make_user(7, "user"))])

    resp = await client.put("/api/users/7", json={"site_ids": [1, 2]})

    assert resp.status_code == 403
    assert "site 2 not allowed" in resp.json()["detail"]


async def test_creating_with_another_role_needs_change_role(authed_client, mock_db_session):
    client, set_user = authed_client
    set_user(FakeUser(3, "recruiter", {"users.create"}))

    resp = await client.post(
        "/api/users",
        json={
            "email": "n@example.com",
            "password": "s3cret-pass",
            "first_name": "N",
            "last_name": "P",
            "role": "superuser",
        },
    )

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Permission required: users.change_role"
    mock_db_session.execute.assert_not_awaited()


NEW_ACCOUNT = {
    "email": "n@example.com",
    "password": "s3cret-pass",
    "first_name": "N",
    "last_name": "P",
}


async def test_users_create_alone_creates_an_account_with_the_default_role(
    authed_client, mock_db_session, role_sets
):
    # An HR-style role without the user role's Kanban/view keys still creates
    # plain users: the escalation guard comes with users.change_role only.
    client, set_user = authed_client
    set_user(FakeUser(3, "recruiter", {"users.create"}))
    mock_db_session.execute = AsyncMock(side_effect=[scalar_result(None)])  # email free

    async def flush():
        for call in mock_db_session.add.call_args_list:
            if isinstance(call.args[0], User):
                call.args[0].id = 55

    async def refresh(obj):
        obj.created_at = STAMP

    mock_db_session.flush.side_effect = flush
    mock_db_session.refresh.side_effect = refresh

    resp = await client.post("/api/users", json=NEW_ACCOUNT)

    assert resp.status_code == 201, resp.text
    assert resp.json()["role"] == "user"
    role_sets.assert_not_called()


async def test_creating_with_another_role_is_subject_to_the_escalation_guard(
    authed_client, mock_db_session, role_sets
):
    client, set_user = authed_client
    set_user(FakeUser(3, "hr", HR))
    mock_db_session.execute = AsyncMock(side_effect=[scalar_result(None)])  # email free

    resp = await client.post("/api/users", json={**NEW_ACCOUNT, "role": "superuser"})

    assert resp.status_code == 403
    assert resp.json()["detail"] == ROLE_ESCALATION_DETAIL
    mock_db_session.add.assert_not_called()
