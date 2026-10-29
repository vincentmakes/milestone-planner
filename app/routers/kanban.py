"""
Kanban board API routes, and the comment threads.

The board itself has no read endpoint: GET /projects/{id} already returns the
whole phase/subphase tree, so the client derives cards from data it already
holds. What lives here is everything that tree does not carry -- status moves,
card assignees (which also book staff time), and comments. A comment thread
hangs on a card (phase / subphase, shared by the Kanban card dialog and the
booking dialog of that card) or, since 2.0.0, on a project (the thread of its
project-level bookings, shown in their booking dialog).

Auth note: moving a card needs ``kanban.move_any`` (the project's manager holds
it through the PM bundle, see app/services/project_access.py), or
``kanban.move_assigned`` for a card the user is an approved assignee of (see
app/services/card_access.py). Assigning and unassigning follow the
staff-assignment rule: ``assignments.manage_others`` (or the PM) manages
anyone, and ``assignments.self_create`` / ``self_remove`` let a user join or
leave a card themself -- in approval mode as an approval request (202, see
app/services/approvals.py); a pending joiner is not an assignee yet (cannot
move the card, is not notified as one). Commenting needs ``kanban.comment``; deleting someone
else's comment ``kanban.moderate_comments``. Reading a thread and the list of
mentionable users need no key (comments are not Kanban-only: project and site
visibility suffice); the comment counts, used by the board only, need
``views.kanban``. Every route works only on projects and sites the user can
see (``site_access``).
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, get_db_readonly
from app.middleware.auth import get_current_user, require_permission
from app.models.assignment import PhaseStaffAssignment, SubphaseStaffAssignment
from app.models.card_comment import CardComment
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.rbac import Role, RolePermission
from app.models.user import User, UserSite
from app.schemas.base import serialize_date_as_datetime_js
from app.schemas.kanban import (
    CardAssigneeCreate,
    CardAssigneeResponse,
    CardCommentCreate,
    CardCommentResponse,
    CardCommentUpdate,
    CardStatusResponse,
    CardStatusUpdate,
    CommentCountsResponse,
    MentionableUserResponse,
)
from app.services import approvals, change_notifications
from app.services.approvals import ACTION_CREATE, ACTION_REMOVE, booking_dict, booking_values
from app.services.booking_segments import effective_dates
from app.services.card_access import require_card_status_write
from app.services.card_comments import build_comment_notifications, new_comment
from app.services.card_comments import validate_mention_ids as _validate_mention_ids
from app.services.card_status import STATUS_LABELS, apply_status
from app.services.mentions import comment_preview
from app.services.notifications import (
    build_notifications,
    card_assignee_ids,
    notification_payload,
)
from app.services.permissions import ADMIN_ROLE_KEY, permission_required_detail
from app.services.project_access import (
    NOT_BOOKABLE_DETAIL,
    STAFF_NOT_FOUND_DETAIL,
    can_on_project,
    resolve_self_booking,
)
from app.services.site_access import ensure_project_visible, ensure_site_visible
from app.utils import utcnow_naive
from app.websocket.broadcast import broadcast_change, send_notification

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kanban")

CardEntityType = Literal["phase", "subphase"]
# What a comment thread hangs on (app/models/card_comment.COMMENT_ENTITY_TYPES).
CommentEntityType = Literal["phase", "subphase", "project"]

# The board's own reads: the comment counts.
require_kanban_view = require_permission("views.kanban")

# No fallback: an entity type that is not a card is never read as a subphase.
_CARD_MODELS: dict[str, type[ProjectPhase] | type[ProjectSubphase]] = {
    "phase": ProjectPhase,
    "subphase": ProjectSubphase,
}

# The per-person DELETE removes one booking; a person holding several
# segments on the card is removed segment by segment (the per-row routes).
SEVERAL_BOOKINGS_DETAIL = "This person has several bookings on this card — remove them one by one"


# ---------------------------------------------------------
# Helpers
# ---------------------------------------------------------


async def _load_card(
    db: AsyncSession, entity_type: str, entity_id: int
) -> ProjectPhase | ProjectSubphase:
    """Fetch a card (phase or subphase) or raise 404."""
    model = _CARD_MODELS[entity_type]
    result = await db.execute(select(model).where(model.id == entity_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail=f"{entity_type.capitalize()} not found")
    return card


def _card_name(card: ProjectPhase | ProjectSubphase) -> str:
    """Phases carry their name in `type`, subphases in `name`."""
    return getattr(card, "name", None) or getattr(card, "type", "") or "card"


async def _load_comment_target(
    db: AsyncSession, entity_type: CommentEntityType, entity_id: int
) -> tuple[int, str, bool]:
    """``(project_id, name, archived)`` of a thread's target, or 404.

    A project thread's ``entity_id`` is the project id; a card's row comes with
    its project's ``archived`` flag in the same query. One branch per type, no
    fallback.
    """
    if entity_type == "project":
        project = (
            await db.execute(select(Project).where(Project.id == entity_id))
        ).scalar_one_or_none()
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return project.id, project.name or "project", bool(project.archived)
    model = _CARD_MODELS[entity_type]
    row = (
        await db.execute(
            select(model, Project.archived)
            .join(Project, Project.id == model.project_id)
            .where(model.id == entity_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail=f"{entity_type.capitalize()} not found")
    card, archived = row
    return card.project_id, _card_name(card), bool(archived)


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
    request: Request,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(require_kanban_view),
):
    """
    Comment counts for every card in a project (``views.kanban``; 403 outside
    the visible sites).

    Deliberately its own endpoint: GET /projects/{id} is called once per project
    by loadAllProjects(), so folding counts in there would add a query per
    project on every refresh for data only the Kanban view uses.
    """
    await ensure_project_visible(request, db, user, project_id)
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


@router.get("/sites/{site_id}/comment-counts", response_model=CommentCountsResponse)
async def get_site_comment_counts(
    site_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(require_kanban_view),
):
    """Comment counts for every card in a visible site (403 otherwise), in one
    query (``views.kanban``).

    The board's "All projects" mode would otherwise fire one request per
    project.
    """
    await ensure_site_visible(request, db, user, site_id)
    result = await db.execute(
        select(CardComment.entity_type, CardComment.entity_id, func.count(CardComment.id))
        .join(Project, CardComment.project_id == Project.id)
        .where(Project.site_id == site_id)
        .group_by(CardComment.entity_type, CardComment.entity_id)
    )

    counts: dict[str, dict[str, int]] = {"phase": {}, "subphase": {}}
    for entity_type, entity_id, count in result.all():
        if entity_type in counts:
            counts[entity_type][str(entity_id)] = count

    return counts


@router.get("/sites/{site_id}/mentionable-users", response_model=list[MentionableUserResponse])
async def get_mentionable_users(
    site_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(get_current_user),
):
    """Everyone who can be @-mentioned in a comment thread at this site.

    Deliberately not GET /staff, which excludes administrators and so left the
    person most likely to need pinging -- the project manager -- unmentionable.

    Two groups qualify:
      - active members of the site, whatever their role;
      - active users whose role sees every site (the administrators, and any
        role allowing ``sites.view_all``). They are often given one user_sites
        row only, so joining on membership alone would hide them on every
        other site.

    Needs a visible site (403), no key: the picker serves every comment thread
    (the Kanban card dialog and the booking dialog alike). Only the fields a
    mention picker needs are returned.
    """
    await ensure_site_visible(request, db, user, site_id)
    site_member_ids = select(UserSite.user_id).where(UserSite.site_id == site_id)
    all_sites_roles = (
        select(Role.key)
        .join(RolePermission, RolePermission.role_id == Role.id)
        .where(RolePermission.permission == "sites.view_all", RolePermission.mode == "allow")
    )
    result = await db.execute(
        select(User)
        .where(
            User.active == 1,
            or_(
                User.id.in_(site_member_ids),
                User.role == ADMIN_ROLE_KEY,
                User.role.in_(all_sites_roles),
            ),
        )
        .order_by(User.first_name, User.last_name)
    )

    return [
        {"id": u.id, "name": u.full_name, "job_title": u.job_title}
        for u in result.scalars().unique().all()
    ]


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
    await ensure_project_visible(request, db, user, card.project_id)

    # kanban.move_any (or the PM through the bundle) moves any card; otherwise
    # kanban.move_assigned moves the cards the user is an approved assignee of.
    await require_card_status_write(
        db,
        entity_type=entity_type,
        entity_id=entity_id,
        user_id=user.id,
        can_move_any=await can_on_project(db, user, "kanban.move_any", card.project_id),
        can_move_assigned=user.permissions.has("kanban.move_assigned"),
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
    user: User = Depends(get_current_user),
):
    """
    Assign a staff member to a card, booking their time on it.

    ``assignments.manage_others`` (or the PM) assigns anyone; a user joins a
    card themself under ``assignments.self_create``.

    The booking is dateless, so the server places it (``approvals.plan_placement``
    with ``link_first=False``): a person not on the card yet gets an
    **unpinned** booking over the card's own dates (as the Assign Staff dialog
    sends; clipped, not stretched, when the card moves -- pinning it to the
    card is a Gantt action); someone already on it gets the largest free
    stretch of the card, or the second half when one booking of theirs covers
    the whole card (that booking keeps the first half, listed in
    ``adjusted``); a covered card is 409 ``CARD_FULL_DETAIL``, a booking to
    split that awaits approval 409 ``ALREADY_PENDING_DETAIL``. Removing a
    person who holds several bookings goes booking by booking (the per-row
    routes; the per-person DELETE answers 409).
    """
    card = await _load_card(db, entity_type, entity_id)
    await ensure_project_visible(request, db, user, card.project_id)
    outcome = await resolve_self_booking(
        db,
        user,
        project_id=card.project_id,
        staff_id=data.staff_id,
        action=ACTION_CREATE,
    )

    # Same rule as require_bookable_staff, on the row loaded for the allocation.
    assignee = (await db.execute(select(User).where(User.id == data.staff_id))).scalar_one_or_none()
    if not assignee:
        raise HTTPException(status_code=404, detail=STAFF_NOT_FOUND_DETAIL)
    if assignee.is_resource is False:
        raise HTTPException(status_code=400, detail=NOT_BOOKABLE_DETAIL)

    # Placed by the server under the card's lock: a first booking spans the
    # card with its own dates (unpinned), a second one takes a free stretch
    # or half of a full-span booking; a covered card (or a pending booking to
    # split) is a 409.
    plan = approvals.require_placement(
        await approvals.plan_placement(db, entity_type, entity_id, data.staff_id, link_first=False)
    )

    # Resolve the booking size server-side; the client must not guess it.
    allocation = data.allocation if data.allocation is not None else assignee.max_capacity or 100
    # A first booking carries plain dates (as from the dialog): an approval
    # re-checks their overlap; only a real placement is re-planned on approve.
    values = booking_dict(
        allocation,
        plan.start_date,
        plan.end_date,
        placement=None if plan.first else approvals.AUTO_PLACEMENT,
    )
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_CREATE,
            level=entity_type,
            project_id=card.project_id,
            target_id=entity_id,
            values=values,
        )

    card_name = _card_name(card)
    effects = approvals.ApprovalEffects()
    # The shortened booking's person intent is dropped (already_notified):
    # the ``assigned`` body below names it.
    shrink_intents = await approvals.apply_shrink(
        db, user, level=entity_type, plan=plan, effects=effects
    )
    assignment: PhaseStaffAssignment | SubphaseStaffAssignment
    if entity_type == "phase":
        assignment = PhaseStaffAssignment(
            project_id=card.project_id,
            staff_id=data.staff_id,
            allocation=allocation,
            phase_id=entity_id,
            start_date=plan.start_date,
            end_date=plan.end_date,
        )
    else:
        assignment = SubphaseStaffAssignment(
            project_id=card.project_id,
            staff_id=data.staff_id,
            allocation=allocation,
            subphase_id=entity_id,
            start_date=plan.start_date,
            end_date=plan.end_date,
        )
    db.add(assignment)

    # The person gets the ``assigned`` notification below; the PM a change one.
    intents = change_notifications.booking_intents(
        user,
        kind="create",
        level=entity_type,
        project_id=card.project_id,
        target_id=entity_id,
        staff_id=data.staff_id,
        values=values,
        target_name=card_name,
        person_name=assignee.full_name,
    )
    rows = build_notifications(
        recipient_ids=[data.staff_id],
        notification_type="assigned",
        actor_id=user.id,
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=card.project_id,
        title=f"You were assigned to {card_name}",
        body=approvals.placement_body(allocation, plan),
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
    # The shortened row's update change (and a request it overtook).
    await approvals.publish(request, user, effects)
    await change_notifications.deliver(
        db, request, user.id, intents + shrink_intents, already_notified={data.staff_id}
    )

    start, end, linked = effective_dates(
        assignment.start_date, assignment.end_date, card.start_date, card.end_date
    )
    return {
        "success": True,
        "id": assignment.id,
        "staff_id": assignment.staff_id,
        "staff_name": assignee.full_name,
        "allocation": assignment.allocation,
        "start_date": serialize_date_as_datetime_js(start),
        "end_date": serialize_date_as_datetime_js(end),
        "linked": linked,
        "adjusted": approvals.adjusted_rows(plan),
    }


@router.delete("/cards/{entity_type}/{entity_id}/assignees/{staff_id}")
async def unassign_card(
    entity_type: CardEntityType,
    entity_id: int,
    staff_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Remove a staff member from a card, releasing their booking.

    ``assignments.manage_others`` (or the PM) removes anyone; a user leaves a
    card themself under ``assignments.self_remove``. A person holding several
    segments on the card is a 409 (``SEVERAL_BOOKINGS_DETAIL``): remove them
    one by one through ``/phase-staff/{id}`` / ``/subphase-staff/{id}``.
    """
    card = await _load_card(db, entity_type, entity_id)
    await ensure_project_visible(request, db, user, card.project_id)
    outcome = None
    if staff_id != user.id:
        # Someone else's booking: 403 without editor rights, before the lookup.
        outcome = await resolve_self_booking(
            db,
            user,
            project_id=card.project_id,
            staff_id=staff_id,
            action=ACTION_REMOVE,
        )

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

    found = (await db.execute(query.limit(2))).scalars().all()
    if not found:
        raise HTTPException(status_code=404, detail="Assignment not found")
    if len(found) > 1:
        raise HTTPException(status_code=409, detail=SEVERAL_BOOKINGS_DETAIL)
    assignment = found[0]

    outcome = await approvals.resolve_row_write(
        db, user, row=assignment, action=ACTION_REMOVE, outcome=outcome
    )
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_REMOVE,
            level=entity_type,
            project_id=card.project_id,
            row=assignment,
        )
    effects = await approvals.expire_overtaken(db, user, level=entity_type, row=assignment)
    intents = change_notifications.booking_intents(
        user,
        kind="remove",
        level=entity_type,
        project_id=card.project_id,
        target_id=entity_id,
        staff_id=staff_id,
        previous=booking_values(assignment, entity_type),
        target_name=_card_name(card),
    )

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
    await approvals.publish(request, user, effects)
    await change_notifications.deliver(db, request, user.id, intents)

    return {"success": True}


# ---------------------------------------------------------
# Comments
# ---------------------------------------------------------


@router.get("/cards/{entity_type}/{entity_id}/comments", response_model=list[CardCommentResponse])
async def get_card_comments(
    entity_type: CommentEntityType,
    entity_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(get_current_user),
):
    """Comment thread of a card or a project, oldest first.

    No key: seeing the project is enough (403 outside the visible sites, 404
    for an unknown target); an archived project's threads need
    ``views.archived``, like ``GET /projects/{id}``."""
    project_id, _, archived = await _load_comment_target(db, entity_type, entity_id)
    await ensure_project_visible(request, db, user, project_id)
    if archived and not user.permissions.has("views.archived"):
        raise HTTPException(status_code=403, detail=permission_required_detail("views.archived"))
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
    entity_type: CommentEntityType,
    entity_id: int,
    data: CardCommentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("kanban.comment")),
):
    """Post a comment on a card or a project thread (``kanban.comment``).

    Notifies the mentioned users (``mention``) and the target's approved
    assignees -- the card's, or for a project thread the project-level
    bookings' (``comment``); the notifications carry the thread's entity
    (``project`` / project id for a project thread)."""
    project_id, card_name, _ = await _load_comment_target(db, entity_type, entity_id)
    await ensure_project_visible(request, db, user, project_id)

    mentioned = await _validate_mention_ids(db, data.body)
    comment = new_comment(
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=project_id,
        author_id=user.id,
        body=data.body,
        mentioned=mentioned,
    )
    db.add(comment)

    author_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or "Someone"
    assignees = await card_assignee_ids(db, entity_type, entity_id)

    rows = build_comment_notifications(
        mentioned=mentioned,
        assignees=assignees,
        actor_id=user.id,
        actor_name=author_name,
        entity_type=entity_type,
        entity_id=entity_id,
        project_id=project_id,
        card_name=card_name,
        preview=comment_preview(data.body),
    )
    db.add_all(rows)

    await db.commit()
    await db.refresh(comment)

    await broadcast_change(
        request=request,
        user=user,
        entity_type="card_comment",
        entity_id=comment.id,
        project_id=project_id,
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
    user: User = Depends(require_permission("kanban.comment")),
):
    """Edit a comment: its author only, with ``kanban.comment``."""
    comment = (
        await db.execute(select(CardComment).where(CardComment.id == comment_id))
    ).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    await ensure_project_visible(request, db, user, comment.project_id)

    if comment.author_id != user.id:
        raise HTTPException(status_code=403, detail="You can only edit your own comments")

    # Mentions live in the body, so an edit can add or remove them. Without
    # re-deriving, editing in a new mention would render a pill that notified
    # nobody and leave the stored list contradicting the text.
    previously_mentioned = set(comment.parsed_mentions)
    mentioned = await _validate_mention_ids(db, data.body)

    comment.body = data.body
    comment.set_mentions(mentioned)
    comment.updated_at = utcnow_naive()

    author_name = f"{user.first_name or ''} {user.last_name or ''}".strip() or "Someone"
    newly_mentioned = [uid for uid in mentioned if uid not in previously_mentioned]
    rows = build_notifications(
        recipient_ids=newly_mentioned,
        notification_type="mention",
        actor_id=user.id,
        entity_type=comment.entity_type,
        entity_id=comment.entity_id,
        project_id=comment.project_id,
        title=f"{author_name} mentioned you in a comment",
        body=comment_preview(data.body),
    )
    db.add_all(rows)

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
    await _push_notifications(request, rows)

    return _comment_response(comment, author_name or None)


@router.delete("/comments/{comment_id}")
async def delete_card_comment(
    comment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete a comment: its author with ``kanban.comment``, anyone's with
    ``kanban.moderate_comments``."""
    comment = (
        await db.execute(select(CardComment).where(CardComment.id == comment_id))
    ).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    await ensure_project_visible(request, db, user, comment.project_id)

    if comment.author_id == user.id:
        if not (
            user.permissions.has("kanban.comment")
            or user.permissions.has("kanban.moderate_comments")
        ):
            raise HTTPException(
                status_code=403, detail=permission_required_detail("kanban.comment")
            )
    elif not user.permissions.has("kanban.moderate_comments"):
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
