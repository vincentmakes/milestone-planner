"""
Tests for the card-level permission gate (app/services/card_access.py).

The rule: ``kanban.move_any`` (outright or through the PM bundle) moves any
card; otherwise ``kanban.move_assigned`` moves the cards the user holds an
approved assignment on. Without either key, nothing moves.

The Kanban switch (``kanban_enabled = false``) takes ``views.kanban`` from
everyone, admins included: the board's four reads answer 403, while the card
writes (status, assignees, comments) gate on other keys and keep working.
"""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.models.user import User
from app.services.card_access import (
    MOVE_ASSIGNED_DENIED_DETAIL,
    require_card_status_write,
    user_is_card_assignee,
)
from app.services.permissions import PermissionSet, default_modes
from tests.conftest import FakeUser
from tests.support import scalar_result, scalars_result


def _db_returning(row):
    """Mock session whose execute().first() yields `row`."""
    db = AsyncMock()
    result = MagicMock()
    result.first.return_value = row
    db.execute.return_value = result
    return db


async def test_move_any_passes_without_querying():
    db = _db_returning(None)
    await require_card_status_write(
        db,
        entity_type="phase",
        entity_id=1,
        user_id=99,
        can_move_any=True,
        can_move_assigned=False,
    )
    # A move_any holder must short-circuit before touching the database.
    db.execute.assert_not_called()


async def test_assignee_may_move_their_own_card():
    db = _db_returning((123,))
    await require_card_status_write(
        db,
        entity_type="subphase",
        entity_id=7,
        user_id=5,
        can_move_any=False,
        can_move_assigned=True,
    )
    db.execute.assert_awaited()


async def test_non_assignee_is_rejected():
    db = _db_returning(None)
    with pytest.raises(HTTPException) as exc:
        await require_card_status_write(
            db,
            entity_type="phase",
            entity_id=7,
            user_id=5,
            can_move_any=False,
            can_move_assigned=True,
        )
    assert exc.value.status_code == 403


async def test_an_assignee_without_move_assigned_is_rejected_without_querying():
    db = _db_returning((123,))
    with pytest.raises(HTTPException) as exc:
        await require_card_status_write(
            db,
            entity_type="phase",
            entity_id=7,
            user_id=5,
            can_move_any=False,
            can_move_assigned=False,
        )
    assert exc.value.status_code == 403
    assert exc.value.detail == MOVE_ASSIGNED_DENIED_DETAIL
    db.execute.assert_not_called()


async def test_gate_works_against_a_session_user_shaped_object():
    """
    get_current_user often returns the lightweight SessionUser, not an ORM User.
    The gate takes primitives, so a plain object with id is enough.
    """
    session_user = SimpleNamespace(id=5, role="user")
    db = _db_returning((1,))
    await require_card_status_write(
        db,
        entity_type="phase",
        entity_id=1,
        user_id=session_user.id,
        can_move_any=False,
        can_move_assigned=True,
    )


@pytest.mark.parametrize("entity_type", ["phase", "subphase"])
async def test_assignee_lookup_covers_both_entity_types(entity_type):
    db = _db_returning((1,))
    assert await user_is_card_assignee(db, entity_type, 1, 5) is True

    db = _db_returning(None)
    assert await user_is_card_assignee(db, entity_type, 1, 5) is False


@pytest.mark.parametrize("entity_type", ["phase", "subphase"])
async def test_only_approved_assignments_count(entity_type):
    db = _db_returning((1,))
    await user_is_card_assignee(db, entity_type, 1, 5)
    sql = " ".join(str(db.execute.await_args.args[0]).split())
    assert "approval_status" in sql


# ---------------------------------------------------------
# Pending assignees (a self-booking awaiting approval)
# ---------------------------------------------------------


@pytest.mark.parametrize("entity_type", ["phase", "subphase"])
async def test_a_pending_assignee_cannot_move_the_card(entity_type):
    """The lookup finds only approved rows; a pending joiner has none -> 403."""
    db = _db_returning(None)  # the approved-only query finds nothing
    with pytest.raises(HTTPException) as exc:
        await require_card_status_write(
            db,
            entity_type=entity_type,
            entity_id=7,
            user_id=5,
            can_move_any=False,
            can_move_assigned=True,
        )
    assert exc.value.status_code == 403
    sql = str(db.execute.await_args.args[0].compile(compile_kwargs={"literal_binds": True}))
    assert "approval_status = 'approved'" in sql


@pytest.mark.parametrize("entity_type", ["phase", "subphase"])
async def test_a_pending_assignee_is_not_notified_as_an_assignee(entity_type):
    from app.services.notifications import card_assignee_ids

    db = AsyncMock()
    result = MagicMock()
    result.scalars.return_value.all.return_value = [5, 5, 8]
    db.execute.return_value = result

    assert await card_assignee_ids(db, entity_type, 7) == [5, 8]
    sql = str(db.execute.await_args.args[0].compile(compile_kwargs={"literal_binds": True}))
    assert "approval_status = 'approved'" in sql


async def test_approval_notifications_rank_between_mention_and_assigned():
    from app.models.notification import Notification
    from app.services.notifications import dedupe_by_recipient

    def note(kind):
        return Notification(user_id=5, type=kind, title=kind)

    batches = [[note("comment")], [note("assigned")], [note("approval_decided")]]
    assert dedupe_by_recipient(batches)[0].type == "approval_decided"
    batches = [[note("approval_decided")], [note("approval_requested")]]
    assert dedupe_by_recipient(batches)[0].type == "approval_requested"
    batches = [[note("approval_requested")], [note("mention")]]
    assert dedupe_by_recipient(batches)[0].type == "mention"
    batches = [[note("status_change")], [note("todo_assigned")]]
    assert dedupe_by_recipient(batches)[0].type == "todo_assigned"


# ---------------------------------------------------------
# The Kanban switch turned off
# ---------------------------------------------------------

BOARD_OFF = frozenset({"views.kanban"})


def board_off(user_id: int, role: str) -> FakeUser:
    user = FakeUser(user_id, role)
    user.permissions = PermissionSet(role, default_modes(role), BOARD_OFF)
    return user


def _card(project_id=3):
    return SimpleNamespace(
        id=10, project_id=project_id, status="todo", completion=0, name=None, type="Design"
    )


@pytest.fixture
def wires():
    with (
        patch("app.routers.kanban.broadcast_change", new_callable=AsyncMock),
        patch("app.routers.kanban.send_notification", new_callable=AsyncMock),
        patch("app.routers.kanban.card_assignee_ids", new_callable=AsyncMock) as assignees,
    ):
        assignees.return_value = []
        yield


@pytest.mark.parametrize(
    "path",
    [
        "/api/kanban/projects/3/comment-counts",
        "/api/kanban/sites/1/comment-counts",
        "/api/kanban/sites/1/mentionable-users",
        "/api/kanban/cards/phase/10/comments",
    ],
)
async def test_the_board_reads_are_403_for_an_admin_when_off(authed_client, mock_db_session, path):
    client, set_user = authed_client
    set_user(board_off(1, "admin"))

    response = await client.get(path)

    assert response.status_code == 403
    assert response.json()["detail"] == "Permission required: views.kanban"
    mock_db_session.execute.assert_not_awaited()


async def test_an_admin_moves_a_card_with_the_board_off(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(board_off(1, "admin"))
    mock_db_session.execute.side_effect = [scalar_result(_card()), scalars_result([])]

    response = await client.put("/api/kanban/cards/phase/10/status", json={"status": "done"})

    assert response.status_code == 200
    assert response.json()["status"] == "done"


async def test_an_assignee_moves_their_card_with_the_board_off(
    authed_client, mock_db_session, wires
):
    client, set_user = authed_client
    set_user(board_off(5, "user"))
    pm = MagicMock()
    pm.first.return_value = (99,)
    assigned = MagicMock()
    assigned.first.return_value = (42,)
    mock_db_session.execute.side_effect = [
        scalar_result(_card()),
        pm,
        assigned,
        scalars_result([5]),
    ]

    response = await client.put("/api/kanban/cards/phase/10/status", json={"status": "in_progress"})

    assert response.status_code == 200


async def test_an_admin_assigns_a_card_with_the_board_off(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(board_off(1, "admin"))
    assignee = User(id=7, email="b@example.com", first_name="Bob", last_name="B", max_capacity=60)
    mock_db_session.execute.side_effect = [
        scalar_result(_card()),
        scalar_result(assignee),
        scalar_result(None),
    ]

    async def refresh(obj):
        obj.id = 300

    mock_db_session.refresh.side_effect = refresh

    response = await client.post("/api/kanban/cards/phase/10/assignees", json={"staff_id": 7})

    assert response.status_code == 201


async def test_a_user_leaves_a_card_with_the_board_off(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(board_off(7, "user"))
    row = SimpleNamespace(
        id=300,
        project_id=3,
        staff_id=7,
        allocation=60,
        approval_status="approved",
        approval_request_id=None,
    )
    mock_db_session.execute.side_effect = [scalar_result(_card()), scalar_result(row)]

    response = await client.delete("/api/kanban/cards/phase/10/assignees/7")

    assert response.status_code == 200


async def test_a_user_comments_with_the_board_off(authed_client, mock_db_session, wires):
    client, set_user = authed_client
    set_user(board_off(5, "user"))
    mock_db_session.execute.side_effect = [scalar_result(_card())]

    async def refresh(obj):
        obj.id = 61
        obj.created_at = obj.updated_at = datetime(2026, 1, 1, 12, 0, 0)

    mock_db_session.refresh.side_effect = refresh

    response = await client.post("/api/kanban/cards/phase/10/comments", json={"body": "hi"})

    assert response.status_code == 201
