"""
Notification creation for Kanban events.

Rules live here rather than in the routers so every trigger behaves the same:
  - the actor never notifies themselves
  - one notification per recipient per event (a user who is both assigned and
    @mentioned gets the mention, which is the more specific signal)
  - rows are staged before the caller's commit, so a notification and the
    mutation that caused it land in the same transaction

Due-soon/overdue reminders are deliberately absent: they are derived in the
browser from already-loaded project data (there is no scheduler in this app),
which is why `notifications_type_check` has no `due_soon` value.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.assignment import PhaseStaffAssignment, SubphaseStaffAssignment
from app.models.notification import Notification

# Ordered by specificity: the earlier type wins when one event would otherwise
# produce two notifications for the same recipient.
_TYPE_PRIORITY = ("mention", "assigned", "status_change", "comment")


async def card_assignee_ids(
    db: AsyncSession,
    entity_type: str,
    entity_id: int,
) -> list[int]:
    """Staff ids currently assigned to a card."""
    if entity_type == "phase":
        query = select(PhaseStaffAssignment.staff_id).where(
            PhaseStaffAssignment.phase_id == entity_id
        )
    else:
        query = select(SubphaseStaffAssignment.staff_id).where(
            SubphaseStaffAssignment.subphase_id == entity_id
        )

    result = await db.execute(query)
    return list(dict.fromkeys(result.scalars().all()))


def build_notifications(
    *,
    recipient_ids: list[int],
    notification_type: str,
    actor_id: int,
    entity_type: str | None,
    entity_id: int | None,
    project_id: int | None,
    title: str,
    body: str | None = None,
) -> list[Notification]:
    """Build (but do not persist) notification rows, minus the actor."""
    seen: set[int] = set()
    rows: list[Notification] = []

    for user_id in recipient_ids:
        if user_id == actor_id or user_id in seen:
            continue
        seen.add(user_id)
        rows.append(
            Notification(
                user_id=user_id,
                type=notification_type,
                actor_id=actor_id,
                entity_type=entity_type,
                entity_id=entity_id,
                project_id=project_id,
                title=title,
                body=body,
            )
        )

    return rows


def dedupe_by_recipient(batches: list[list[Notification]]) -> list[Notification]:
    """Collapse several batches so each recipient gets only the most specific one."""
    by_user: dict[int, Notification] = {}

    for batch in batches:
        for row in batch:
            existing = by_user.get(row.user_id)
            if existing is None:
                by_user[row.user_id] = row
                continue
            if _priority(row.type) < _priority(existing.type):
                by_user[row.user_id] = row

    return list(by_user.values())


def _priority(notification_type: str) -> int:
    try:
        return _TYPE_PRIORITY.index(notification_type)
    except ValueError:
        return len(_TYPE_PRIORITY)


def notification_payload(row: Notification) -> dict:
    """Serialise a notification for the API and the WebSocket push."""
    return {
        "id": row.id,
        "type": row.type,
        "actor_id": row.actor_id,
        "entity_type": row.entity_type,
        "entity_id": row.entity_id,
        "project_id": row.project_id,
        "title": row.title,
        "body": row.body,
        "read_at": row.read_at.isoformat() + "Z" if row.read_at else None,
        "created_at": row.created_at.isoformat() + "Z" if row.created_at else None,
    }
