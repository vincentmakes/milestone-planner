"""
Kanban board API routes.

The board itself has no read endpoint: GET /projects/{id} already returns the
whole phase/subphase tree, so the client derives cards from data it already
holds. What lives here is everything that tree does not carry -- status moves,
card assignees (which also book staff time), and comments.

Auth note: this is the one router where a plain `user` may write to project
data. Moving a card is allowed for superusers/admins, or for the assignees of
that specific card (see app/services/card_access.py); commenting is open to any
authenticated user. Every other board write stays require_superuser.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, get_db_readonly
from app.middleware.auth import get_current_user, require_superuser
from app.models.assignment import PhaseStaffAssignment, SubphaseStaffAssignment
from app.models.card_comment import CardComment
from app.models.project import ProjectPhase, ProjectSubphase
from app.models.user import User
from app.schemas.kanban import (
    CardAssigneeCreate,
    CardAssigneeResponse,
    CardCommentCreate,
    CardCommentResponse,
    CardCommentUpdate,
    CardStatusResponse,
    CardStatusUpdate,
    CommentCountsResponse,
)
from app.services.card_access import require_card_status_write
from app.services.card_status import STATUS_LABELS, apply_status
from app.services.notifications import (
    build_notifications,
    card_assignee_ids,
    dedupe_by_recipient,
    notification_payload,
)
from app.utils import utcnow_naive
from app.websocket.broadcast import broadcast_change, send_notification

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kanban")

CardEntityType = Literal["phase", "subphase"]


# ---------------------------------------------------------
# Helpers
# ---------------------------------------------------------


async def _load_card(
    db: AsyncSession, entity_type: str, entity_id: int
) -> ProjectPhase | ProjectSubphase:
    """Fetch a card (phase or subphase) or raise 404."""
    model = ProjectPhase if entity_type == "phase" else ProjectSubphase
    result = await db.execute(select(model).where(model.id == entity_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail=f"{entity_type.capitalize()} not found")
    return card


def _card_name(card: ProjectPhase | ProjectSubphase) -> str:
    """Phases carry their name in `type`, subphases in `name`."""
    return getattr(card, "name", None) or getattr(card, "type", "") or "card"


def _comment_response(comment: CardComment, author_name: str | None) -> dict:
    return {
        "id": comment.id,
        "entity_type": comment.entity_type,
        "entity_id": comment.entity_id,
        "project_id": comment.project_id,
        "author_id": comment.author_id,
        "author_name": author_name,
        "body": comment.body,
        "mentioned_user_ids": comment.parsed_mentions,
        "edited": comment.is_edited,
        "created_at": comment.created_at,
        "updated_at": comment.updated_at,
    }


async def _push_notifications(request: Request, rows: list) -> None:
    """Deliver already-committed notifications over the WebSocket."""
    for row in rows:
        try:
            await send_notification(request, row.user_id, notification_payload(row))
        except Exception as e:  # never fail the request because a push failed
            logger.warning("Notification push failed for user %s: %s", row.user_id, e)


# ---------------------------------------------------------
# Comment counts
# ---------------------------------------------------------


@router.get("/projects/{project_id}/comment-counts", response_model=CommentCountsResponse)
async def get_comment_counts(
    project_id: int,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(get_current_user),
):
    """
    Comment counts for every card in a project.

    Deliberately its own endpoint: GET /projects/{id} is called once per project
    by loadAllProjects(), so folding counts in there would add a query per
    project on every refresh for data only the Kanban view uses.
    """
    result = await db.execute(
        select(CardComment.entity_type, CardComment.entity_id, func.count(CardComment.id))
        .where(CardComment.project_id == project_id)
        .group_by(CardComment.entity_type, CardComment.entity_id)
    )

    counts: dict[str, dict[str, int]] = {"phase": {}, "subphase": {}}
    for entity_type, entity_id, count in result.all():
        if entity_type in counts:
            counts[entity_type][str(entity_id)] = count

    return counts


# ---------------------------------------------------------
# Status moves
# ---------------------------------------------------------


@router.put("/cards/{entity_type}/{entity_id}/status", response_model=CardStatusResponse)
async def update_card_status(
    entity_type: CardEntityType,
    entity_id: int,
    data: CardStatusUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Move a card to a different status column, keeping completion in step."""
    card = await _load_card(db, entity_type, entity_id)

    await require_card_status_write(
        db,
        entity_type=entity_type,
        entity_id=entity_id,
        user_id=user.id,
        is_privileged=bool(user.is_admin or user.is_superuser),
    )

    previous_status = card.status
    if previous_status == data.status:
        # No-op move (e.g. dropped back into the same column).
        return {"success": True, "status": card.status, "completion": card.completion}

    apply_status(card, data.status)

    # Tell the card's other assignees, staged before the commit so the
    # notification and the move land together.
    assignees = await card_assignee_ids(db, entity_type, entity_id)
    card_name = _card_name(card)
    rows = build_notifications(
        recipient_ids=assignees,
        notification_type="status_change",
        actor_id=user.id,
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=card.project_id,
        title=f"{card_name} moved to {STATUS_LABELS[data.status]}",
        body=f"Was {STATUS_LABELS.get(previous_status, previous_status)}.",
    )
    db.add_all(rows)

    await db.commit()

    await broadcast_change(
        request=request,
        user=user,
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=card.project_id,
        action="update",
        summary=f"{card_name} -> {STATUS_LABELS[data.status]}",
    )
    await _push_notifications(request, rows)

    return {"success": True, "status": card.status, "completion": card.completion}


# ---------------------------------------------------------
# Assignees (assigning also books the staff member's time)
# ---------------------------------------------------------


@router.post(
    "/cards/{entity_type}/{entity_id}/assignees",
    response_model=CardAssigneeResponse,
    status_code=201,
)
async def assign_card(
    entity_type: CardEntityType,
    entity_id: int,
    data: CardAssigneeCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Assign a staff member to a card, booking their time over the card's dates.

    Phase- and subphase-level assignments carry no dates of their own -- they
    inherit the card's -- so the booking stays in step when the card moves in
    the Gantt chart, with no second write.
    """
    card = await _load_card(db, entity_type, entity_id)

    assignee = (await db.execute(select(User).where(User.id == data.staff_id))).scalar_one_or_none()
    if not assignee:
        raise HTTPException(status_code=404, detail="Staff member not found")

    # Branch on the concrete model rather than computing one: a
    # `A if ... else B` variable is a union of model types, and the per-level
    # foreign key (phase_id vs subphase_id) is not resolvable on that union.
    if entity_type == "phase":
        existing_query = select(PhaseStaffAssignment).where(
            PhaseStaffAssignment.phase_id == entity_id,
            PhaseStaffAssignment.staff_id == data.staff_id,
        )
    else:
        existing_query = select(SubphaseStaffAssignment).where(
            SubphaseStaffAssignment.subphase_id == entity_id,
            SubphaseStaffAssignment.staff_id == data.staff_id,
        )

    existing = (await db.execute(existing_query.limit(1))).scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That staff member is already assigned to this card",
        )

    # Resolve the booking size server-side; the client must not guess it.
    allocation = data.allocation if data.allocation is not None else assignee.max_capacity or 100

    assignment: PhaseStaffAssignment | SubphaseStaffAssignment
    if entity_type == "phase":
        assignment = PhaseStaffAssignment(
            project_id=card.project_id,
            staff_id=data.staff_id,
            allocation=allocation,
            phase_id=entity_id,
        )
    else:
        assignment = SubphaseStaffAssignment(
            project_id=card.project_id,
            staff_id=data.staff_id,
            allocation=allocation,
            subphase_id=entity_id,
        )
    db.add(assignment)

    card_name = _card_name(card)
    rows = build_notifications(
        recipient_ids=[data.staff_id],
        notification_type="assigned",
        actor_id=user.id,
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=card.project_id,
        title=f"You were assigned to {card_name}",
        body=f"Booked at {allocation}% over the card's dates.",
    )
    db.add_all(rows)

    await db.commit()
    await db.refresh(assignment)

    await broadcast_change(
        request=request,
        user=user,
        entity_type="staff_assignment",
        entity_id=assignment.id,
        project_id=card.project_id,
        action="create",
        summary=f"{assignee.full_name} assigned to {card_name}",
    )
    await _push_notifications(request, rows)

    return {
        "success": True,
        "id": assignment.id,
        "staff_id": assignment.staff_id,
        "staff_name": assignee.full_name,
        "allocation": assignment.allocation,
    }


@router.delete("/cards/{entity_type}/{entity_id}/assignees/{staff_id}")
async def unassign_card(
    entity_type: CardEntityType,
    entity_id: int,
    staff_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """Remove a staff member from a card, releasing their booking."""
    card = await _load_card(db, entity_type, entity_id)

    if entity_type == "phase":
        query = select(PhaseStaffAssignment).where(
            PhaseStaffAssignment.phase_id == entity_id,
            PhaseStaffAssignment.staff_id == staff_id,
        )
    else:
        query = select(SubphaseStaffAssignment).where(
            SubphaseStaffAssignment.subphase_id == entity_id,
            SubphaseStaffAssignment.staff_id == staff_id,
        )

    assignment = (await db.execute(query.limit(1))).scalar_one_or_none()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    assignment_id = assignment.id
    await db.delete(assignment)
    await db.commit()

    await broadcast_change(
        request=request,
        user=user,
        entity_type="staff_assignment",
        entity_id=assignment_id,
        project_id=card.project_id,
        action="delete",
        summary=f"unassigned from {_card_name(card)}",
    )

    return {"success": True}


# ---------------------------------------------------------
# Comments
# ---------------------------------------------------------


@router.get("/cards/{entity_type}/{entity_id}/comments", response_model=list[CardCommentResponse])
async def get_card_comments(
    entity_type: CardEntityType,
    entity_id: int,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(get_current_user),
):
    """Comment thread for one card, oldest first."""
    result = await db.execute(
        select(CardComment, User.first_name, User.last_name)
        .outerjoin(User, CardComment.author_id == User.id)
        .where(CardComment.entity_type == entity_type, CardComment.entity_id == entity_id)
        .order_by(CardComment.created_at)
    )

    comments = []
    for comment, first_name, last_name in result.all():
        author_name = f"{first_name or ''} {last_name or ''}".strip() or None
        comments.append(_comment_response(comment, author_name))
    return comments


@router.post(
    "/cards/{entity_type}/{entity_id}/comments",
    response_model=CardCommentResponse,
    status_code=201,
)
async def create_card_comment(
    entity_type: CardEntityType,
    entity_id: int,
    data: CardCommentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Post a comment. Open to any authenticated user."""
    card = await _load_card(db, entity_type, entity_id)

    # Never trust the mention list: keep only ids that are real users.
    mentioned: list[int] = []
    if data.mentioned_user_ids:
        valid = await db.execute(select(User.id).where(User.id.in_(set(data.mentioned_user_ids))))
        mentioned = list(valid.scalars().all())

    comment = CardComment(
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=card.project_id,
        author_id=user.id,
        body=data.body,
    )
    comment.set_mentions(mentioned)
    db.add(comment)

    card_name = _card_name(card)
    author_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or "Someone"
    assignees = await card_assignee_ids(db, entity_type, entity_id)

    # A user who is both assigned and mentioned gets the mention only.
    rows = dedupe_by_recipient(
        [
            build_notifications(
                recipient_ids=mentioned,
                notification_type="mention",
                actor_id=user.id,
                entity_type=entity_type,
                entity_id=entity_id,
                project_id=card.project_id,
                title=f"{author_name} mentioned you on {card_name}",
                body=data.body[:200],
            ),
            build_notifications(
                recipient_ids=assignees,
                notification_type="comment",
                actor_id=user.id,
                entity_type=entity_type,
                entity_id=entity_id,
                project_id=card.project_id,
                title=f"{author_name} commented on {card_name}",
                body=data.body[:200],
            ),
        ]
    )
    db.add_all(rows)

    await db.commit()
    await db.refresh(comment)

    await broadcast_change(
        request=request,
        user=user,
        entity_type="card_comment",
        entity_id=comment.id,
        project_id=card.project_id,
        action="create",
        summary=f"commented on {card_name}",
    )
    await _push_notifications(request, rows)

    return _comment_response(comment, author_name)


@router.put("/comments/{comment_id}", response_model=CardCommentResponse)
async def update_card_comment(
    comment_id: int,
    data: CardCommentUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Edit a comment. Authors only."""
    comment = (
        await db.execute(select(CardComment).where(CardComment.id == comment_id))
    ).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    if comment.author_id != user.id:
        raise HTTPException(status_code=403, detail="You can only edit your own comments")

    comment.body = data.body
    comment.updated_at = utcnow_naive()
    await db.commit()
    await db.refresh(comment)

    await broadcast_change(
        request=request,
        user=user,
        entity_type="card_comment",
        entity_id=comment.id,
        project_id=comment.project_id,
        action="update",
        summary="edited a comment",
    )

    author_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or None
    return _comment_response(comment, author_name)


@router.delete("/comments/{comment_id}")
async def delete_card_comment(
    comment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete a comment. Authors, plus admins and superusers for moderation."""
    comment = (
        await db.execute(select(CardComment).where(CardComment.id == comment_id))
    ).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    if comment.author_id != user.id and not (user.is_admin or user.is_superuser):
        raise HTTPException(status_code=403, detail="You can only delete your own comments")

    project_id = comment.project_id
    await db.execute(delete(CardComment).where(CardComment.id == comment_id))
    await db.commit()

    await broadcast_change(
        request=request,
        user=user,
        entity_type="card_comment",
        entity_id=comment_id,
        project_id=project_id,
        action="delete",
        summary="deleted a comment",
    )

    return {"success": True}
