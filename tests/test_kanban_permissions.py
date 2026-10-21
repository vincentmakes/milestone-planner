"""
Tests for the card-level permission gate (app/services/card_access.py).

The rule: ``kanban.move_any`` (outright or through the PM bundle) moves any
card; otherwise ``kanban.move_assigned`` moves the cards the user holds an
approved assignment on. Without either key, nothing moves.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.services.card_access import (
    MOVE_ASSIGNED_DENIED_DETAIL,
    require_card_status_write,
    user_is_card_assignee,
)


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
