"""
Posting a comment on a thread: the pieces shared by the comment route
(``POST /kanban/cards/{type}/{id}/comments``, app/routers/kanban.py) and the
two places that post a comment as part of a booking:

- a staff booking created directly with a ``comment`` (the three staff create
  routes in app/routers/assignments.py): the actor's comment, in the same
  transaction as the booking (``stage_booking_comment``);
- an approved create request carrying a ``note`` (``approvals.approve``): the
  requester's note, posted as their comment when they hold ``kanban.comment``.

A booking's thread is the one its dialog shows: the card's thread for a phase
/ subphase booking, the project thread for a project-level booking
(``booking_thread``). Mentions are derived from the body
(``validate_mention_ids``), never from a client-supplied list.

Who is notified of a booking's comment (one notification per person): the
mentioned users (``mention``) and the thread's approved assignees
(``comment``), minus the actor -- and minus the booked person and the
project's manager, whom the booking's change notification already reaches
(its body carries the comment's preview), and a mentioned booked person gets
the change notification only. The caller passes the staged recipients to
``change_notifications.deliver`` as ``already_notified``.
"""

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.card_comment import CardComment
from app.models.notification import Notification
from app.models.user import User
from app.services.mentions import comment_preview, parse_mention_ids
from app.services.notifications import build_notifications, card_assignee_ids, dedupe_by_recipient
from app.utils import utcnow_naive


def booking_thread(level: str, project_id: int, target_id: int) -> tuple[str, int]:
    """``(entity_type, entity_id)`` of the thread a booking's comments go to."""
    return ("project", project_id) if level == "project" else (level, target_id)


def author_name(user: Any) -> str:
    """``First Last`` of a comment's author (or SessionUser), else ``Someone``."""
    name = f"{getattr(user, 'first_name', '') or ''} {getattr(user, 'last_name', '') or ''}"
    return name.strip() or "Someone"


def new_comment(
    *,
    entity_type: str,
    entity_id: int,
    project_id: int,
    author_id: int,
    body: str,
    mentioned: list[int],
) -> CardComment:
    """
    A new comment row (not added to the session).

    One instant for both stamps: separate column defaults would read two
    clocks, and ``is_edited`` (updated_at > created_at) would flag every new
    comment as edited.
    """
    now = utcnow_naive()
    comment = CardComment(
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=project_id,
        author_id=author_id,
        body=body,
        created_at=now,
        updated_at=now,
    )
    comment.set_mentions(mentioned)
    return comment


def build_comment_notifications(
    *,
    mentioned: list[int],
    assignees: list[int],
    actor_id: int,
    actor_name: str,
    entity_type: str,
    entity_id: int,
    project_id: int,
    card_name: str,
    preview: str,
) -> list[Notification]:
    """
    ``mention`` to the mentioned users and ``comment`` to the assignees, the
    actor dropped; a user who is both gets the mention only.
    """
    return dedupe_by_recipient(
        [
            build_notifications(
                recipient_ids=mentioned,
                notification_type="mention",
                actor_id=actor_id,
                entity_type=entity_type,
                entity_id=entity_id,
                project_id=project_id,
                title=f"{actor_name} mentioned you on {card_name}",
                body=preview,
            ),
            build_notifications(
                recipient_ids=assignees,
                notification_type="comment",
                actor_id=actor_id,
                entity_type=entity_type,
                entity_id=entity_id,
                project_id=project_id,
                title=f"{actor_name} commented on {card_name}",
                body=preview,
            ),
        ]
    )


async def validate_mention_ids(db: AsyncSession, body: str) -> list[int]:
    """Mentioned user ids parsed from the body, filtered to real users.

    Targeting is derived from the body rather than a client-supplied list: the
    body is the durable record, so the mentions a reader sees rendered are
    exactly the ones that were notified, and that stays true across edits and
    exports. (The column is labelled so the approval tests' statement-keyed
    fake can tell this lookup from the approvers query.)
    """
    ids = parse_mention_ids(body)
    if not ids:
        return []
    valid = await db.execute(select(User.id.label("mentioned_id")).where(User.id.in_(set(ids))))
    found = set(valid.scalars().all())
    return [uid for uid in ids if uid in found]


@dataclass
class StagedComment:
    """A comment added to the session with its staged notifications."""

    comment: CardComment
    notifications: list[Notification] = field(default_factory=list)

    @property
    def recipient_ids(self) -> set[int]:
        return {row.user_id for row in self.notifications}


async def stage_booking_comment(
    db: AsyncSession,
    user: Any,
    *,
    level: str,
    project_id: int,
    target_id: int,
    booked_id: int,
    pm_id: int | None,
    target_name: str,
    body: str,
) -> StagedComment:
    """
    Add the actor's comment on a booking they create directly, and stage its
    notifications, in the caller's transaction (the caller commits). The
    caller checks ``kanban.comment`` before any write.
    """
    entity_type, entity_id = booking_thread(level, project_id, target_id)
    mentioned = await validate_mention_ids(db, body)
    comment = new_comment(
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=project_id,
        author_id=user.id,
        body=body,
        mentioned=mentioned,
    )
    db.add(comment)

    told_by_the_booking = {booked_id, pm_id}
    assignees = await card_assignee_ids(db, entity_type, entity_id)
    rows = build_comment_notifications(
        mentioned=[uid for uid in mentioned if uid != booked_id],
        assignees=[uid for uid in assignees if uid not in told_by_the_booking],
        actor_id=user.id,
        actor_name=author_name(user),
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=project_id,
        card_name=target_name,
        preview=comment_preview(body),
    )
    db.add_all(rows)
    return StagedComment(comment, rows)
