"""
Session revocation and live auth state (B1-1).

The session row stores a login-time snapshot of the user. get_current_user
must re-read ``active`` and ``role`` so a deactivated, deleted or demoted user
loses their privileges on the next request, and SessionService must be able to
destroy every session of a user.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.session import SessionService, session_ids_for_user


def sess(user_id, compact: bool = False) -> str:
    data = {"cookie": {"path": "/"}, "user": {"id": user_id, "role": "admin"}}
    return json.dumps(data, separators=(",", ":") if compact else None)


# ---------------------------------------------------------------------------
# Matching sessions to a user
# ---------------------------------------------------------------------------


def test_session_ids_for_user_matches_exact_id_only():
    rows = [
        ("a", sess(7)),
        ("b", sess(70)),  # LIKE '%7%' pre-filter lets this through
        ("c", sess(7, compact=True)),  # Node-style serialisation
        ("d", sess("7")),  # id stored as a string
        ("e", "{not json"),
        ("f", json.dumps({"cookie": {}})),  # no user
        ("g", json.dumps(["7"])),  # not a dict
    ]
    assert session_ids_for_user(rows, 7) == ["a", "c", "d"]


def test_session_ids_for_user_can_keep_current_session():
    rows = [("mine", sess(7)), ("other", sess(7))]
    assert session_ids_for_user(rows, 7, except_session_id="mine") == ["other"]


@pytest.mark.asyncio
async def test_destroy_user_sessions_deletes_matching_rows():
    db = MagicMock()
    select_result = MagicMock()
    select_result.all.return_value = [("a", sess(7)), ("b", sess(70))]
    db.execute = AsyncMock(side_effect=[select_result, MagicMock()])
    db.commit = AsyncMock()

    deleted = await SessionService(db).destroy_user_sessions(7)

    assert deleted == 1
    assert db.execute.await_count == 2  # select + delete
    delete_stmt = db.execute.await_args_list[1].args[0]
    assert "DELETE FROM sessions" in str(delete_stmt)
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_destroy_user_sessions_without_commit_and_no_match():
    db = MagicMock()
    select_result = MagicMock()
    select_result.all.return_value = [("b", sess(70))]
    db.execute = AsyncMock(return_value=select_result)
    db.commit = AsyncMock()

    deleted = await SessionService(db).destroy_user_sessions(7, commit=False)

    assert deleted == 0
    assert db.execute.await_count == 1  # no DELETE issued
    db.commit.assert_not_awaited()


# ---------------------------------------------------------------------------
# get_current_user re-reads active / role
# ---------------------------------------------------------------------------

SESSION_SNAPSHOT = {
    "id": 7,
    "email": "u7@example.com",
    "first_name": "Ex",
    "last_name": "Admin",
    "role": "admin",
    "site_ids": [1],
    "site_names": ["Main"],
}

COOKIE = {"connect.sid": "s%3Asid-123."}


def live_rows(*rows):
    """The ``load_live_user`` result: (active, role, permission, mode) rows."""
    result = MagicMock()
    result.all.return_value = list(rows)
    return result


def live_row(mock_db_session, row):
    """One user row without permission rows (``None`` = the user is gone)."""
    result = live_rows(*([] if row is None else [(*row, None, None)]))
    mock_db_session.execute = AsyncMock(return_value=result)


@pytest.mark.asyncio
async def test_inactive_user_is_rejected_and_session_destroyed(app_client, mock_db_session):
    live_row(mock_db_session, (0, "admin"))
    with (
        patch.object(
            SessionService, "get_user_from_session", AsyncMock(return_value=SESSION_SNAPSHOT)
        ),
        patch.object(SessionService, "delete_session", AsyncMock(return_value=True)) as delete,
    ):
        resp = await app_client.get("/api/users", cookies=COOKIE)

    assert resp.status_code == 401
    delete.assert_awaited_once_with("sid-123")


@pytest.mark.asyncio
async def test_deleted_user_is_rejected(app_client, mock_db_session):
    live_row(mock_db_session, None)
    with (
        patch.object(
            SessionService, "get_user_from_session", AsyncMock(return_value=SESSION_SNAPSHOT)
        ),
        patch.object(SessionService, "delete_session", AsyncMock(return_value=True)) as delete,
    ):
        resp = await app_client.get("/api/users", cookies=COOKIE)

    assert resp.status_code == 401
    delete.assert_awaited_once_with("sid-123")


@pytest.mark.asyncio
async def test_demoted_user_loses_admin_rights_immediately(app_client, mock_db_session):
    """Session says admin, the users row says user: admin routes answer 403."""
    live_row(mock_db_session, (1, "user"))
    with (
        patch.object(
            SessionService, "get_user_from_session", AsyncMock(return_value=SESSION_SNAPSHOT)
        ),
        patch.object(SessionService, "delete_session", AsyncMock(return_value=True)) as delete,
    ):
        resp = await app_client.get("/api/users", cookies=COOKIE)

    assert resp.status_code == 403
    delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_active_user_passes_with_live_role():
    """Direct call: an active row lets the request through with the live role."""
    from app.middleware.auth import get_current_user

    class Snapshot:
        id = 7
        first_name = "A"
        last_name = "B"
        role = "user"

    db = MagicMock()
    db.execute = AsyncMock(
        return_value=live_rows(
            (1, "superuser", "projects.create", "allow"),
            (1, "superuser", "assignments.self_create", "approval"),
        )
    )
    request = MagicMock()
    request.scope = {"state": {}}

    user = await get_current_user(request, Snapshot(), "sid", db)  # type: ignore[arg-type]

    assert user.role == "superuser"
    assert request.scope["state"]["current_user"]["id"] == 7
    # The live role's matrix rides along on the user (one query).
    assert user.permissions.role_key == "superuser"
    assert user.permissions.has("projects.create")
    assert user.permissions.mode("assignments.self_create") == "approval"
    assert not user.permissions.has("projects.delete")
    db.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_live_permission_query_joins_the_role_matrix():
    from app.middleware.auth import load_live_user

    db = MagicMock()
    db.execute = AsyncMock(return_value=live_rows((1, "admin", None, None)))

    active, role, permissions = await load_live_user(db, 7)  # type: ignore[misc]

    assert (active, role) == (True, "admin")
    assert permissions.is_admin and permissions.has("roles.manage")
    sql = " ".join(str(db.execute.await_args.args[0]).split())
    assert "LEFT OUTER JOIN roles ON roles.key = users.role" in sql
    assert "LEFT OUTER JOIN role_permissions ON role_permissions.role_id = roles.id" in sql


@pytest.mark.asyncio
async def test_matrix_edit_applies_on_the_next_request():
    """Same session, same role: the permissions come from the rows of this request."""
    from app.middleware.auth import get_current_user

    class Snapshot:
        id = 7
        first_name = "A"
        last_name = "B"
        role = "user"

    request = MagicMock()
    request.scope = {"state": {}}
    db = MagicMock()
    db.execute = AsyncMock(return_value=live_rows((1, "user", None, None)))
    before = await get_current_user(request, Snapshot(), "sid", db)  # type: ignore[arg-type]
    db.execute = AsyncMock(return_value=live_rows((1, "user", "projects.create", "allow")))
    after = await get_current_user(request, Snapshot(), "sid", db)  # type: ignore[arg-type]

    assert not before.permissions.has("projects.create")
    assert after.permissions.has("projects.create")
