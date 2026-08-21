"""
Tests for the card-level permission gate.

The rule: superusers/admins may move any card; a plain user may move only cards
they are assigned to.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.services.card_access import require_card_status_write, user_is_card_assignee


def _db_returning(row):
    """Mock session whose execute().first() yields `row`."""
    db = AsyncMock()
    result = MagicMock()
    result.first.return_value = row
    db.execute.return_value = result
    return db


@pytest.mark.asyncio
async def test_superuser_passes_without_querying():
    db = _db_returning(None)
    await require_card_status_write(
        db, entity_type="phase", entity_id=1, user_id=99, is_privileged=True
    )
    # A privileged caller must short-circuit before touching the database.
    db.execute.assert_not_called()


@pytest.mark.asyncio
async def test_assignee_may_move_their_own_card():
    db = _db_returning((123,))
    await require_card_status_write(
        db, entity_type="subphase", entity_id=7, user_id=5, is_privileged=False
    )
    db.execute.assert_awaited()


@pytest.mark.asyncio
async def test_non_assignee_is_rejected():
    db = _db_returning(None)
    with pytest.raises(HTTPException) as exc:
        await require_card_status_write(
            db, entity_type="phase", entity_id=7, user_id=5, is_privileged=False
        )
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_gate_works_against_a_session_user_shaped_object():
    """
    get_current_user often returns the lightweight SessionUser, not an ORM User.
    The gate takes primitives, so a plain object with id/role is enough.
    """
    session_user = SimpleNamespace(id=5, role="user", is_admin=False, is_superuser=False)
    db = _db_returning((1,))
    await require_card_status_write(
        db,
        entity_type="phase",
        entity_id=1,
        user_id=session_user.id,
        is_privileged=bool(session_user.is_admin or session_user.is_superuser),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("entity_type", ["phase", "subphase"])
async def test_assignee_lookup_covers_both_entity_types(entity_type):
    db = _db_returning((1,))
    assert await user_is_card_assignee(db, entity_type, 1, 5) is True

    db = _db_returning(None)
    assert await user_is_card_assignee(db, entity_type, 1, 5) is False
