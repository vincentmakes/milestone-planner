"""
Assignment routes for staff and equipment.

Handles:
- Project staff assignments (project_assignments table)
- Phase staff assignments (phase_staff_assignments table)
- Subphase staff assignments (subphase_staff_assignments table)
- Equipment assignments (equipment_assignments table)

Matches Node.js routes:
- GET /api/staff/:id/assignments
- POST /api/projects/:projectId/staff
- PUT /api/assignments/:id
- DELETE /api/assignments/:id
- POST /api/phases/:phaseId/staff
- PUT /api/phase-staff/:id
- DELETE /api/phase-staff/:id
- POST /api/subphases/:subphaseId/staff
- PUT /api/subphase-staff/:id
- DELETE /api/subphase-staff/:id
- POST /api/projects/:projectId/equipment

PUT/DELETE /api/equipment-assignments/:id live in routers/equipment.py (that
router is registered first; duplicates here used to be shadowed dead code).

Auth: staff-assignment writes are decided editor first
(`project_access.resolve_self_booking`, `approvals.resolve_row_write`) --
``assignments.manage_others`` (outright, or the project's manager through the
PM bundle) writes any row; anyone else only their own row
(`staff_id == user.id`) in the mode of ``assignments.self_create`` /
``self_update`` / ``self_remove``: ``allow`` writes as before, ``approval``
files an approval request instead and answers **202**
``{success, pending: true, request_id, id}`` (app/services/approvals.py),
no key is a 403. The `project_id` used for those checks is always derived
server-side from the path or the loaded row, never from the request body.

Phase / subphase bookings are linked (no own dates: they follow the card) or
unlinked segments with their own ``start_date`` / ``end_date`` inside the card
(400 outside it; both dates or neither, 422). Responses carry the effective
dates (own, else the card's) and ``linked``; on update an explicit ``null`` on
both dates relinks.

A **dateless** phase / subphase create is placed by the server
(``approvals.plan_placement``): linked when the person has no booking on the
card; else the largest free stretch of the card (ties -> the earliest); else,
when one booking covers the whole card, that booking is shortened to the
first half and the new one takes the second; else 409 ``CARD_FULL_DETAIL``
(``ALREADY_PENDING_DETAIL`` when the booking to split awaits approval). The
create answers ``adjusted: [{id, start_date, end_date, linked: false}]`` --
the rows it shortened. In approval mode the request carries the planned
dates (``placement: "auto"``) and nothing is shortened until it is approved,
when the placement is planned again.

A booking awaiting approval is a real row (``approval_status = 'pending'``):
a second booking of the same person on the target with explicit dates is a
409 (pending or not; at project level only with the same dates; on a phase /
subphase only when the effective dates overlap -- a person may hold several
non-overlapping segments on one card), and a direct write on a pending
row is a 409 (decide the request instead). A direct write on a row with an
open change / removal request closes that request (``expired(overtaken)``).
Equipment bookings need ``equipment_bookings.manage`` (also in the PM bundle).

A direct write tells the booked person and the project manager (never the
actor) through ``change_notifications.deliver`` after the commit; the 202
approval path and a no-op update tell nobody.
"""

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_permission
from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.equipment import Equipment, EquipmentAssignment
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.user import User
from app.schemas.base import (
    DateRangeOrdered,
    serialize_date_as_datetime_js,
    serialize_datetime_js,
)
from app.services import approvals, change_notifications
from app.services.approvals import (
    ACTION_CREATE,
    ACTION_REMOVE,
    ACTION_UPDATE,
    booking_dict,
    booking_values,
)
from app.services.booking_segments import effective_dates
from app.services.project_access import (
    project_id_for_phase,
    project_id_for_subphase,
    project_pm_id,
    require_bookable_staff,
    require_on_project,
    require_segment_within_card,
    resolve_self_booking,
)
from app.services.site_access import (
    ensure_person_visible,
    ensure_project_visible,
    visible_site_ids,
    visible_sites_clause,
)
from app.websocket.broadcast import broadcast_change

router = APIRouter(tags=["assignments"])


# ---------------------------------------------------------
# Request/Response Models
# ---------------------------------------------------------


# A single booking is a share of one person's time, so it cannot exceed 100%;
# over-allocation is what several overlapping bookings add up to, and the
# workload heatmap is where that shows. 0 or negative would silently corrupt
# that calculation rather than mean anything. Same bound on every level
# (project / phase / subphase, create and update) and on Kanban assignees.
Allocation = Annotated[int, Field(ge=1, le=100)]


class ProjectStaffAssignmentCreate(DateRangeOrdered):
    """Request to assign staff to a project."""

    staff_id: int
    allocation: Allocation = 100
    start_date: date
    end_date: date


class ProjectStaffAssignmentUpdate(DateRangeOrdered):
    """Request to update a project staff assignment."""

    allocation: Allocation
    start_date: date
    end_date: date


SEGMENT_DATES_PAIR_MESSAGE = "Give both dates or neither"


class SegmentDates(DateRangeOrdered):
    """
    Optional own dates of a phase / subphase booking: given, the booking is
    an unlinked segment inside its card; absent (or both ``null``), it is
    linked and follows the card. Both or neither (422). On an update, dates
    left out keep the row's, an explicit ``null`` on both relinks it.
    """

    start_date: date | None = None
    end_date: date | None = None

    @model_validator(mode="after")
    def _both_dates_or_neither(self):
        given = {"start_date", "end_date"} & self.model_fields_set
        if len(given) == 1 or (self.start_date is None) != (self.end_date is None):
            raise ValueError(SEGMENT_DATES_PAIR_MESSAGE)
        return self

    @property
    def dates_given(self) -> bool:
        return "start_date" in self.model_fields_set


class PhaseStaffAssignmentCreate(SegmentDates):
    """Request to assign staff to a phase.

    `project_id` is accepted for wire compatibility but ignored: the server
    resolves it from the phase.
    """

    staff_id: int
    project_id: int
    # null keeps the historical meaning "full time" (100).
    allocation: Allocation | None = 100


class PhaseStaffAssignmentUpdate(SegmentDates):
    """Request to update a phase staff assignment (allocation None = unchanged)."""

    allocation: Allocation | None = None


class SubphaseStaffAssignmentCreate(SegmentDates):
    """Request to assign staff to a subphase.

    `project_id` is accepted for wire compatibility but ignored: the server
    resolves it from the subphase.
    """

    staff_id: int
    project_id: int
    allocation: Allocation | None = 100


class SubphaseStaffAssignmentUpdate(SegmentDates):
    """Request to update a subphase staff assignment (allocation None = unchanged)."""

    allocation: Allocation | None = None


class EquipmentAssignmentCreate(DateRangeOrdered):
    """Request to assign equipment to a project."""

    equipment_id: int
    start_date: date
    end_date: date


# ---------------------------------------------------------
# Project Staff Assignment Routes
# ---------------------------------------------------------


@router.get("/staff/{staff_id}/assignments")
async def get_staff_assignments(
    staff_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("views.staff")),
):
    """
    Get the project assignments of a staff member (``views.staff``).

    The person must be oneself or share a visible site (404 otherwise), and
    only projects at the user's visible sites are listed.

    Matches: GET /api/staff/:id/assignments
    """
    await ensure_person_visible(
        request, db, user, staff_id, status_code=404, detail="Staff member not found"
    )
    query = (
        select(
            ProjectAssignment,
            Project.name.label("project_name"),
            Project.site_id.label("project_site_id"),
        )
        .join(Project, ProjectAssignment.project_id == Project.id)
        .where(ProjectAssignment.staff_id == staff_id)
    )
    in_visible = visible_sites_clause(Project.site_id, await visible_site_ids(request, db, user))
    if in_visible is not None:
        query = query.where(in_visible)
    result = await db.execute(query.order_by(ProjectAssignment.start_date))
    rows = result.all()

    return [
        {
            "id": r[0].id,
            "project_id": r[0].project_id,
            "staff_id": r[0].staff_id,
            "allocation": r[0].allocation,
            "start_date": serialize_date_as_datetime_js(r[0].start_date),
            "end_date": serialize_date_as_datetime_js(r[0].end_date),
            "created_at": serialize_datetime_js(r[0].created_at),
            "approval_status": r[0].approval_status,
            "project_name": r[1],
            "project_site_id": r[2],
        }
        for r in rows
    ]


@router.post("/projects/{project_id}/staff")
async def create_project_staff_assignment(
    project_id: int,
    data: ProjectStaffAssignmentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Assign staff to a project.

    Matches: POST /api/projects/:projectId/staff
    """
    # Resolve the project before anything else (404): the own-row and
    # key-holder short-circuits of resolve_self_booking never query it, so a
    # write to a missing project would otherwise end in an FK error (500).
    pm_id = await project_pm_id(db, project_id)
    await ensure_project_visible(request, db, user, project_id)
    outcome = await resolve_self_booking(
        db,
        user,
        project_id=project_id,
        pm_id=pm_id,
        staff_id=data.staff_id,
        action=ACTION_CREATE,
    )
    await require_bookable_staff(db, data.staff_id)
    await approvals.ensure_no_duplicate(
        db,
        "project",
        project_id,
        data.staff_id,
        start_date=data.start_date,
        end_date=data.end_date,
    )
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_CREATE,
            level="project",
            project_id=project_id,
            target_id=project_id,
            values=booking_dict(data.allocation, data.start_date, data.end_date),
        )

    intents = change_notifications.booking_intents(
        user,
        kind="create",
        level="project",
        project_id=project_id,
        target_id=project_id,
        staff_id=data.staff_id,
        values=booking_dict(data.allocation, data.start_date, data.end_date),
    )
    assignment = ProjectAssignment(
        project_id=project_id,
        staff_id=data.staff_id,
        allocation=data.allocation,
        start_date=data.start_date,
        end_date=data.end_date,
    )
    db.add(assignment)
    await db.commit()
    await db.refresh(assignment)

    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="staff_assignment",
        entity_id=assignment.id,
        project_id=project_id,
        action="create",
    )
    await change_notifications.deliver(db, request, user.id, intents)

    return {"id": assignment.id, "success": True}


@router.put("/assignments/{assignment_id}")
async def update_project_staff_assignment(
    assignment_id: int,
    data: ProjectStaffAssignmentUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Update a project staff assignment.

    Matches: PUT /api/assignments/:id
    """
    result = await db.execute(
        select(ProjectAssignment).where(ProjectAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()

    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    project_id = assignment.project_id
    await ensure_project_visible(request, db, user, project_id)
    outcome = await approvals.resolve_row_write(db, user, row=assignment, action=ACTION_UPDATE)
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_UPDATE,
            level="project",
            project_id=project_id,
            row=assignment,
            values=booking_dict(data.allocation, data.start_date, data.end_date),
        )
    effects = await approvals.expire_overtaken(db, user, level="project", row=assignment)
    intents = change_notifications.booking_intents(
        user,
        kind="update",
        level="project",
        project_id=project_id,
        target_id=project_id,
        staff_id=assignment.staff_id,
        values=booking_dict(data.allocation, data.start_date, data.end_date),
        previous=booking_values(assignment, "project"),
    )

    assignment.allocation = data.allocation
    assignment.start_date = data.start_date
    assignment.end_date = data.end_date

    await db.commit()

    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="staff_assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="update",
    )
    await approvals.publish(request, user, effects)
    await change_notifications.deliver(db, request, user.id, intents)

    return {"success": True}


@router.delete("/assignments/{assignment_id}")
async def delete_project_staff_assignment(
    assignment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Delete a project staff assignment.

    Matches: DELETE /api/assignments/:id
    """
    result = await db.execute(
        select(ProjectAssignment).where(ProjectAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()

    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    project_id = assignment.project_id
    await ensure_project_visible(request, db, user, project_id)
    outcome = await approvals.resolve_row_write(db, user, row=assignment, action=ACTION_REMOVE)
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_REMOVE,
            level="project",
            project_id=project_id,
            row=assignment,
        )
    effects = await approvals.expire_overtaken(db, user, level="project", row=assignment)
    intents = change_notifications.booking_intents(
        user,
        kind="remove",
        level="project",
        project_id=project_id,
        target_id=project_id,
        staff_id=assignment.staff_id,
        previous=booking_values(assignment, "project"),
    )

    await db.delete(assignment)
    await db.commit()

    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="staff_assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="delete",
    )
    await approvals.publish(request, user, effects)
    await change_notifications.deliver(db, request, user.id, intents)

    return {"success": True}


# ---------------------------------------------------------
# Phase / subphase bookings: own dates (unlinked segments)
# ---------------------------------------------------------


async def _check_segment(
    db: AsyncSession,
    level: str,
    target_id: int,
    staff_id: int,
    start_date: date | None,
    end_date: date | None,
    *,
    exclude_id: int | None = None,
) -> None:
    """
    A new or changed phase / subphase booking: own dates inside the card
    (400), and no other booking of the person on the card for overlapping
    effective dates (409; `exclude_id` = the row being changed).
    """
    if start_date is not None and end_date is not None:
        await require_segment_within_card(db, level, target_id, start_date, end_date)
    await approvals.ensure_no_duplicate(
        db,
        level,
        target_id,
        staff_id,
        start_date=start_date,
        end_date=end_date,
        exclude_id=exclude_id,
    )


async def _plan_create(
    db: AsyncSession,
    level: str,
    target_id: int,
    staff_id: int,
    allocation: int,
    start_date: date | None,
    end_date: date | None,
) -> tuple[approvals.PlannedBooking, dict[str, Any]]:
    """
    Where a new phase / subphase booking goes, and its booking values.

    - Own dates given: they stay (inside the card, 400; overlapping another
      booking of the person, 409 ``ALREADY_BOOKED_OVERLAP_DETAIL``).
    - No dates: placed by the server (``approvals.plan_placement``) -- linked
      when the person has no row on the card, else the largest free stretch,
      else the halving of the one booking covering the card (``plan.shrink``,
      shortened only on a direct write), else 409 ``CARD_FULL_DETAIL`` /
      ``ALREADY_PENDING_DETAIL``. The values carry ``placement: "auto"``, so
      an approval re-plans them.
    """
    if start_date is not None and end_date is not None:
        await _check_segment(db, level, target_id, staff_id, start_date, end_date)
        return approvals.PlannedBooking(start_date, end_date), booking_dict(
            allocation, start_date, end_date
        )
    plan = approvals.require_placement(
        await approvals.plan_placement(db, level, target_id, staff_id)
    )
    return plan, booking_dict(
        allocation, plan.start_date, plan.end_date, placement=approvals.AUTO_PLACEMENT
    )


def _requested_update(
    row: PhaseStaffAssignment | SubphaseStaffAssignment,
    data: PhaseStaffAssignmentUpdate | SubphaseStaffAssignmentUpdate,
) -> tuple[dict[str, Any], date | None, date | None, bool]:
    """
    What a phase / subphase PUT asks for: the full booking values (compared
    with ``booking_values(row)``, so a PUT changing nothing is a no-op), the
    new own dates and whether they differ from the row's. A relink of an
    unlinked row carries explicit ``null`` dates.
    """
    allocation = data.allocation if data.allocation is not None else row.allocation
    if data.dates_given:
        start_date, end_date = data.start_date, data.end_date
    else:
        start_date, end_date = row.start_date, row.end_date
    values = booking_dict(
        allocation,
        start_date,
        end_date,
        clear_dates=start_date is None and row.start_date is not None,
    )
    changed = (start_date, end_date) != (row.start_date, row.end_date)
    return values, start_date, end_date, changed


def _segment_response(
    row: PhaseStaffAssignment | SubphaseStaffAssignment, card_start: date, card_end: date
) -> dict[str, Any]:
    """Effective dates (own, else the card's) and ``linked`` of a created booking."""
    start, end, linked = effective_dates(row.start_date, row.end_date, card_start, card_end)
    return {
        "start_date": serialize_date_as_datetime_js(start),
        "end_date": serialize_date_as_datetime_js(end),
        "linked": linked,
    }


# ---------------------------------------------------------
# Phase Staff Assignment Routes
# ---------------------------------------------------------


@router.post("/phases/{phase_id}/staff")
async def create_phase_staff_assignment(
    phase_id: int,
    data: PhaseStaffAssignmentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Assign staff to a phase.

    Matches: POST /api/phases/:phaseId/staff

    Without dates the booking is placed by the server (see the module
    docstring); ``adjusted`` lists the booking it shortened, if any.
    """
    project_id = await project_id_for_phase(db, phase_id)
    await ensure_project_visible(request, db, user, project_id)
    outcome = await resolve_self_booking(
        db,
        user,
        project_id=project_id,
        staff_id=data.staff_id,
        action=ACTION_CREATE,
    )
    await require_bookable_staff(db, data.staff_id)
    plan, values = await _plan_create(
        db, "phase", phase_id, data.staff_id, data.allocation or 100, data.start_date, data.end_date
    )
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_CREATE,
            level="phase",
            project_id=project_id,
            target_id=phase_id,
            values=values,
        )

    effects = approvals.ApprovalEffects()
    shrink_intents = await approvals.apply_shrink(
        db, user, level="phase", plan=plan, effects=effects
    )
    intents = change_notifications.booking_intents(
        user,
        kind="create",
        level="phase",
        project_id=project_id,
        target_id=phase_id,
        staff_id=data.staff_id,
        values=values,
    )
    assignment = PhaseStaffAssignment(
        phase_id=phase_id,
        project_id=project_id,
        staff_id=data.staff_id,
        allocation=data.allocation or 100,
        start_date=plan.start_date,
        end_date=plan.end_date,
    )
    db.add(assignment)
    await db.commit()
    await db.refresh(assignment)

    # Get the assignment with staff details and the card's dates
    result = await db.execute(
        select(
            PhaseStaffAssignment,
            (User.first_name + " " + User.last_name).label("staff_name"),
            User.job_title.label("staff_role"),
            ProjectPhase.start_date,
            ProjectPhase.end_date,
        )
        .join(User, PhaseStaffAssignment.staff_id == User.id)
        .join(ProjectPhase, ProjectPhase.id == PhaseStaffAssignment.phase_id)
        .where(PhaseStaffAssignment.id == assignment.id)
    )
    row = result.first()

    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="staff_assignment",
        entity_id=assignment.id,
        project_id=project_id,
        action="create",
    )
    # The shortened row's update change (and a request it overtook).
    await approvals.publish(request, user, effects)
    await change_notifications.deliver(db, request, user.id, intents + shrink_intents)

    return {
        "id": row[0].id,
        "phase_id": row[0].phase_id,
        "project_id": row[0].project_id,
        "staff_id": row[0].staff_id,
        "allocation": row[0].allocation,
        **_segment_response(row[0], row[3], row[4]),
        "staff_name": row[1],
        "staff_role": row[2],
        "adjusted": approvals.adjusted_rows(plan),
    }


@router.put("/phase-staff/{assignment_id}")
async def update_phase_staff_assignment(
    assignment_id: int,
    data: PhaseStaffAssignmentUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Update a phase staff assignment.

    Matches: PUT /api/phase-staff/:id
    """
    result = await db.execute(
        select(PhaseStaffAssignment).where(PhaseStaffAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()

    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    project_id = assignment.project_id
    await ensure_project_visible(request, db, user, project_id)
    outcome = await approvals.resolve_row_write(db, user, row=assignment, action=ACTION_UPDATE)
    values, start_date, end_date, dates_changed = _requested_update(assignment, data)
    if dates_changed:
        await _check_segment(
            db,
            "phase",
            assignment.phase_id,
            assignment.staff_id,
            start_date,
            end_date,
            exclude_id=assignment.id,
        )
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_UPDATE,
            level="phase",
            project_id=project_id,
            row=assignment,
            values=values,
        )
    effects = await approvals.expire_overtaken(db, user, level="phase", row=assignment)
    intents = change_notifications.booking_intents(
        user,
        kind="update",
        level="phase",
        project_id=project_id,
        target_id=assignment.phase_id,
        staff_id=assignment.staff_id,
        values=values,
        previous=booking_values(assignment, "phase"),
    )

    assignment.allocation = values["allocation"]
    assignment.start_date = start_date
    assignment.end_date = end_date

    await db.commit()

    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="staff_assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="update",
    )
    await approvals.publish(request, user, effects)
    await change_notifications.deliver(db, request, user.id, intents)

    return {"success": True, "linked": start_date is None}


@router.delete("/phase-staff/{assignment_id}")
async def delete_phase_staff_assignment(
    assignment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Delete a phase staff assignment.

    Matches: DELETE /api/phase-staff/:id
    """
    result = await db.execute(
        select(PhaseStaffAssignment).where(PhaseStaffAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()

    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    project_id = assignment.project_id
    await ensure_project_visible(request, db, user, project_id)
    outcome = await approvals.resolve_row_write(db, user, row=assignment, action=ACTION_REMOVE)
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_REMOVE,
            level="phase",
            project_id=project_id,
            row=assignment,
        )
    effects = await approvals.expire_overtaken(db, user, level="phase", row=assignment)
    intents = change_notifications.booking_intents(
        user,
        kind="remove",
        level="phase",
        project_id=project_id,
        target_id=assignment.phase_id,
        staff_id=assignment.staff_id,
        previous=booking_values(assignment, "phase"),
    )

    await db.delete(assignment)
    await db.commit()

    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="staff_assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="delete",
    )
    await approvals.publish(request, user, effects)
    await change_notifications.deliver(db, request, user.id, intents)

    return {"success": True}


# ---------------------------------------------------------
# Subphase Staff Assignment Routes
# ---------------------------------------------------------


@router.post("/subphases/{subphase_id}/staff")
async def create_subphase_staff_assignment(
    subphase_id: int,
    data: SubphaseStaffAssignmentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Assign staff to a subphase.

    Matches: POST /api/subphases/:subphaseId/staff

    Without dates the booking is placed by the server (see the module
    docstring); ``adjusted`` lists the booking it shortened, if any.
    """
    project_id = await project_id_for_subphase(db, subphase_id)
    await ensure_project_visible(request, db, user, project_id)
    outcome = await resolve_self_booking(
        db,
        user,
        project_id=project_id,
        staff_id=data.staff_id,
        action=ACTION_CREATE,
    )
    await require_bookable_staff(db, data.staff_id)
    plan, values = await _plan_create(
        db,
        "subphase",
        subphase_id,
        data.staff_id,
        data.allocation or 100,
        data.start_date,
        data.end_date,
    )
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_CREATE,
            level="subphase",
            project_id=project_id,
            target_id=subphase_id,
            values=values,
        )

    effects = approvals.ApprovalEffects()
    shrink_intents = await approvals.apply_shrink(
        db, user, level="subphase", plan=plan, effects=effects
    )
    intents = change_notifications.booking_intents(
        user,
        kind="create",
        level="subphase",
        project_id=project_id,
        target_id=subphase_id,
        staff_id=data.staff_id,
        values=values,
    )
    assignment = SubphaseStaffAssignment(
        subphase_id=subphase_id,
        project_id=project_id,
        staff_id=data.staff_id,
        allocation=data.allocation or 100,
        start_date=plan.start_date,
        end_date=plan.end_date,
    )
    db.add(assignment)
    await db.commit()
    await db.refresh(assignment)

    # Get the assignment with staff details and the card's dates
    result = await db.execute(
        select(
            SubphaseStaffAssignment,
            (User.first_name + " " + User.last_name).label("staff_name"),
            User.job_title.label("staff_role"),
            ProjectSubphase.start_date,
            ProjectSubphase.end_date,
        )
        .join(User, SubphaseStaffAssignment.staff_id == User.id)
        .join(ProjectSubphase, ProjectSubphase.id == SubphaseStaffAssignment.subphase_id)
        .where(SubphaseStaffAssignment.id == assignment.id)
    )
    row = result.first()

    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="staff_assignment",
        entity_id=assignment.id,
        project_id=project_id,
        action="create",
    )
    # The shortened row's update change (and a request it overtook).
    await approvals.publish(request, user, effects)
    await change_notifications.deliver(db, request, user.id, intents + shrink_intents)

    return {
        "id": row[0].id,
        "subphase_id": row[0].subphase_id,
        "project_id": row[0].project_id,
        "staff_id": row[0].staff_id,
        "allocation": row[0].allocation,
        **_segment_response(row[0], row[3], row[4]),
        "staff_name": row[1],
        "staff_role": row[2],
        "adjusted": approvals.adjusted_rows(plan),
    }


@router.put("/subphase-staff/{assignment_id}")
async def update_subphase_staff_assignment(
    assignment_id: int,
    data: SubphaseStaffAssignmentUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Update a subphase staff assignment.

    Matches: PUT /api/subphase-staff/:id
    """
    result = await db.execute(
        select(SubphaseStaffAssignment).where(SubphaseStaffAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()

    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    project_id = assignment.project_id
    await ensure_project_visible(request, db, user, project_id)
    outcome = await approvals.resolve_row_write(db, user, row=assignment, action=ACTION_UPDATE)
    values, start_date, end_date, dates_changed = _requested_update(assignment, data)
    if dates_changed:
        await _check_segment(
            db,
            "subphase",
            assignment.subphase_id,
            assignment.staff_id,
            start_date,
            end_date,
            exclude_id=assignment.id,
        )
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_UPDATE,
            level="subphase",
            project_id=project_id,
            row=assignment,
            values=values,
        )
    effects = await approvals.expire_overtaken(db, user, level="subphase", row=assignment)
    intents = change_notifications.booking_intents(
        user,
        kind="update",
        level="subphase",
        project_id=project_id,
        target_id=assignment.subphase_id,
        staff_id=assignment.staff_id,
        values=values,
        previous=booking_values(assignment, "subphase"),
    )

    assignment.allocation = values["allocation"]
    assignment.start_date = start_date
    assignment.end_date = end_date

    await db.commit()

    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="staff_assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="update",
    )
    await approvals.publish(request, user, effects)
    await change_notifications.deliver(db, request, user.id, intents)

    return {"success": True, "linked": start_date is None}


@router.delete("/subphase-staff/{assignment_id}")
async def delete_subphase_staff_assignment(
    assignment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Delete a subphase staff assignment.

    Matches: DELETE /api/subphase-staff/:id
    """
    result = await db.execute(
        select(SubphaseStaffAssignment).where(SubphaseStaffAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()

    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")

    project_id = assignment.project_id
    await ensure_project_visible(request, db, user, project_id)
    outcome = await approvals.resolve_row_write(db, user, row=assignment, action=ACTION_REMOVE)
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_REMOVE,
            level="subphase",
            project_id=project_id,
            row=assignment,
        )
    effects = await approvals.expire_overtaken(db, user, level="subphase", row=assignment)
    intents = change_notifications.booking_intents(
        user,
        kind="remove",
        level="subphase",
        project_id=project_id,
        target_id=assignment.subphase_id,
        staff_id=assignment.staff_id,
        previous=booking_values(assignment, "subphase"),
    )

    await db.delete(assignment)
    await db.commit()

    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="staff_assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="delete",
    )
    await approvals.publish(request, user, effects)
    await change_notifications.deliver(db, request, user.id, intents)

    return {"success": True}


# ---------------------------------------------------------
# Equipment Assignment Routes
# ---------------------------------------------------------


@router.post("/projects/{project_id}/equipment")
async def create_equipment_assignment(
    project_id: int,
    data: EquipmentAssignmentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Assign equipment to a project: ``equipment_bookings.manage`` (or the PM).
    The equipment must be linked to the project's site (`equipment_sites`).

    Matches: POST /api/projects/:projectId/equipment
    """
    await ensure_project_visible(request, db, user, project_id)
    await require_on_project(db, user, "equipment_bookings.manage", project_id)

    project_row = (
        await db.execute(select(Project.site_id).where(Project.id == project_id))
    ).first()
    if project_row is None:
        raise HTTPException(status_code=404, detail="Project not found")

    equipment = (
        await db.execute(select(Equipment).where(Equipment.id == data.equipment_id))
    ).scalar_one_or_none()
    if equipment is None:
        raise HTTPException(status_code=404, detail="Equipment not found")
    if project_row[0] not in equipment.site_ids:
        raise HTTPException(
            status_code=400, detail="Equipment is not available at this project's site"
        )

    intents = change_notifications.equipment_intents(
        user,
        kind="create",
        project_id=project_id,
        equipment_name=equipment.name,
        body=f"from {data.start_date} to {data.end_date}",
    )
    assignment = EquipmentAssignment(
        project_id=project_id,
        equipment_id=data.equipment_id,
        start_date=data.start_date,
        end_date=data.end_date,
    )
    db.add(assignment)
    await db.commit()
    await db.refresh(assignment)

    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="equipment_assignment",
        entity_id=assignment.id,
        project_id=project_id,
        action="create",
    )
    await change_notifications.deliver(db, request, user.id, intents)

    return {"id": assignment.id, "success": True}
