"""
The approval workflow for own bookings (``assignments.self_*`` in approval mode).

A user whose role holds an ``assignments.self_*`` key in **approval** mode does
not write their own staff assignment directly: the write becomes an
``approval_requests`` row that an eligible approver approves or rejects. The
server decides (``project_access.resolve_self_booking``, editor first), and
the eleven self-booking routes (project / phase / subphase create, update,
delete and the Kanban join / leave) answer **202**
``{success: true, pending: true, request_id, id}`` through ``submit_request``.

What the three actions store:

- **create** (``assignments.self_create``): a real assignment row with
  ``approval_status = 'pending'`` (shown at once, never counted in capacity,
  availability, card access or assignee notifications) and the request,
  linked both ways (``approval_request_id`` / ``assignment_id``);
- **update** (``assignments.self_update``): the request holds ``requested``
  and the ``previous`` values; the row is unchanged and points at it;
- **remove** (``assignments.self_remove``): the request holds ``previous``;
  the row stays and points at it.

A second request on the same row by the same requester supersedes the open
one (``superseded`` + ``superseded_by_id``); a create on a target already
booked (pending or approved) is a 409 -- except a **dateless** create on a
phase / subphase, which is placed automatically (``plan_placement``: the
largest free stretch of the card, else the halving of the one booking
covering it, else 409 ``CARD_FULL_DETAIL``) and carries
``placement: "auto"`` in its values; an update of the requester's own
pending create edits it in place, and its removal cancels it.

Statuses: ``pending`` -> ``approved`` | ``rejected`` | ``cancelled`` |
``superseded`` | ``expired`` (``close_reason``: ``target_deleted``,
``requester_inactive``, ``permission_lost``, ``overtaken``, ``duplicate``).
Terminal states never change; a decision on one is a 409 with the status.

Approvers (``approver_user_ids`` / ``can_decide``) are resolved live, never
stored: the admins always; the project's manager when the action's policy has
``pm_approves``; holders of the policy's roles -- active users who can see the
project's site, never the requester. ``approve`` re-validates inside its
transaction and closes the request ``expired(<reason>)`` (409 to the caller)
when the booking can no longer be applied; an auto-placed create is
**re-planned** there (the person's approved bookings only) and the split or
the gap is applied then -- the full-span booking is left alone until the
decision.

Every transition broadcasts ``change:approval_request`` (approve / reject also
``change:staff_assignment``), notifies the requester or the approvers, and
pushes ``approval:changed`` to the requester and the eligible approvers
(``publish``, after the commit).
"""

import json
import logging
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Any, Literal

from fastapi import HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.notification import Notification
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.rbac import ApprovalPolicy, ApprovalRequest, Role, RolePermission
from app.models.user import User, UserSite
from app.schemas.base import serialize_date_as_datetime_js
from app.services.booking_segments import (
    Segment,
    effective_dates,
    fit_segments_to_card,
    place_booking,
    segments_overlap,
)
from app.services.notifications import build_notifications, notification_payload
from app.services.permissions import (
    ADMIN_ROLE_KEY,
    load_permission_set,
    permission_required_detail,
)
from app.services.project_access import (
    MANAGE_OTHERS_KEY,
    BookingOutcome,
    resolve_self_booking,
)
from app.services.site_access import site_is_visible, visible_site_ids, visible_sites_clause
from app.utils import utcnow_naive
from app.websocket.broadcast import broadcast_change, send_notification, send_user_event

if TYPE_CHECKING:
    from app.services.change_notifications import ChangeIntent

logger = logging.getLogger(__name__)

ACTION_CREATE = "assignments.self_create"
ACTION_UPDATE = "assignments.self_update"
ACTION_REMOVE = "assignments.self_remove"

Level = Literal["project", "phase", "subphase"]
AssignmentRow = ProjectAssignment | PhaseStaffAssignment | SubphaseStaffAssignment

AWAITS_APPROVAL_DETAIL = "This booking awaits approval — approve or reject it instead"
ALREADY_BOOKED_DETAIL = "That staff member is already booked here"
ALREADY_BOOKED_OVERLAP_DETAIL = "This person is already booked on this card for overlapping dates"
ALREADY_PENDING_DETAIL = "This booking already awaits approval"
REQUEST_NOT_FOUND_DETAIL = "Approval request not found"
OWN_REQUEST_DETAIL = "You cannot approve your own request"
NOT_DECIDER_DETAIL = "You are not an approver of this request"
CANCEL_FORBIDDEN_DETAIL = "Only the requester or an administrator can cancel this request"
INVALID_VALUES_DETAIL = "The requested values are not valid — reject the request instead"
CARD_FULL_DETAIL = "This person's bookings already cover the whole card — shorten one of them first"

# Marker of a dateless create placed by the server (``plan_placement``), kept
# in the request's ``requested`` so ``approve`` re-plans it.
AUTO_PLACEMENT = "auto"

# Why a request expired, in words (409 detail and the requester's notification).
CLOSE_REASON_DETAILS: dict[str, str] = {
    "target_deleted": "the card or project it was about was deleted",
    "requester_inactive": "the requester's account is no longer active",
    "permission_lost": "the requester may no longer book themself there",
    "overtaken": "the booking was changed since the request was made",
    "duplicate": "the requester is already booked there",
}

# "Your <subject> ..." in the requester's decision notifications.
_SUBJECTS = {
    ACTION_CREATE: "Your booking on {target}",
    ACTION_UPDATE: "Your change to {target}",
    ACTION_REMOVE: "Your removal from {target}",
}

_TITLE_MAX = 200


# ---------------------------------------------------------
# Booking values and rows
# ---------------------------------------------------------


def assignment_model(
    level: str,
) -> type[ProjectAssignment] | type[PhaseStaffAssignment] | type[SubphaseStaffAssignment]:
    """The assignment table of a request level."""
    if level == "project":
        return ProjectAssignment
    if level == "phase":
        return PhaseStaffAssignment
    return SubphaseStaffAssignment


def row_target_id(row: AssignmentRow, level: str) -> int:
    """The project, phase or subphase a row books (by level)."""
    if level == "phase":
        return row.phase_id  # type: ignore[union-attr,no-any-return]
    if level == "subphase":
        return row.subphase_id  # type: ignore[union-attr,no-any-return]
    return row.project_id


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, date) else value


def booking_dict(
    allocation: int,
    start_date: date | str | None = None,
    end_date: date | str | None = None,
    *,
    clear_dates: bool = False,
    placement: str | None = None,
) -> dict[str, Any]:
    """
    Booking values as stored in a request: dates as ``YYYY-MM-DD``, present
    when given (project level, or an unlinked phase / subphase segment).
    ``clear_dates`` emits ``"start_date": null, "end_date": null`` -- a
    segment relinked to its card -- where "no dates" would mean "unchanged".
    ``placement`` (``AUTO_PLACEMENT``) marks a dateless create the server
    placed; every reader of the values ignores the key but ``approve``.
    """
    values: dict[str, Any] = {"allocation": allocation}
    if start_date is not None or end_date is not None or clear_dates:
        values["start_date"] = _iso(start_date)
        values["end_date"] = _iso(end_date)
    if placement is not None:
        values["placement"] = placement
    return values


def is_auto_placed(values: dict[str, Any] | None) -> bool:
    """Whether stored request values carry the ``placement: "auto"`` marker."""
    return values is not None and values.get("placement") == AUTO_PLACEMENT


def booking_values(row: AssignmentRow, level: str) -> dict[str, Any]:
    """
    A row's current booking values: dates at project level, and at phase /
    subphase level the row's own dates when it is an unlinked segment
    (nothing for a linked row, which follows its card).
    """
    return booking_dict(row.allocation, row.start_date, row.end_date)


def parse_values(text: str | None) -> dict[str, Any] | None:
    """A request's ``requested`` / ``previous`` JSON, or None."""
    if not text:
        return None
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _dump(values: dict[str, Any] | None) -> str | None:
    return None if values is None else json.dumps(values, sort_keys=True)


def _day(value: Any) -> date | None:
    """A stored ``YYYY-MM-DD`` value as a date (None stays None)."""
    return None if value is None else date.fromisoformat(value)


def _values_valid(
    level: str, values: dict[str, Any] | None, context: "RequestContext | None" = None
) -> bool:
    """
    Allocation 1..100 and ordered ISO dates: required at project level; on a
    phase / subphase optional -- absent (linked, or unchanged), both null (a
    relink), or both given and within the card's current dates (``context``).
    """
    if not values:
        return False
    allocation = values.get("allocation")
    if not isinstance(allocation, int) or not 1 <= allocation <= 100:
        return False
    if level != "project":
        if "start_date" not in values and "end_date" not in values:
            return True
        if values.get("start_date") is None and values.get("end_date") is None:
            return True
    try:
        start = date.fromisoformat(values["start_date"])
        end = date.fromisoformat(values["end_date"])
    except (KeyError, TypeError, ValueError):
        return False
    if start > end:
        return False
    if level == "project" or context is None:
        return True
    if context.target_start is None or context.target_end is None:
        return False
    return context.target_start <= start and end <= context.target_end


def _write_values(row: AssignmentRow, level: str, values: dict[str, Any]) -> None:
    """
    Apply booking values: the dates at every level when present -- explicit
    nulls clear a segment's own dates (relinked to its card), absent keys
    leave them.
    """
    row.allocation = values["allocation"]
    if "start_date" in values:
        row.start_date = _day(values["start_date"])  # type: ignore[assignment]
    if "end_date" in values:
        row.end_date = _day(values["end_date"])  # type: ignore[assignment]


def _new_row(
    level: str, *, project_id: int, target_id: int, staff_id: int, values: dict[str, Any]
) -> AssignmentRow:
    row: AssignmentRow
    if level == "project":
        row = ProjectAssignment(
            project_id=project_id,
            staff_id=staff_id,
            allocation=values["allocation"],
            start_date=date.fromisoformat(values["start_date"]),
            end_date=date.fromisoformat(values["end_date"]),
        )
    elif level == "phase":
        row = PhaseStaffAssignment(
            project_id=project_id,
            phase_id=target_id,
            staff_id=staff_id,
            allocation=values["allocation"],
            start_date=_day(values.get("start_date")),
            end_date=_day(values.get("end_date")),
        )
    else:
        row = SubphaseStaffAssignment(
            project_id=project_id,
            subphase_id=target_id,
            staff_id=staff_id,
            allocation=values["allocation"],
            start_date=_day(values.get("start_date")),
            end_date=_day(values.get("end_date")),
        )
    row.approval_status = "pending"
    return row


async def find_duplicate(
    db: AsyncSession,
    level: str,
    target_id: int,
    staff_id: int,
    *,
    start_date: date | None = None,
    end_date: date | None = None,
    exclude_id: int | None = None,
    approved_only: bool = False,
) -> AssignmentRow | None:
    """
    An existing booking of `staff_id` on the target (pending rows included
    unless `approved_only`). At project level only an exact duplicate (same
    dates) counts. On a phase / subphase a person may hold several
    non-overlapping segments: a row conflicts when its **effective** dates
    (own dates, else the card's) overlap those of the new / changed row --
    `start_date` / `end_date` here, None = linked (the whole card). A linked
    row spans its card, so it conflicts with every other row of the person
    there. One query: the card's dates come from a join.
    """
    query: Any
    if level == "project":
        query = select(ProjectAssignment).where(
            ProjectAssignment.project_id == target_id,
            ProjectAssignment.staff_id == staff_id,
            ProjectAssignment.start_date == start_date,
            ProjectAssignment.end_date == end_date,
        )
        model: Any = ProjectAssignment
    else:
        card: Any
        if level == "phase":
            model, card = PhaseStaffAssignment, ProjectPhase
            on_card = PhaseStaffAssignment.phase_id
        else:
            model, card = SubphaseStaffAssignment, ProjectSubphase
            on_card = SubphaseStaffAssignment.subphase_id
        new_start = start_date if start_date is not None else card.start_date
        new_end = end_date if end_date is not None else card.end_date
        query = (
            select(model)
            .join(card, card.id == on_card)
            .where(
                on_card == target_id,
                model.staff_id == staff_id,
                # Inclusive-day overlap (booking_segments.segments_overlap).
                func.coalesce(model.start_date, card.start_date) <= new_end,
                func.coalesce(model.end_date, card.end_date) >= new_start,
            )
        )
    if exclude_id is not None:
        query = query.where(model.id != exclude_id)
    if approved_only:
        query = query.where(model.approval_status == "approved")
    found: AssignmentRow | None = (await db.execute(query.limit(1))).scalar_one_or_none()
    return found


async def ensure_no_duplicate(
    db: AsyncSession,
    level: str,
    target_id: int,
    staff_id: int,
    *,
    start_date: date | None = None,
    end_date: date | None = None,
    exclude_id: int | None = None,
    detail: str | None = None,
) -> None:
    """
    409 when the person is already booked on the target (a pending booking
    counts) -- on a phase / subphase, for overlapping dates (`find_duplicate`;
    `exclude_id` = the row being changed). `detail` overrides the default text
    (``ALREADY_BOOKED_DETAIL`` at project level, else
    ``ALREADY_BOOKED_OVERLAP_DETAIL``).
    """
    existing = await find_duplicate(
        db,
        level,
        target_id,
        staff_id,
        start_date=start_date,
        end_date=end_date,
        exclude_id=exclude_id,
    )
    if existing is None:
        return
    if existing.approval_status == "pending":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ALREADY_PENDING_DETAIL)
    if detail is None:
        detail = ALREADY_BOOKED_DETAIL if level == "project" else ALREADY_BOOKED_OVERLAP_DETAIL
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


# ---------------------------------------------------------
# Automatic placement of a dateless phase / subphase booking
# ---------------------------------------------------------


@dataclass(frozen=True)
class PlannedBooking:
    """
    Where a new phase / subphase booking goes: its own dates (None / None =
    linked, the person has no row on the card) and, for a split, the
    full-span row to shorten (``shrink``) with its new dates (``shrink_to``)
    and its effective dates before (``shrink_from``, for the texts).
    """

    start_date: date | None
    end_date: date | None
    shrink: AssignmentRow | None = None
    shrink_to: Segment | None = None
    shrink_from: Segment | None = None


# Why there is no room: the person's bookings cover the card, or the one
# full-span booking to split is itself awaiting approval.
PlacementRefusal = Literal["card_full", "pending_row"]


async def plan_placement(
    db: AsyncSession,
    level: str,
    target_id: int,
    staff_id: int,
    *,
    exclude_id: int | None = None,
    approved_only: bool = False,
) -> PlannedBooking | PlacementRefusal:
    """
    Plan a **dateless** booking of `staff_id` on a phase / subphase. Never
    raises (``require_placement`` turns a refusal into the 409).

    One query: the card's dates (NOT NULL columns) with every row of the
    person on the card, the rows locked ``FOR UPDATE`` so two concurrent
    dateless creates cannot both halve the same row. `exclude_id` leaves out
    the pending row being approved; `approved_only` counts only approved rows
    (at approve time pending rows of other requests do not hold space; at
    submit and on a direct create every row does).

    No row -> linked (None / None). Otherwise ``place_booking`` on the rows'
    effective dates: the largest free stretch, else the halving of the one
    row covering the card (``shrink``) -- refused ``"pending_row"`` when that
    row awaits approval (nobody rewrites a requested booking) -- else
    ``"card_full"``.
    """
    model: Any = assignment_model(level)
    card: Any = ProjectPhase if level == "phase" else ProjectSubphase
    on_card = model.phase_id if level == "phase" else model.subphase_id
    query = (
        select(card.start_date, card.end_date, model)
        .select_from(card)
        .join(model, on_card == card.id)
        .where(card.id == target_id, model.staff_id == staff_id)
    )
    if exclude_id is not None:
        query = query.where(model.id != exclude_id)
    if approved_only:
        query = query.where(model.approval_status == "approved")
    found = (await db.execute(query.order_by(model.id).with_for_update(of=model))).all()
    if not found:
        return PlannedBooking(None, None)

    card_start, card_end = found[0][0], found[0][1]
    spans: list[tuple[AssignmentRow, date, date]] = []
    for _start, _end, row in found:
        start, end, _linked = effective_dates(row.start_date, row.end_date, card_start, card_end)
        spans.append((row, start, end))
    placed = place_booking(card_start, card_end, [(start, end) for _, start, end in spans])
    if placed is None:
        return "card_full"
    new_start, new_end, shrink_to = placed
    if shrink_to is None:
        return PlannedBooking(new_start, new_end)
    # A split: exactly one row lies on the card (place_booking's rule).
    row, start, end = next(
        span for span in spans if segments_overlap(span[1], span[2], card_start, card_end)
    )
    if row.approval_status == "pending":
        return "pending_row"
    return PlannedBooking(
        new_start, new_end, shrink=row, shrink_to=shrink_to, shrink_from=(start, end)
    )


def require_placement(plan: PlannedBooking | PlacementRefusal) -> PlannedBooking:
    """
    The routes' side of ``plan_placement``: 409 ``CARD_FULL_DETAIL`` when the
    person's bookings cover the card, 409 ``ALREADY_PENDING_DETAIL`` when the
    booking to split awaits approval.
    """
    if plan == "card_full":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=CARD_FULL_DETAIL)
    if plan == "pending_row":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ALREADY_PENDING_DETAIL)
    assert not isinstance(plan, str)
    return plan


def placement_body(allocation: int, plan: PlannedBooking) -> str:
    """
    The booked person's text for a placed booking: the dates that landed
    (or the card's, linked) and, after a split, their shortened booking.
    """
    if plan.start_date is None or plan.end_date is None:
        text = f"Booked at {allocation}% over the card's dates."
    else:
        text = f"Booked at {allocation}% from {plan.start_date} to {plan.end_date}."
    if plan.shrink_from is not None and plan.shrink_to is not None:
        before, after = plan.shrink_from, plan.shrink_to
        text += f" Your booking {before[0]}–{before[1]} was shortened to {after[0]}–{after[1]}."
    return text


def adjusted_rows(plan: PlannedBooking) -> list[dict[str, Any]]:
    """The rows a placement shortened, as the create routes answer them."""
    if plan.shrink is None or plan.shrink_to is None:
        return []
    return [
        {
            "id": plan.shrink.id,
            "start_date": serialize_date_as_datetime_js(plan.shrink_to[0]),
            "end_date": serialize_date_as_datetime_js(plan.shrink_to[1]),
            "linked": False,
        }
    ]


# ---------------------------------------------------------
# Policies and approvers
# ---------------------------------------------------------


@dataclass(frozen=True)
class Policy:
    """Who approves an action: the project's manager and/or holders of roles."""

    pm_approves: bool = True
    role_keys: frozenset[str] = frozenset()


def _policy_of(row: ApprovalPolicy | None) -> Policy:
    # An action without a row reads as the seeded default (PM approves, no roles).
    if row is None:
        return Policy()
    return Policy(
        pm_approves=bool(row.pm_approves),
        role_keys=frozenset(role.key for role in row.roles),
    )


async def load_policy(db: AsyncSession, action: str) -> Policy:
    """The policy of one action (one query)."""
    row = (
        await db.execute(select(ApprovalPolicy).where(ApprovalPolicy.action == action))
    ).scalar_one_or_none()
    return _policy_of(row)


async def load_policies(db: AsyncSession) -> dict[str, Policy]:
    """Every stored policy by action (one query); a missing action is the default."""
    rows = (await db.execute(select(ApprovalPolicy))).scalars().all()
    return {row.action: _policy_of(row) for row in rows}


def can_decide(user: Any, request: ApprovalRequest, policy: Policy, pm_id: int | None) -> bool:
    """
    Whether ``user`` may approve or reject ``request``: an admin, the project's
    manager when the policy has ``pm_approves``, or a holder of one of the
    policy's roles -- and never the requester, admins included.

    Site visibility is the caller's concern (the request's project must be at
    a site the user can see).
    """
    if user.id == request.requester_id:
        return False
    if user.permissions.is_admin:
        return True
    if policy.pm_approves and pm_id is not None and pm_id == user.id:
        return True
    return user.role in policy.role_keys


async def approver_user_ids(
    db: AsyncSession,
    *,
    requester_id: int | None,
    pm_id: int | None,
    site_id: int | None,
    policy: Policy,
) -> list[int]:
    """
    The eligible approvers of a request, resolved live (one query): active
    admins; the project's manager (``pm_approves``) and the holders of the
    policy's roles, when they can see the project's site (member, or a role
    allowing ``sites.view_all``); minus the requester.
    """
    all_sites_roles = (
        select(Role.key)
        .join(RolePermission, RolePermission.role_id == Role.id)
        .where(RolePermission.permission == "sites.view_all", RolePermission.mode == "allow")
    )
    sees_site: Any = User.role.in_(all_sites_roles)
    if site_id is not None:
        members = select(UserSite.user_id).where(UserSite.site_id == site_id)
        sees_site = or_(sees_site, User.id.in_(members))

    eligible: list[Any] = [User.role == ADMIN_ROLE_KEY]
    if policy.role_keys:
        eligible.append(and_(User.role.in_(sorted(policy.role_keys)), sees_site))
    if policy.pm_approves and pm_id is not None:
        eligible.append(and_(User.id == pm_id, sees_site))

    query = select(User.id).where(User.active == 1, or_(*eligible))
    if requester_id is not None:
        query = query.where(User.id != requester_id)
    rows = (await db.execute(query.order_by(User.id))).scalars().all()
    return list(dict.fromkeys(rows))


# ---------------------------------------------------------
# Request context (project, target) and names
# ---------------------------------------------------------


@dataclass(frozen=True)
class RequestContext:
    """The project and target a request is about, as they are now."""

    project_name: str | None
    pm_id: int | None
    site_id: int | None
    target_exists: bool
    target_name: str
    # The target's current dates (a phase / subphase segment must lie within).
    target_start: date | None = None
    target_end: date | None = None


async def load_context(
    db: AsyncSession, *, project_id: int, level: str, target_id: int
) -> RequestContext | None:
    """
    The request's project (None if gone), whether its target still exists and
    the target's dates (one query).
    """
    query: Any
    if level == "phase":
        query = select(
            Project.name,
            Project.pm_id,
            Project.site_id,
            ProjectPhase.id,
            ProjectPhase.type,
            ProjectPhase.start_date,
            ProjectPhase.end_date,
        ).outerjoin(
            ProjectPhase,
            and_(ProjectPhase.id == target_id, ProjectPhase.project_id == Project.id),
        )
    elif level == "subphase":
        query = select(
            Project.name,
            Project.pm_id,
            Project.site_id,
            ProjectSubphase.id,
            ProjectSubphase.name,
            ProjectSubphase.start_date,
            ProjectSubphase.end_date,
        ).outerjoin(
            ProjectSubphase,
            and_(ProjectSubphase.id == target_id, ProjectSubphase.project_id == Project.id),
        )
    else:
        query = select(
            Project.name,
            Project.pm_id,
            Project.site_id,
            Project.id,
            Project.name.label("target_name"),
            Project.start_date,
            Project.end_date,
        )
    row = (await db.execute(query.where(Project.id == project_id))).first()
    if row is None:
        return None
    return RequestContext(
        project_name=row[0],
        pm_id=row[1],
        site_id=row[2],
        target_exists=row[3] is not None,
        target_name=row[4] or row[0] or "a project",
        target_start=row[5],
        target_end=row[6],
    )


def display_name(user: Any) -> str:
    """``First Last`` of a user (or SessionUser), falling back to the email."""
    name = f"{getattr(user, 'first_name', '') or ''} {getattr(user, 'last_name', '') or ''}"
    return name.strip() or getattr(user, "email", None) or "Someone"


def describe_change(
    action: str,
    requested: dict[str, Any] | None,
    previous: dict[str, Any] | None,
    level: str | None = None,
) -> str:
    """
    What a request asks for, in words (titles and the site export). ``level``
    names the card in a relink ("follows the phase dates again").
    """
    requested = requested or {}
    previous = previous or {}
    if action == ACTION_CREATE:
        text = f"at {requested.get('allocation')}%"
        if requested.get("start_date"):
            text += f" from {requested['start_date']} to {requested.get('end_date')}"
        return text
    if action == ACTION_REMOVE:
        return "removal"
    parts = []
    if previous.get("allocation") != requested.get("allocation"):
        parts.append(f"allocation {previous.get('allocation')}% → {requested.get('allocation')}%")
    if (previous.get("start_date"), previous.get("end_date")) != (
        requested.get("start_date"),
        requested.get("end_date"),
    ):
        if previous.get("start_date") and "start_date" in requested and not requested["start_date"]:
            # A segment relinked to its card (explicit nulls).
            card = level if level in ("phase", "subphase") else "card"
            parts.append(f"follows the {card} dates again")
        else:
            parts.append(f"dates {_describe_dates(previous)} → {_describe_dates(requested)}")
    return ", ".join(parts) or "no change"


def _describe_dates(values: dict[str, Any]) -> str:
    # No dates on a phase / subphase booking: it is linked, it follows the card.
    if not values.get("start_date"):
        return "follow the card"
    return f"{values['start_date']}–{values.get('end_date')}"


def _request_title(name: str, request: ApprovalRequest, target: str) -> str:
    requested = parse_values(request.requested)
    if request.action == ACTION_CREATE:
        title = f"{name} asks to join {target} {describe_change(ACTION_CREATE, requested, None)}"
    elif request.action == ACTION_REMOVE:
        title = f"{name} asks to leave {target}"
    else:
        change = describe_change(
            ACTION_UPDATE, requested, parse_values(request.previous), request.level
        )
        title = f"{name} asks to change their booking on {target}: {change}"
    return title[:_TITLE_MAX]


def _decision_title(request: ApprovalRequest, target: str, outcome: str, actor_name: str) -> str:
    subject = _SUBJECTS.get(request.action, "Your request on {target}").format(target=target)
    if outcome == "expired":
        return f"{subject} expired"[:_TITLE_MAX]
    return f"{subject} was {outcome} by {actor_name}"[:_TITLE_MAX]


# ---------------------------------------------------------
# Effects: what a transition broadcasts, notifies and pushes
# ---------------------------------------------------------


@dataclass
class RequestEvent:
    """One request changed: broadcast tenant-wide, pushed to its people."""

    request_id: int
    project_id: int
    status: str
    action: str  # broadcast action: create / update / delete
    summary: str | None
    recipients: frozenset[int]


@dataclass
class AssignmentChange:
    """A staff-assignment row created, changed or removed by a transition."""

    assignment_id: int
    project_id: int
    action: str
    summary: str | None = None


@dataclass
class ApprovalEffects:
    """Staged notifications plus the broadcasts and pushes to send after the commit.

    ``change_intents``: the change notifications (an approval applied by
    someone else tells the project's manager), delivered by the router after
    ``publish`` (``change_notifications.deliver``).
    """

    notifications: list[Notification] = field(default_factory=list)
    events: list[RequestEvent] = field(default_factory=list)
    assignment_changes: list[AssignmentChange] = field(default_factory=list)
    change_intents: list["ChangeIntent"] = field(default_factory=list)


async def publish(http: Request, actor: Any, effects: ApprovalEffects) -> None:
    """
    After the commit: broadcast the changes, push the committed notifications
    and ``approval:changed`` to every recipient. Pushes are live hints only
    (per-process manager); a failed push never fails the request.
    """
    for change in effects.assignment_changes:
        await broadcast_change(
            request=http,
            user=actor,
            entity_type="staff_assignment",
            entity_id=change.assignment_id,
            project_id=change.project_id,
            action=change.action,
            summary=change.summary,
        )
    for event in effects.events:
        await broadcast_change(
            request=http,
            user=actor,
            entity_type="approval_request",
            entity_id=event.request_id,
            project_id=event.project_id,
            action=event.action,
            summary=event.summary,
        )
    for row in effects.notifications:
        try:
            await send_notification(http, row.user_id, notification_payload(row))
        except Exception as e:  # pragma: no cover - defensive, like kanban pushes
            logger.warning("Notification push failed for user %s: %s", row.user_id, e)
    for event in effects.events:
        payload = {"id": event.request_id, "status": event.status, "project_id": event.project_id}
        for user_id in sorted(event.recipients):
            try:
                await send_user_event(http, user_id, "approval:changed", payload)
            except Exception as e:  # pragma: no cover - defensive
                logger.warning("approval:changed push failed for user %s: %s", user_id, e)


def _event(
    request: ApprovalRequest,
    action: str,
    summary: str | None,
    approvers: Iterable[int],
) -> RequestEvent:
    return RequestEvent(
        request_id=request.id,
        project_id=request.project_id,
        status=request.status,
        action=action,
        summary=summary,
        recipients=frozenset({request.requester_id, *approvers}),
    )


def _decided_notifications(
    request: ApprovalRequest,
    *,
    target: str,
    outcome: str,
    actor: Any,
    note: str | None = None,
    reason: str | None = None,
    project_exists: bool = True,
) -> list[Notification]:
    """``approval_decided`` to the requester (none when the actor is the requester)."""
    body = note
    if outcome == "expired" and reason is not None:
        body = (
            f"Overtaken by an edit from {display_name(actor)}."
            if reason == "overtaken"
            else CLOSE_REASON_DETAILS[reason].capitalize() + "."
        )
    return build_notifications(
        recipient_ids=[request.requester_id],
        notification_type="approval_decided",
        actor_id=actor.id,
        entity_type="approval_request",
        entity_id=request.id,
        project_id=request.project_id if project_exists else None,
        title=_decision_title(request, target, outcome, display_name(actor)),
        body=body,
    )


def _close(
    request: ApprovalRequest,
    new_status: str,
    *,
    by: int | None = None,
    note: str | None = None,
    reason: str | None = None,
) -> None:
    request.status = new_status
    request.close_reason = reason
    request.decided_at = utcnow_naive()
    if by is not None:
        request.decided_by = by
    if note is not None:
        request.decision_note = note


async def _mark_requests_read(db: AsyncSession, request_ids: Sequence[int]) -> None:
    """The approvers' unread ``approval_requested`` rows of closed requests become read."""
    if not request_ids:
        return
    await db.execute(
        update(Notification)
        .where(
            Notification.type == "approval_requested",
            Notification.entity_type == "approval_request",
            Notification.entity_id.in_(list(request_ids)),
            Notification.read_at.is_(None),
        )
        .values(read_at=utcnow_naive())
    )


async def _lock_request(db: AsyncSession, request_id: int) -> ApprovalRequest:
    request: ApprovalRequest | None = (
        await db.execute(
            select(ApprovalRequest).where(ApprovalRequest.id == request_id).with_for_update()
        )
    ).scalar_one_or_none()
    if request is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=REQUEST_NOT_FOUND_DETAIL)
    return request


async def _load_row(
    db: AsyncSession, level: str, assignment_id: int | None
) -> AssignmentRow | None:
    if assignment_id is None:
        return None
    model: Any = assignment_model(level)
    row: AssignmentRow | None = (
        await db.execute(select(model).where(model.id == assignment_id).with_for_update())
    ).scalar_one_or_none()
    return row


async def _release(
    db: AsyncSession, request: ApprovalRequest, row: AssignmentRow | None
) -> AssignmentChange | None:
    """Undo a closing request's hold on its row: a pending create's row goes,
    an approved row loses its pointer."""
    if row is None:
        return None
    if request.action == ACTION_CREATE:
        if row.approval_status == "pending" and row.approval_request_id in (request.id, None):
            await db.delete(row)
            return AssignmentChange(row.id, request.project_id, "delete")
        return None
    if row.approval_request_id == request.id:
        row.approval_request_id = None
        return AssignmentChange(row.id, request.project_id, "update")
    return None


# ---------------------------------------------------------
# The decision point: write directly or file a request
# ---------------------------------------------------------


async def resolve_row_write(
    db: AsyncSession,
    user: Any,
    *,
    row: AssignmentRow,
    action: str,
    outcome: BookingOutcome | None = None,
) -> BookingOutcome:
    """
    Decide an update / removal of an existing staff assignment.

    - A **pending create**: its requester edits or withdraws it through the
      request (``"approval"``); anyone else gets 403 without the right to
      write the row at all, else 409 ``AWAITS_APPROVAL_DETAIL`` (decide it
      instead).
    - Any other row: `outcome` when the caller resolved it already, else
      ``resolve_self_booking`` (editor first; 403 per its rules).
    """
    if row.approval_status == "pending":
        if row.staff_id == user.id:
            return "approval"
        if outcome is None:
            await resolve_self_booking(
                db, user, project_id=row.project_id, staff_id=row.staff_id, action=action
            )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=AWAITS_APPROVAL_DETAIL)
    if outcome is not None:
        return outcome
    return await resolve_self_booking(
        db, user, project_id=row.project_id, staff_id=row.staff_id, action=action
    )


def _accepted(request_id: int, assignment_id: int) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={
            "success": True,
            "pending": True,
            "request_id": request_id,
            "id": assignment_id,
        },
    )


async def _context_or_404(
    db: AsyncSession, *, project_id: int, level: str, target_id: int
) -> RequestContext:
    context = await load_context(db, project_id=project_id, level=level, target_id=target_id)
    if context is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return context


async def submit_request(
    db: AsyncSession,
    http: Request,
    user: Any,
    *,
    action: str,
    level: str,
    project_id: int,
    target_id: int | None = None,
    row: AssignmentRow | None = None,
    values: dict[str, Any] | None = None,
    note: str | None = None,
) -> JSONResponse:
    """
    File (or amend) the caller's request for an own booking change, commit,
    publish, and answer.

    - create (`row` None; `target_id` and `values` given): a pending row and
      its request -> 202;
    - update / remove of an approved row: a new request superseding the open
      one -> 202 (an update to the current values withdraws the open request
      instead -> 200 ``{success: true}``);
    - update / remove of the caller's own pending create: edited in place ->
      202, or cancelled -> 200 ``{success: true, cancelled: true, ...}``.
    """
    if row is None:
        if target_id is None or values is None:
            raise ValueError("A create request needs target_id and values")
        return await _submit_create(
            db,
            http,
            user,
            level=level,
            project_id=project_id,
            target_id=target_id,
            values=values,
            note=note,
        )
    if row.approval_status == "pending":
        return await _amend_pending_create(
            db, http, user, level=level, row=row, action=action, values=values
        )
    return await _submit_change(
        db, http, user, level=level, row=row, action=action, values=values, note=note
    )


async def _submit_create(
    db: AsyncSession,
    http: Request,
    user: Any,
    *,
    level: str,
    project_id: int,
    target_id: int,
    values: dict[str, Any],
    note: str | None,
) -> JSONResponse:
    context = await _context_or_404(db, project_id=project_id, level=level, target_id=target_id)
    policy = await load_policy(db, ACTION_CREATE)

    request = ApprovalRequest(
        requester_id=user.id,
        action=ACTION_CREATE,
        project_id=project_id,
        level=level,
        target_id=target_id,
        requested=_dump(values),
        note=note,
        status="pending",
    )
    db.add(request)
    await db.flush()

    row = _new_row(
        level, project_id=project_id, target_id=target_id, staff_id=user.id, values=values
    )
    row.approval_request_id = request.id
    db.add(row)
    await db.flush()
    request.assignment_id = row.id

    approvers = await approver_user_ids(
        db,
        requester_id=user.id,
        pm_id=context.pm_id,
        site_id=context.site_id,
        policy=policy,
    )
    title = _request_title(display_name(user), request, context.target_name)
    effects = ApprovalEffects(
        notifications=build_notifications(
            recipient_ids=approvers,
            notification_type="approval_requested",
            actor_id=user.id,
            entity_type="approval_request",
            entity_id=request.id,
            project_id=project_id,
            title=title,
        )
    )
    db.add_all(effects.notifications)
    await db.commit()

    effects.events.append(_event(request, "create", title, approvers))
    await publish(http, user, effects)
    return _accepted(request.id, row.id)


async def _open_request(db: AsyncSession, row: AssignmentRow) -> ApprovalRequest | None:
    """The pending request the row points at (locked), or None."""
    if row.approval_request_id is None:
        return None
    request: ApprovalRequest | None = (
        await db.execute(
            select(ApprovalRequest)
            .where(ApprovalRequest.id == row.approval_request_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if request is None or request.status != "pending":
        return None
    return request


async def _amend_pending_create(
    db: AsyncSession,
    http: Request,
    user: Any,
    *,
    level: str,
    row: AssignmentRow,
    action: str,
    values: dict[str, Any] | None,
) -> JSONResponse:
    request = await _open_request(db, row)
    if request is None or request.requester_id != user.id or request.action != ACTION_CREATE:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=AWAITS_APPROVAL_DETAIL)
    context = await _context_or_404(
        db, project_id=request.project_id, level=request.level, target_id=request.target_id
    )
    approvers = await approver_user_ids(
        db,
        requester_id=user.id,
        pm_id=context.pm_id,
        site_id=context.site_id,
        policy=await load_policy(db, ACTION_CREATE),
    )
    effects = ApprovalEffects()

    if action == ACTION_REMOVE:
        # Withdrawing one's own pending booking needs nobody's approval.
        row_id = row.id
        await db.delete(row)
        _close(request, "cancelled", by=user.id)
        await _mark_requests_read(db, [request.id])
        await db.commit()
        effects.events.append(_event(request, "update", "booking request withdrawn", approvers))
        await publish(http, user, effects)
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"success": True, "cancelled": True, "request_id": request.id, "id": row_id},
        )

    if values is None:
        raise ValueError("An update needs values")
    if is_auto_placed(parse_values(request.requested)) and _date_pair(values) == _date_pair(
        booking_values(row, level)
    ):
        # An edit leaving the dates alone (allocation only) stays auto-placed,
        # so approve re-plans it; dates chosen by the requester drop the marker.
        values = {**values, "placement": AUTO_PLACEMENT}
    _write_values(row, level, values)
    request.requested = _dump(values)
    request.updated_at = utcnow_naive()
    await db.commit()
    title = _request_title(display_name(user), request, context.target_name)
    effects.events.append(_event(request, "update", title, approvers))
    await publish(http, user, effects)
    return _accepted(request.id, row.id)


async def _submit_change(
    db: AsyncSession,
    http: Request,
    user: Any,
    *,
    level: str,
    row: AssignmentRow,
    action: str,
    values: dict[str, Any] | None,
    note: str | None,
) -> JSONResponse:
    previous = booking_values(row, level)
    old = await _open_request(db, row)
    target_id = row_target_id(row, level)
    context = await _context_or_404(db, project_id=row.project_id, level=level, target_id=target_id)
    policy = await load_policy(db, action)
    approvers = await approver_user_ids(
        db,
        requester_id=user.id,
        pm_id=context.pm_id,
        site_id=context.site_id,
        policy=policy,
    )
    effects = ApprovalEffects()

    if action == ACTION_UPDATE and values == previous:
        # Asking for what the row already holds: nothing to approve. An open
        # request on the row is withdrawn (the requester changed their mind).
        if old is not None:
            _close(old, "cancelled", by=user.id)
            row.approval_request_id = None
            await _mark_requests_read(db, [old.id])
            await db.commit()
            effects.events.append(_event(old, "update", "booking request withdrawn", approvers))
            await publish(http, user, effects)
        return JSONResponse(status_code=status.HTTP_200_OK, content={"success": True})

    request = ApprovalRequest(
        requester_id=user.id,
        action=action,
        project_id=row.project_id,
        level=level,
        target_id=target_id,
        assignment_id=row.id,
        requested=_dump(values) if action == ACTION_UPDATE else None,
        previous=_dump(previous),
        note=note,
        status="pending",
    )
    db.add(request)
    await db.flush()
    row.approval_request_id = request.id
    if old is not None:
        _close(old, "superseded")
        old.superseded_by_id = request.id
        await _mark_requests_read(db, [old.id])

    title = _request_title(display_name(user), request, context.target_name)
    effects.notifications = build_notifications(
        recipient_ids=approvers,
        notification_type="approval_requested",
        actor_id=user.id,
        entity_type="approval_request",
        entity_id=request.id,
        project_id=row.project_id,
        title=title,
    )
    db.add_all(effects.notifications)
    await db.commit()

    if old is not None:
        effects.events.append(_event(old, "update", "superseded by a newer request", approvers))
    effects.events.append(_event(request, "create", title, approvers))
    await publish(http, user, effects)
    return _accepted(request.id, row.id)


# ---------------------------------------------------------
# Card date changes: segments follow their card
# ---------------------------------------------------------


def _fit_request_values(
    values: dict[str, Any] | None, fit: Callable[[date, date], tuple[date, date]]
) -> dict[str, Any] | None:
    """A request's stored values with a segment's dates fitted (else unchanged)."""
    if not values or not values.get("start_date") or not values.get("end_date"):
        return values
    try:
        start, end = (
            date.fromisoformat(values["start_date"]),
            date.fromisoformat(values["end_date"]),
        )
    except (TypeError, ValueError):
        return values
    start, end = fit(start, end)
    return {**values, "start_date": start.isoformat(), "end_date": end.isoformat()}


async def fit_card_bookings(
    db: AsyncSession,
    level: str,
    card_id: int,
    old: tuple[date, date],
    new: tuple[date, date],
) -> None:
    """
    A phase / subphase whose dates go from `old` to `new`: fit its unlinked
    segments (rows with own dates, pending ones included) with
    ``fit_segments_to_card`` -- translated on a move, clamped on a shrink --
    and the segment dates stored in the rows' open requests (``requested`` /
    ``previous``), so a pending request stays valid and is not overtaken by
    the card's own move. Linked rows follow the card by definition. The
    result is written as is, even when two segments of one person end up
    overlapping (a shrink pushing both against one edge): the next edit of
    either resolves it. Staged only; the caller commits.
    """
    if tuple(old) == tuple(new):
        return
    model: Any = assignment_model(level)
    on_card = model.phase_id if level == "phase" else model.subphase_id
    rows = (
        (
            await db.execute(
                select(model)
                .where(
                    on_card == card_id,
                    or_(model.start_date.is_not(None), model.approval_request_id.is_not(None)),
                )
                .order_by(model.id)
            )
        )
        .scalars()
        .all()
    )

    def fit(start: date, end: date) -> tuple[date, date]:
        return fit_segments_to_card(old[0], old[1], new[0], new[1], [(start, end)])[0]

    for row in rows:
        if row.start_date is not None and row.end_date is not None:
            row.start_date, row.end_date = fit(row.start_date, row.end_date)
    request_ids = [row.approval_request_id for row in rows if row.approval_request_id is not None]
    if not request_ids:
        return
    requests = (
        (
            await db.execute(
                select(ApprovalRequest)
                .where(ApprovalRequest.id.in_(request_ids), ApprovalRequest.status == "pending")
                .with_for_update()
            )
        )
        .scalars()
        .all()
    )
    for request in requests:
        if request.requested is not None:
            request.requested = _dump(_fit_request_values(parse_values(request.requested), fit))
        if request.previous is not None:
            request.previous = _dump(_fit_request_values(parse_values(request.previous), fit))


# ---------------------------------------------------------
# Expiry hooks: editor writes and deletions
# ---------------------------------------------------------


async def expire_overtaken(
    db: AsyncSession, user: Any, *, level: str, row: AssignmentRow
) -> ApprovalEffects:
    """
    A direct write is about to change or delete a row with an open update /
    removal request: close the request -- ``expired(overtaken)`` with a
    notification to the requester, or ``cancelled`` when the writer is the
    requester themself -- and clear the row's pointer. Staged only; the caller
    commits, then ``publish``es the returned effects. No query when the row
    has no open request.
    """
    effects = ApprovalEffects()
    if row.approval_request_id is None:
        return effects
    request = await _open_request(db, row)
    row.approval_request_id = None
    if request is None:
        return effects

    context = await load_context(
        db, project_id=request.project_id, level=request.level, target_id=request.target_id
    )
    target = context.target_name if context else "a project"
    approvers = await approver_user_ids(
        db,
        requester_id=request.requester_id,
        pm_id=context.pm_id if context else None,
        site_id=context.site_id if context else None,
        policy=await load_policy(db, request.action),
    )
    if request.requester_id == user.id:
        _close(request, "cancelled", by=user.id)
        summary = "booking request withdrawn"
    else:
        _close(request, "expired", reason="overtaken")
        effects.notifications = _decided_notifications(
            request, target=target, outcome="expired", actor=user, reason="overtaken"
        )
        db.add_all(effects.notifications)
        summary = f"booking request on {target} overtaken"
    await _mark_requests_read(db, [request.id])
    effects.events.append(_event(request, "update", summary, approvers))
    return effects


async def apply_shrink(
    db: AsyncSession,
    user: Any,
    *,
    level: str,
    plan: PlannedBooking,
    effects: ApprovalEffects,
) -> list["ChangeIntent"]:
    """
    Shorten the full-span row of a split placement (``plan.shrink`` to
    ``plan.shrink_to``) the way a direct date change through PUT
    ``/phase-staff/{id}`` would: an open update / removal request on it
    closes (``expire_overtaken``: ``cancelled`` when `user` is its requester,
    else ``expired(overtaken)``), its notifications and events appended to
    `effects`; the row's ``update`` change goes to ``effects.assignment_changes``
    (broadcast by ``publish``). Returns the change intents of the update (the
    person and the PM; old values captured before the mutation). Staged
    only: the caller commits in the same transaction as the new row.
    """
    row, shrink_to = plan.shrink, plan.shrink_to
    if row is None or shrink_to is None:
        return []
    # Imported here: change_notifications imports this module.
    from app.services.change_notifications import booking_intents

    overtaken = await expire_overtaken(db, user, level=level, row=row)
    effects.notifications.extend(overtaken.notifications)
    effects.events.extend(overtaken.events)
    effects.assignment_changes.extend(overtaken.assignment_changes)
    start, end = shrink_to
    intents = booking_intents(
        user,
        kind="update",
        level=level,
        project_id=row.project_id,
        target_id=row_target_id(row, level),
        staff_id=row.staff_id,
        values=booking_dict(row.allocation, start, end),
        previous=booking_values(row, level),
    )
    row.start_date, row.end_date = start, end  # type: ignore[assignment]
    effects.assignment_changes.append(
        AssignmentChange(
            row.id, row.project_id, "update", f"booking shortened to {start}–{end} to make room"
        )
    )
    return intents


async def cancel_for_entity(
    db: AsyncSession,
    user: Any,
    *,
    project_id: int,
    phase_ids: Iterable[int] = (),
    subphase_ids: Iterable[int] = (),
    whole_project: bool = False,
) -> ApprovalEffects:
    """
    Before a phase, subphase or project is deleted: close its pending requests
    ``expired(target_deleted)`` and notify the requesters (their pending rows
    go with the target). For a whole project the requests and notifications
    cascade with it, so nothing is notified -- only the pushes are prepared.
    Staged only; the caller commits, then ``publish``es the effects.
    """
    effects = ApprovalEffects()
    phase_ids = list(phase_ids)
    subphase_ids = list(subphase_ids)
    query = select(ApprovalRequest).where(
        ApprovalRequest.project_id == project_id, ApprovalRequest.status == "pending"
    )
    if not whole_project:
        targets = []
        if phase_ids:
            targets.append(
                and_(ApprovalRequest.level == "phase", ApprovalRequest.target_id.in_(phase_ids))
            )
        if subphase_ids:
            targets.append(
                and_(
                    ApprovalRequest.level == "subphase",
                    ApprovalRequest.target_id.in_(subphase_ids),
                )
            )
        if not targets:
            return effects
        query = query.where(or_(*targets))
    requests = list((await db.execute(query.with_for_update())).scalars().all())
    if not requests:
        return effects

    context = await load_context(db, project_id=project_id, level="project", target_id=project_id)
    pm_id = context.pm_id if context else None
    site_id = context.site_id if context else None
    target = context.target_name if context else "a project"
    policies = await load_policies(db)
    approvers_by_action: dict[str, list[int]] = {}
    for request in requests:
        if request.action not in approvers_by_action:
            approvers_by_action[request.action] = await approver_user_ids(
                db,
                requester_id=None,
                pm_id=pm_id,
                site_id=site_id,
                policy=policies.get(request.action, Policy()),
            )
        approvers = [
            uid for uid in approvers_by_action[request.action] if uid != request.requester_id
        ]
        _close(request, "expired", reason="target_deleted")
        if not whole_project:
            effects.notifications.extend(
                _decided_notifications(
                    request, target=target, outcome="expired", actor=user, reason="target_deleted"
                )
            )
        effects.events.append(
            _event(request, "delete" if whole_project else "update", "target deleted", approvers)
        )
    if not whole_project:
        await _mark_requests_read(db, [request.id for request in requests])
        db.add_all(effects.notifications)
    return effects


async def expire_for_requester(
    db: AsyncSession,
    actor: Any,
    user_id: int,
    *,
    reason: str = "requester_inactive",
    deleted: bool = False,
) -> ApprovalEffects:
    """
    A requester's account is deactivated (``deleted=False``) or deleted: close
    their pending requests ``expired(<reason>)`` and release the rows they hold
    (a pending create's row goes, an approved row loses its pointer). The
    requester is told on deactivation only -- a deleted account's requests and
    notifications cascade with it, so only the broadcasts and pushes remain.
    Staged only; the caller commits, then ``publish``es the effects. One query
    when the user has no pending request.
    """
    effects = ApprovalEffects()
    requests = list(
        (
            await db.execute(
                select(ApprovalRequest)
                .where(
                    ApprovalRequest.requester_id == user_id,
                    ApprovalRequest.status == "pending",
                )
                .with_for_update()
            )
        )
        .scalars()
        .all()
    )
    if not requests:
        return effects

    policies = await load_policies(db)
    for request in requests:
        context = await load_context(
            db, project_id=request.project_id, level=request.level, target_id=request.target_id
        )
        target = context.target_name if context else "a project"
        approvers = await approver_user_ids(
            db,
            requester_id=user_id,
            pm_id=context.pm_id if context else None,
            site_id=context.site_id if context else None,
            policy=policies.get(request.action, Policy()),
        )
        change = await _release(
            db, request, await _load_row(db, request.level, request.assignment_id)
        )
        _close(request, "expired", reason=reason)
        if not deleted:
            effects.notifications.extend(
                _decided_notifications(
                    request,
                    target=target,
                    outcome="expired",
                    actor=actor,
                    reason=reason,
                    project_exists=context is not None,
                )
            )
        summary = f"{target}: booking request expired ({reason})"
        if change is not None:
            change.summary = summary
            effects.assignment_changes.append(change)
        effects.events.append(
            _event(request, "delete" if deleted else "update", summary, approvers)
        )
    await _mark_requests_read(db, [request.id for request in requests])
    db.add_all(effects.notifications)
    return effects


# ---------------------------------------------------------
# Decisions
# ---------------------------------------------------------


class RequestClosedError(Exception):
    """A decision on a request that is no longer pending (409 with its status)."""

    def __init__(self, request_status: str):
        super().__init__(f"Request already {request_status}")
        self.status = request_status

    @property
    def body(self) -> dict[str, str]:
        return {"detail": f"Request already {self.status}", "status": self.status}


@dataclass
class DecisionResult:
    """A decided (or expired) request, the effects to publish, and the 409
    body when re-validation closed it instead of the caller's decision."""

    request: ApprovalRequest
    effects: ApprovalEffects
    conflict: dict[str, str] | None = None


def _ensure_pending(request: ApprovalRequest) -> None:
    if request.status != "pending":
        raise RequestClosedError(request.status)


def _ensure_decider(
    user: Any,
    request: ApprovalRequest,
    policy: Policy,
    context: RequestContext | None,
    visible: frozenset[int] | None,
) -> None:
    if user.id == request.requester_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWN_REQUEST_DETAIL)
    pm_id = context.pm_id if context else None
    site_id = context.site_id if context else None
    if not site_is_visible(visible, site_id) or not can_decide(user, request, policy, pm_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NOT_DECIDER_DETAIL)


async def _requester_problem(
    db: AsyncSession, request: ApprovalRequest, context: RequestContext
) -> str | None:
    """Why the requester can no longer hold this booking, or None."""
    found = (
        await db.execute(
            select(User.active, User.role, User.is_resource).where(User.id == request.requester_id)
        )
    ).first()
    if found is None or found[0] != 1:
        return "requester_inactive"
    if request.action == ACTION_CREATE and not found[2]:
        # A new booking of someone no longer bookable as a resource is never
        # applied (the requester is the booked person). Update / remove
        # requests stay approvable: existing bookings are kept.
        return "permission_lost"
    permissions = await load_permission_set(db, found[1])
    # Same rule as resolve_self_booking: a holder of assignments.manage_others
    # (outright, or through the PM bundle on this project) books themself
    # without the self key, so their request stays valid.
    if permissions.mode(request.action) is None and not permissions.can(
        MANAGE_OTHERS_KEY, pm_id=context.pm_id, user_id=request.requester_id
    ):
        return "permission_lost"
    if permissions.has("sites.view_all"):
        return None
    if context.site_id is None:
        return "permission_lost"
    member = (
        await db.execute(
            select(UserSite.user_id).where(
                UserSite.user_id == request.requester_id, UserSite.site_id == context.site_id
            )
        )
    ).first()
    return None if member is not None else "permission_lost"


async def _revalidate(
    db: AsyncSession, request: ApprovalRequest, context: RequestContext | None
) -> tuple[str | None, AssignmentRow | None, PlannedBooking | None]:
    """
    The close reason when the request can no longer be applied (and the row),
    plus, for an auto-placed create, its re-planned placement.
    """
    if context is None or not context.target_exists:
        return "target_deleted", await _load_row(db, request.level, request.assignment_id), None
    problem = await _requester_problem(db, request, context)
    row = await _load_row(db, request.level, request.assignment_id)
    if problem is not None:
        return problem, row, None
    if request.action == ACTION_CREATE:
        if row is None or row.approval_status != "pending":
            return "overtaken", row, None
        if request.level != "project" and is_auto_placed(parse_values(request.requested)):
            # A dateless create: placed again against the person's approved
            # bookings as they are now (the filed dates may be stale); no room
            # left is a duplicate, as for any create.
            plan = await plan_placement(
                db,
                request.level,
                request.target_id,
                row.staff_id,
                exclude_id=row.id,
                approved_only=True,
            )
            if isinstance(plan, str):
                return "duplicate", row, None
            return None, row, plan
        # The row's own dates (None = linked, the whole card): an approved
        # booking of the person overlapping them, filed meanwhile, wins.
        duplicate = await find_duplicate(
            db,
            request.level,
            request.target_id,
            row.staff_id,
            start_date=row.start_date,
            end_date=row.end_date,
            exclude_id=row.id,
            approved_only=True,
        )
        return ("duplicate" if duplicate is not None else None), row, None
    previous = parse_values(request.previous)
    if (
        row is None
        or row.approval_status != "approved"
        or row.approval_request_id != request.id
        or booking_values(row, request.level) != previous
    ):
        return "overtaken", row, None
    requested = parse_values(request.requested) or {}
    if (
        request.action == ACTION_UPDATE
        and request.level != "project"
        and _date_pair(requested) != _date_pair(previous or {})
    ):
        # New segment dates: an approved booking of the person overlapping
        # them, filed meanwhile, wins (as for a create).
        try:
            start, end = _day(requested.get("start_date")), _day(requested.get("end_date"))
        except (TypeError, ValueError):
            return None, row, None  # malformed: _values_valid answers INVALID_VALUES
        duplicate = await find_duplicate(
            db,
            request.level,
            request.target_id,
            row.staff_id,
            start_date=start,
            end_date=end,
            exclude_id=row.id,
            approved_only=True,
        )
        if duplicate is not None:
            return "duplicate", row, None
    return None, row, None


def _date_pair(values: dict[str, Any]) -> tuple[Any, Any]:
    return values.get("start_date"), values.get("end_date")


async def approve(
    db: AsyncSession,
    user: Any,
    request_id: int,
    *,
    note: str | None = None,
    visible: frozenset[int] | None,
) -> DecisionResult:
    """
    Approve in one transaction: lock the request (404), check the caller
    (403: the requester, or not an approver), require it pending
    (``RequestClosedError``), re-validate, apply, notify the requester,
    commit. A re-validation failure closes the request ``expired(<reason>)``
    instead and returns the 409 body in ``conflict``.

    An auto-placed create (``placement: "auto"``) is re-planned by
    ``_revalidate`` and applied here, before the commit: the full-span row
    shortened (``apply_shrink``) on a split, the pending row given the
    re-planned dates (None / None = linked when the person's other bookings
    are gone), ``requested`` rewritten to them with the marker kept. The
    requester's ``approval_decided`` names the dates that landed and the
    shortened booking.
    """
    request = await _lock_request(db, request_id)
    context = await load_context(
        db, project_id=request.project_id, level=request.level, target_id=request.target_id
    )
    policy = await load_policy(db, request.action)
    _ensure_decider(user, request, policy, context, visible)
    _ensure_pending(request)

    problem, row, plan = await _revalidate(db, request, context)
    if (
        problem is None
        and request.action != ACTION_REMOVE
        and not _values_valid(request.level, parse_values(request.requested), context)
    ):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=INVALID_VALUES_DETAIL)

    target = context.target_name if context else "a project"
    approvers = await approver_user_ids(
        db,
        requester_id=request.requester_id,
        pm_id=context.pm_id if context else None,
        site_id=context.site_id if context else None,
        policy=policy,
    )
    effects = ApprovalEffects()

    if problem is not None:
        change = await _release(db, request, row)
        _close(request, "expired", reason=problem)
        effects.notifications = _decided_notifications(
            request,
            target=target,
            outcome="expired",
            actor=user,
            reason=problem,
            project_exists=context is not None,
        )
        db.add_all(effects.notifications)
        await _mark_requests_read(db, [request.id])
        await db.commit()
        if change is not None:
            effects.assignment_changes.append(change)
        effects.events.append(_event(request, "update", f"request expired ({problem})", approvers))
        return DecisionResult(
            request,
            effects,
            conflict={
                "detail": f"Request expired: {CLOSE_REASON_DETAILS[problem]}",
                "status": "expired",
                "close_reason": problem,
            },
        )

    assert row is not None  # _revalidate returns a row when there is no problem
    row_id = row.id
    shrink_intents: list[ChangeIntent] = []
    decided_body = note
    if request.action == ACTION_CREATE:
        if plan is not None:
            shrink_intents = await apply_shrink(
                db, user, level=request.level, plan=plan, effects=effects
            )
            row.start_date, row.end_date = plan.start_date, plan.end_date  # type: ignore[assignment]
            request.requested = _dump(
                booking_dict(
                    row.allocation, plan.start_date, plan.end_date, placement=AUTO_PLACEMENT
                )
            )
            decided_body = " ".join(
                part for part in (placement_body(row.allocation, plan), note) if part
            )
        row.approval_status = "approved"
        row.approval_request_id = None
        change_action = "create"
    elif request.action == ACTION_UPDATE:
        _write_values(row, request.level, parse_values(request.requested) or {})
        row.approval_request_id = None
        change_action = "update"
    else:
        await db.delete(row)
        change_action = "delete"

    _close(request, "approved", by=user.id, note=note)
    decided = _decided_notifications(
        request, target=target, outcome="approved", actor=user, note=decided_body
    )
    # Extend, never assign: apply_shrink may have staged the overtaken
    # request's notification already.
    effects.notifications.extend(decided)
    db.add_all(decided)
    await _mark_requests_read(db, [request.id])
    await db.commit()

    # Imported here: change_notifications imports this module.
    from app.services.change_notifications import approval_intents

    effects.change_intents.extend(
        approval_intents(
            user,
            project_id=request.project_id,
            level=request.level,
            target_id=request.target_id,
            target_name=target,
            pm_id=context.pm_id if context else None,
            requester_id=request.requester_id,
            action=request.action,
            requested=parse_values(request.requested),
            previous=parse_values(request.previous),
        )
    )
    effects.change_intents.extend(shrink_intents)

    summary = f"{target}: booking approved"
    effects.assignment_changes.append(
        AssignmentChange(row_id, request.project_id, change_action, summary)
    )
    effects.events.append(_event(request, "update", summary, approvers))
    return DecisionResult(request, effects)


async def reject(
    db: AsyncSession,
    user: Any,
    request_id: int,
    *,
    note: str | None = None,
    visible: frozenset[int] | None,
) -> DecisionResult:
    """Reject: same lock and checks as ``approve``, no re-validation; a pending
    create's row is deleted, an approved row only loses its pointer."""
    request = await _lock_request(db, request_id)
    context = await load_context(
        db, project_id=request.project_id, level=request.level, target_id=request.target_id
    )
    policy = await load_policy(db, request.action)
    _ensure_decider(user, request, policy, context, visible)
    _ensure_pending(request)

    row = await _load_row(db, request.level, request.assignment_id)
    change = await _release(db, request, row)
    _close(request, "rejected", by=user.id, note=note)
    target = context.target_name if context else "a project"
    effects = ApprovalEffects(
        notifications=_decided_notifications(
            request,
            target=target,
            outcome="rejected",
            actor=user,
            note=note,
            project_exists=context is not None,
        )
    )
    db.add_all(effects.notifications)
    approvers = await approver_user_ids(
        db,
        requester_id=request.requester_id,
        pm_id=context.pm_id if context else None,
        site_id=context.site_id if context else None,
        policy=policy,
    )
    await _mark_requests_read(db, [request.id])
    await db.commit()

    summary = f"{target}: booking request rejected"
    if change is not None:
        change.summary = summary
        effects.assignment_changes.append(change)
    effects.events.append(_event(request, "update", summary, approvers))
    return DecisionResult(request, effects)


async def cancel(
    db: AsyncSession, user: Any, request_id: int, *, note: str | None = None
) -> DecisionResult:
    """Cancel: the requester, or any admin (housekeeping). The requester is
    notified only when someone else cancelled; approvers never are."""
    request = await _lock_request(db, request_id)
    if user.id != request.requester_id and not user.permissions.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=CANCEL_FORBIDDEN_DETAIL)
    _ensure_pending(request)

    context = await load_context(
        db, project_id=request.project_id, level=request.level, target_id=request.target_id
    )
    row = await _load_row(db, request.level, request.assignment_id)
    change = await _release(db, request, row)
    _close(request, "cancelled", by=user.id, note=note)
    target = context.target_name if context else "a project"
    effects = ApprovalEffects(
        notifications=_decided_notifications(
            request,
            target=target,
            outcome="cancelled",
            actor=user,
            note=note,
            project_exists=context is not None,
        )
    )
    db.add_all(effects.notifications)
    approvers = await approver_user_ids(
        db,
        requester_id=request.requester_id,
        pm_id=context.pm_id if context else None,
        site_id=context.site_id if context else None,
        policy=await load_policy(db, request.action),
    )
    await _mark_requests_read(db, [request.id])
    await db.commit()

    summary = f"{target}: booking request cancelled"
    if change is not None:
        change.summary = summary
        effects.assignment_changes.append(change)
    effects.events.append(_event(request, "update", summary, approvers))
    return DecisionResult(request, effects)


# ---------------------------------------------------------
# Serialisation
# ---------------------------------------------------------


def assignment_approval(request: ApprovalRequest, *, can_decide_flag: bool) -> dict[str, Any]:
    """The ``approval`` field of a serialised staff assignment."""
    return {
        "request_id": request.id,
        "action": request.action,
        "requester_id": request.requester_id,
        "requested": parse_values(request.requested),
        "previous": parse_values(request.previous),
        "created_at": request.created_at,
        "can_decide": can_decide_flag,
    }


async def project_approval_index(
    db: AsyncSession, user: Any, *, project_id: int, pm_id: int | None
) -> dict[tuple[str, int], dict[str, Any]]:
    """
    ``{(level, assignment_id): approval}`` for a project's pending requests:
    one query, plus the policies when there is any pending request.
    """
    requests = list(
        (
            await db.execute(
                select(ApprovalRequest).where(
                    ApprovalRequest.project_id == project_id,
                    ApprovalRequest.status == "pending",
                    ApprovalRequest.assignment_id.is_not(None),
                )
            )
        )
        .scalars()
        .all()
    )
    if not requests:
        return {}
    policies = await load_policies(db)
    index: dict[tuple[str, int], dict[str, Any]] = {}
    for request in requests:
        if request.assignment_id is None:
            continue
        decide = can_decide(user, request, policies.get(request.action, Policy()), pm_id)
        index[(request.level, request.assignment_id)] = assignment_approval(
            request, can_decide_flag=decide
        )
    return index


def pending_change_text(request: ApprovalRequest | None) -> str:
    """The site export's ``Pending change`` cell for a row's open request."""
    if request is None or request.status != "pending":
        return ""
    if request.action == ACTION_CREATE:
        return "awaiting approval"
    if request.action == ACTION_REMOVE:
        return "removal requested"
    return describe_change(
        ACTION_UPDATE,
        parse_values(request.requested),
        parse_values(request.previous),
        request.level,
    )


# ---------------------------------------------------------
# Listing (GET /approval-requests)
# ---------------------------------------------------------

VIEW_ALL_KEY = "approvals.view_all"


def request_rows_query() -> Any:
    """
    Requests with what a list shows, in one query: ``(request, project_name,
    pm_id, site_id, requester_name, decided_by_name, target_name)``.
    """
    requester = aliased(User)
    decider = aliased(User)
    target_name = func.coalesce(ProjectPhase.type, ProjectSubphase.name, Project.name)
    return (
        select(
            ApprovalRequest,
            Project.name.label("project_name"),
            Project.pm_id,
            Project.site_id,
            (requester.first_name + " " + requester.last_name).label("requester_name"),
            (decider.first_name + " " + decider.last_name).label("decided_by_name"),
            target_name.label("target_name"),
        )
        .join(Project, Project.id == ApprovalRequest.project_id)
        .join(requester, requester.id == ApprovalRequest.requester_id)
        .outerjoin(decider, decider.id == ApprovalRequest.decided_by)
        .outerjoin(
            ProjectPhase,
            and_(ApprovalRequest.level == "phase", ProjectPhase.id == ApprovalRequest.target_id),
        )
        .outerjoin(
            ProjectSubphase,
            and_(
                ApprovalRequest.level == "subphase",
                ProjectSubphase.id == ApprovalRequest.target_id,
            ),
        )
    )


def serialize_request_row(row: Sequence[Any], *, can_decide_flag: bool) -> dict[str, Any]:
    """One ``request_rows_query`` row as an ``ApprovalRequestResponse`` dict."""
    request: ApprovalRequest = row[0]
    return {
        "id": request.id,
        "action": request.action,
        "status": request.status,
        "close_reason": request.close_reason,
        "requester_id": request.requester_id,
        "requester_name": row[4],
        "project_id": request.project_id,
        "project_name": row[1],
        "level": request.level,
        "target_id": request.target_id,
        "target_name": row[6],
        "assignment_id": request.assignment_id,
        "requested": parse_values(request.requested),
        "previous": parse_values(request.previous),
        "note": request.note,
        "decided_by": request.decided_by,
        "decided_by_name": row[5],
        "decided_at": request.decided_at,
        "decision_note": request.decision_note,
        "superseded_by_id": request.superseded_by_id,
        "created_at": request.created_at,
        "updated_at": request.updated_at,
        "can_decide": can_decide_flag,
    }


def decider_clause(user: Any, policies: dict[str, Policy]) -> Any:
    """
    The SQL half of ``can_decide`` for the to-decide lists (None for an admin:
    every request): the caller manages the request's project and its action's
    policy lets the PM approve (an action without a policy row does), or the
    caller's role is one of the action's policy roles. The requester and site
    filters are added by the caller.
    """
    if user.permissions.is_admin:
        return None
    role_actions = sorted(action for action, p in policies.items() if user.role in p.role_keys)
    no_pm_actions = sorted(action for action, p in policies.items() if not p.pm_approves)
    as_pm: Any = Project.pm_id == user.id
    if no_pm_actions:
        as_pm = and_(as_pm, ApprovalRequest.action.not_in(no_pm_actions))
    if not role_actions:
        return as_pm
    return or_(as_pm, ApprovalRequest.action.in_(role_actions))


def _row_can_decide(
    user: Any,
    row: Sequence[Any],
    policies: dict[str, Policy],
    visible: frozenset[int] | None,
) -> bool:
    request: ApprovalRequest = row[0]
    return (
        request.status == "pending"
        and site_is_visible(visible, row[3])
        and can_decide(user, request, policies.get(request.action, Policy()), row[2])
    )


async def list_requests(
    db: AsyncSession,
    http: Request,
    user: Any,
    *,
    scope: str = "mine",
    status_filter: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """
    ``mine``: the caller's own requests; ``to_decide``: pending requests the
    caller may decide (at visible sites, never their own); ``all``: every
    request at the visible sites (``approvals.view_all``, else 403). Newest
    first; ``status_filter`` narrows (``to_decide`` is pending only).
    """
    if scope == "all" and not user.permissions.has(VIEW_ALL_KEY):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=permission_required_detail(VIEW_ALL_KEY)
        )
    if scope == "to_decide" and status_filter not in (None, "pending"):
        return []

    if scope == "to_decide":
        rows, policies, visible = await _to_decide_rows(db, http, user, limit=limit)
    else:
        visible = await visible_site_ids(http, db, user)
        query = request_rows_query()
        if scope == "mine":
            query = query.where(ApprovalRequest.requester_id == user.id)
        else:
            in_visible = visible_sites_clause(Project.site_id, visible)
            if in_visible is not None:
                query = query.where(in_visible)
        if status_filter is not None:
            query = query.where(ApprovalRequest.status == status_filter)
        query = query.order_by(ApprovalRequest.created_at.desc(), ApprovalRequest.id.desc())
        rows = list((await db.execute(query.limit(limit))).all())
        if not rows:
            return []
        policies = await load_policies(db)

    items = []
    for row in rows:
        decide = _row_can_decide(user, row, policies, visible)
        if scope == "to_decide" and not decide:
            continue  # cannot happen: the query already holds the same rule
        items.append(serialize_request_row(row, can_decide_flag=decide))
    return items


async def _to_decide_rows(
    db: AsyncSession, http: Request, user: Any, *, limit: int
) -> tuple[list[Any], dict[str, Policy], frozenset[int] | None]:
    """
    Pending requests the caller may decide, newest first: the eligibility rule
    (``decider_clause``), the visible sites and "never one's own" are all in
    SQL, so ``limit`` counts decidable rows only -- a page is never cut short
    by rows the caller may not decide.
    """
    policies = await load_policies(db)
    visible = await visible_site_ids(http, db, user)
    query = request_rows_query().where(
        ApprovalRequest.status == "pending", ApprovalRequest.requester_id != user.id
    )
    in_visible = visible_sites_clause(Project.site_id, visible)
    if in_visible is not None:
        query = query.where(in_visible)
    eligible = decider_clause(user, policies)
    if eligible is not None:
        query = query.where(eligible)
    query = query.order_by(ApprovalRequest.created_at.desc(), ApprovalRequest.id.desc())
    rows = list((await db.execute(query.limit(limit))).all())
    return rows, policies, visible


async def get_request(
    db: AsyncSession, http: Request, user: Any, request_id: int
) -> dict[str, Any]:
    """One request for its requester, an eligible approver, or a holder of
    ``approvals.view_all`` at a visible site; 404 for anyone else."""
    row = (await db.execute(request_rows_query().where(ApprovalRequest.id == request_id))).first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=REQUEST_NOT_FOUND_DETAIL)
    request: ApprovalRequest = row[0]
    if request.requester_id == user.id:
        return serialize_request_row(row, can_decide_flag=False)
    visible = await visible_site_ids(http, db, user)
    if not site_is_visible(visible, row[3]):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=REQUEST_NOT_FOUND_DETAIL)
    policy = (await load_policies(db)).get(request.action, Policy())
    eligible = can_decide(user, request, policy, row[2])
    if not eligible and not user.permissions.has(VIEW_ALL_KEY):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=REQUEST_NOT_FOUND_DETAIL)
    return serialize_request_row(row, can_decide_flag=eligible and request.status == "pending")
