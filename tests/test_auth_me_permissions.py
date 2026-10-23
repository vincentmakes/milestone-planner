"""
The permission fields of ``/auth/me`` and ``/auth/login`` (UserSessionInfo).

Both return the live role's ``roleName``, ``permissions`` (allow keys; the
admin: every key), ``approvalRequired`` (keys in approval mode) and
``canSeeAllSites`` (``sites.view_all``), read in the same request.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.user import User
from app.services.encryption import hash_user_password
from app.services.login_throttle import reset_login_throttle
from app.services.permissions import PERMISSION_KEYS
from app.services.session import SessionService
from tests.support import scalar_result


@pytest.fixture(autouse=True)
def fresh_throttle():
    reset_login_throttle()
    yield
    reset_login_throttle()


def orm_user(role: str, role_name: str | None = None) -> User:
    user = User(
        id=7,
        email="ada@example.com",
        password=hash_user_password("correct-horse"),
        first_name="Ada",
        last_name="Lovelace",
        role=role,
        max_capacity=100,
        active=1,
        is_system=0,
    )
    user.role_name = role_name
    user.sites = []
    return user


def matrix_result(*rows):
    result = MagicMock()
    result.all.return_value = list(rows)
    return result


def kanban_switch(value: str | None = None):
    """The ``kanban_enabled`` lookup that follows the matrix (None: no row, on)."""
    return scalar_result(value)


async def me(app_client):
    with patch.object(SessionService, "get_user_from_session", AsyncMock(return_value={"id": 7})):
        resp = await app_client.get("/api/auth/me", cookies={"connect.sid": "s%3Asid."})
    assert resp.status_code == 200
    return resp.json()["user"]


async def test_me_returns_the_custom_roles_permissions(app_client, mock_db_session):
    mock_db_session.execute.side_effect = [
        scalar_result(orm_user("team_lead", "Team Lead")),
        matrix_result(
            ("projects.create", "allow"),
            ("assignments.self_create", "approval"),
            ("assignments.self_remove", "approval"),
        ),
        kanban_switch(),
    ]

    user = await me(app_client)

    assert user["role"] == "team_lead"
    assert user["roleName"] == "Team Lead"
    assert user["permissions"] == ["projects.create", "projects.view"]
    assert user["approvalRequired"] == ["assignments.self_create", "assignments.self_remove"]
    assert user["canSeeAllSites"] is False


async def test_me_for_an_admin_lists_every_key(app_client, mock_db_session):
    mock_db_session.execute.side_effect = [
        scalar_result(orm_user("admin", "Administrator")),
        kanban_switch(),
    ]

    user = await me(app_client)

    assert user["roleName"] == "Administrator"
    assert user["permissions"] == sorted(PERMISSION_KEYS)
    assert user["approvalRequired"] == []
    assert user["canSeeAllSites"] is True
    # The admin's set needs no role_permissions query, only the switch.
    assert mock_db_session.execute.await_count == 2


async def test_me_with_sites_view_all(app_client, mock_db_session):
    mock_db_session.execute.side_effect = [
        scalar_result(orm_user("auditor", "Auditor")),
        matrix_result(("sites.view_all", "allow")),
        kanban_switch(),
    ]

    user = await me(app_client)

    assert user["canSeeAllSites"] is True
    assert "sites.view_all" in user["permissions"]


async def test_me_falls_back_to_the_system_role_name(app_client, mock_db_session):
    mock_db_session.execute.side_effect = [
        scalar_result(orm_user("superuser")),
        matrix_result(),
        kanban_switch(),
    ]

    user = await me(app_client)

    assert user["roleName"] == "Superuser"
    assert user["permissions"] == ["projects.view"]


async def test_login_returns_the_permission_fields(app_client, mock_db_session):
    mock_db_session.execute.side_effect = [
        scalar_result(orm_user("team_lead", "Team Lead")),
        matrix_result(("views.kanban", "allow"), ("assignments.self_update", "approval")),
        kanban_switch("true"),
    ]

    with patch.object(SessionService, "create_session", AsyncMock(return_value="sid")):
        resp = await app_client.post(
            "/api/auth/login", json={"email": "ada@example.com", "password": "correct-horse"}
        )

    assert resp.status_code == 200
    user = resp.json()["user"]
    assert user["roleName"] == "Team Lead"
    assert user["permissions"] == ["projects.view", "views.kanban"]
    assert user["approvalRequired"] == ["assignments.self_update"]
    assert user["canSeeAllSites"] is False


# ---------------------------------------------------------------------------
# The Kanban switch: views.kanban leaves the list for everyone
# ---------------------------------------------------------------------------


async def test_me_without_the_board_for_an_admin(app_client, mock_db_session):
    mock_db_session.execute.side_effect = [
        scalar_result(orm_user("admin", "Administrator")),
        kanban_switch("false"),
    ]

    user = await me(app_client)

    assert "views.kanban" not in user["permissions"]
    assert user["permissions"] == sorted(PERMISSION_KEYS - {"views.kanban"})
    sql = str(
        mock_db_session.execute.await_args_list[1]
        .args[0]
        .compile(compile_kwargs={"literal_binds": True})
    )
    assert "settings.key = 'kanban_enabled'" in sql


async def test_me_without_the_board_for_a_role_holding_it(app_client, mock_db_session):
    mock_db_session.execute.side_effect = [
        scalar_result(orm_user("team_lead", "Team Lead")),
        matrix_result(("views.kanban", "allow"), ("kanban.comment", "allow")),
        kanban_switch("false"),
    ]

    user = await me(app_client)

    assert user["permissions"] == ["kanban.comment", "projects.view"]


async def test_login_without_the_board(app_client, mock_db_session):
    mock_db_session.execute.side_effect = [
        scalar_result(orm_user("team_lead", "Team Lead")),
        matrix_result(("views.kanban", "allow"), ("assignments.self_update", "approval")),
        kanban_switch("false"),
    ]

    with patch.object(SessionService, "create_session", AsyncMock(return_value="sid")):
        resp = await app_client.post(
            "/api/auth/login", json={"email": "ada@example.com", "password": "correct-horse"}
        )

    assert resp.status_code == 200
    user = resp.json()["user"]
    assert user["permissions"] == ["projects.view"]
    assert user["approvalRequired"] == ["assignments.self_update"]
