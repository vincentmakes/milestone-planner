"""
Resource-level access checks for Kanban cards.

The keys: ``kanban.move_any`` moves any card (the route evaluates it with the
PM bundle, so a project manager moves the cards of their project), and
``kanban.move_assigned`` moves a card the user holds an *approved* staff
assignment on (a pending self-booking does not count).

The helpers take primitives (`user_id`, the two decisions) rather than a User
object on purpose. `get_current_user` is annotated `-> User` but often returns
the lightweight SessionUser built from session data, which is not an ORM
instance and carries only id/email/name/role/permissions/site_ids. Passing
primitives makes it impossible to accidentally depend on an attribute
SessionUser lacks.
"""

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.assignment import PhaseStaffAssignment, SubphaseStaffAssignment
from app.services.permissions import permission_required_detail

CardEntityType = str  # "phase" | "subphase" (validated by the route's Literal)

NOT_ASSIGNED_DETAIL = "You can only change the status of cards you are assigned to"
MOVE_ASSIGNED_DENIED_DETAIL = permission_required_detail("kanban.move_any", "kanban.move_assigned")


async def user_is_card_assignee(
    db: AsyncSession,
    entity_type: CardEntityType,
    entity_id: int,
    user_id: int,
) -> bool:
    """Whether `user_id` holds an approved staff assignment on this card."""
    if entity_type == "phase":
        query = select(PhaseStaffAssignment.id).where(
            PhaseStaffAssignment.phase_id == entity_id,
            PhaseStaffAssignment.staff_id == user_id,
            PhaseStaffAssignment.approval_status == "approved",
        )
    else:
        query = select(SubphaseStaffAssignment.id).where(
            SubphaseStaffAssignment.subphase_id == entity_id,
            SubphaseStaffAssignment.staff_id == user_id,
            SubphaseStaffAssignment.approval_status == "approved",
        )

    result = await db.execute(query.limit(1))
    return result.first() is not None


async def require_card_status_write(
    db: AsyncSession,
    *,
    entity_type: CardEntityType,
    entity_id: int,
    user_id: int,
    can_move_any: bool,
    can_move_assigned: bool,
) -> None:
    """Allow a card status change with ``kanban.move_any``, or by an approved
    assignee holding ``kanban.move_assigned``. Raises 403 otherwise.
    """
    if can_move_any:
        return

    if not can_move_assigned:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=MOVE_ASSIGNED_DENIED_DETAIL
        )

    if await user_is_card_assignee(db, entity_type, entity_id, user_id):
        return

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NOT_ASSIGNED_DETAIL)
