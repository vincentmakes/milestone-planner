"""
Resource-level access checks for Kanban cards.

This sits on top of the role dependencies in app/middleware/auth.py rather than
duplicating them: superusers and admins keep their blanket write access, and
this adds the one narrower rule the board needs -- a plain `user` may move a
card they are assigned to.

The helpers take primitives (`user_id`, `is_privileged`) rather than a User
object on purpose. `get_current_user` is annotated `-> User` but often returns
the lightweight SessionUser built from session data, which is not an ORM
instance and carries only id/email/name/role/site_ids. Passing primitives makes
it impossible to accidentally depend on an attribute SessionUser lacks.
"""

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.assignment import PhaseStaffAssignment, SubphaseStaffAssignment

CardEntityType = str  # "phase" | "subphase" (validated by the route's Literal)


async def user_is_card_assignee(
    db: AsyncSession,
    entity_type: CardEntityType,
    entity_id: int,
    user_id: int,
) -> bool:
    """Whether `user_id` holds a staff assignment on this card."""
    if entity_type == "phase":
        query = select(PhaseStaffAssignment.id).where(
            PhaseStaffAssignment.phase_id == entity_id,
            PhaseStaffAssignment.staff_id == user_id,
        )
    else:
        query = select(SubphaseStaffAssignment.id).where(
            SubphaseStaffAssignment.subphase_id == entity_id,
            SubphaseStaffAssignment.staff_id == user_id,
        )

    result = await db.execute(query.limit(1))
    return result.first() is not None


async def require_card_status_write(
    db: AsyncSession,
    *,
    entity_type: CardEntityType,
    entity_id: int,
    user_id: int,
    is_privileged: bool,
) -> None:
    """Allow a card status change by a superuser/admin, or by an assignee.

    Raises 403 otherwise.
    """
    if is_privileged:
        return

    if await user_is_card_assignee(db, entity_type, entity_id, user_id):
        return

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You can only change the status of cards you are assigned to",
    )
