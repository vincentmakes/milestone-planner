"""
Notification creation for comment, Kanban and approval events.

Rules live here rather than in the routers so every trigger behaves the same:
  - the actor never notifies themselves
  - one notification per recipient per event (a user who is both assigned and
    @mentioned gets the mention, which is the more specific signal)
  - rows are staged before the caller's commit, so a notification and the
    mutation that caused it land in the same transaction -- except the change
    notifications (``assignment_changed`` / ``project_changed``,
    app/services/change_notifications.py), written after the caller's commit
    in their own short transaction: they coalesce under an advisory lock that
    must stay short, and the Gantt saves one drag as parallel PUTs whose
    notifications must merge

Due-soon/overdue reminders are deliberately absent: they are derived in the
browser from already-loaded project data (there is no scheduler in this app),
which is why `notifications_type_check` has no `due_soon` value.

Retention: a read notification is deleted ``READ_RETENTION_DAYS`` after it
was read (``purge_read_notifications``, run by ``GET /notifications``); an
unread one is kept until its recipient reads or deletes it.
"""

from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.notification import Notification
from app.utils import utcnow_naive

# Days a read notification stays in its recipient's inbox.
READ_RETENTION_DAYS = 30

# Ordered by specificity: the earlier type wins when one event would otherwise
# produce two notifications for the same recipient.
_TYPE_PRIORITY = (
    "mention",
    "approval_requested",
    "approval_decided",
    "assigned",
    "assignment_changed",
    "project_changed",
    "status_change",
    "comment",
)


async def purge_read_notifications(db: AsyncSession, user_id: int) -> int:
    """
    Delete ``user_id``'s notifications read more than ``READ_RETENTION_DAYS``
    ago; unread rows are never touched (``read_at < bound`` is never true
    for NULL). Staged on ``db``: the caller commits. Returns the row count.

    Run lazily when the inbox is listed, because the application has no
    scheduler; an inbox nobody opens keeps its old rows, which only its
    owner could ever see.
    """
    bound = utcnow_naive() - timedelta(days=READ_RETENTION_DAYS)
    result = await db.execute(
        delete(Notification).where(
            Notification.user_id == user_id,
            Notification.read_at.is_not(None),
            Notification.read_at < bound,
        )
    )
    return result.rowcount


async def card_assignee_ids(
    db: AsyncSession,
    entity_type: str,
    entity_id: int,
) -> list[int]:
    """Staff ids with an approved assignment on a card, or for a project
    thread (``entity_type == "project"``, ``entity_id`` = the project id) with
    an approved project-level booking.

    A pending self-booking (awaiting approval) is not an assignee yet: it is
    not notified of moves or comments as one (mentions still reach anyone).
    One branch per type: an unknown type is an error, never a subphase.
    """
    if entity_type == "phase":
        query = select(PhaseStaffAssignment.staff_id).where(
            PhaseStaffAssignment.phase_id == entity_id,
            PhaseStaffAssignment.approval_status == "approved",
        )
    elif entity_type == "subphase":
        query = select(SubphaseStaffAssignment.staff_id).where(
            SubphaseStaffAssignment.subphase_id == entity_id,
            SubphaseStaffAssignment.approval_status == "approved",
        )
    elif entity_type == "project":
        query = select(ProjectAssignment.staff_id).where(
            ProjectAssignment.project_id == entity_id,
            ProjectAssignment.approval_status == "approved",
        )
    else:
        raise ValueError(f"Unknown comment entity type: {entity_type!r}")

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
