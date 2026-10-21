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

A booking awaiting approval is a real row (``approval_status = 'pending'``):
a second booking of the same person on the target is a 409 (pending or not;
at project level only with the same dates), and a direct write on a pending
row is a 409 (decide the request instead). A direct write on a row with an
open change / removal request closes that request (``expired(overtaken)``).
Equipment bookings need ``equipment_bookings.manage`` (also in the PM bundle).
"""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
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
from app.models.project import Project
from app.models.user import User
from app.schemas.base import (
    DateRangeOrdered,
    serialize_date_as_datetime_js,
    serialize_datetime_js,
)
from app.services import approvals
from app.services.approvals import ACTION_CREATE, ACTION_REMOVE, ACTION_UPDATE, booking_dict
from app.services.project_access import (
    project_id_for_phase,
    project_id_for_subphase,
    project_pm_id,
    require_on_project,
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


class PhaseStaffAssignmentCreate(BaseModel):
    """Request to assign staff to a phase.

    `project_id` is accepted for wire compatibility but ignored: the server
    resolves it from the phase.
    """

    staff_id: int
    project_id: int
    # null keeps the historical meaning "full time" (100).
    allocation: Allocation | None = 100


class PhaseStaffAssignmentUpdate(BaseModel):
    """Request to update a phase staff assignment."""

    allocation: Allocation


class SubphaseStaffAssignmentCreate(BaseModel):
    """Request to assign staff to a subphase.

    `project_id` is accepted for wire compatibility but ignored: the server
    resolves it from the subphase.
    """

    staff_id: int
    project_id: int
    allocation: Allocation | None = 100


class SubphaseStaffAssignmentUpdate(BaseModel):
    """Request to update a subphase staff assignment."""

    allocation: Allocation


class EquipmentAssignmentCreate(DateRangeOrdered):
    """Request to assign equipment to a project."""

    equipment_id: int
    start_date: date
    end_date: date


async def _require_staff(db: AsyncSession, staff_id: int) -> None:
    """404 for an unknown staff member (instead of an FK violation -> 500)."""
    found = (await db.execute(select(User.id).where(User.id == staff_id))).scalar_one_or_none()
    if found is None:
        raise HTTPException(status_code=404, detail="Staff member not found")


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
    await _require_staff(db, data.staff_id)
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

    return {"success": True}


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
    await _require_staff(db, data.staff_id)
    await approvals.ensure_no_duplicate(db, "phase", phase_id, data.staff_id)
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_CREATE,
            level="phase",
            project_id=project_id,
            target_id=phase_id,
            values=booking_dict(data.allocation or 100),
        )

    assignment = PhaseStaffAssignment(
        phase_id=phase_id,
        project_id=project_id,
        staff_id=data.staff_id,
        allocation=data.allocation or 100,
    )
    db.add(assignment)
    await db.commit()
    await db.refresh(assignment)

    # Get the assignment with staff details
    result = await db.execute(
        select(
            PhaseStaffAssignment,
            (User.first_name + " " + User.last_name).label("staff_name"),
            User.job_title.label("staff_role"),
        )
        .join(User, PhaseStaffAssignment.staff_id == User.id)
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

    return {
        "id": row[0].id,
        "phase_id": row[0].phase_id,
        "project_id": row[0].project_id,
        "staff_id": row[0].staff_id,
        "allocation": row[0].allocation,
        "staff_name": row[1],
        "staff_role": row[2],
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
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_UPDATE,
            level="phase",
            project_id=project_id,
            row=assignment,
            values=booking_dict(data.allocation),
        )
    effects = await approvals.expire_overtaken(db, user, level="phase", row=assignment)

    assignment.allocation = data.allocation

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

    return {"success": True}


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
    await _require_staff(db, data.staff_id)
    await approvals.ensure_no_duplicate(db, "subphase", subphase_id, data.staff_id)
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_CREATE,
            level="subphase",
            project_id=project_id,
            target_id=subphase_id,
            values=booking_dict(data.allocation or 100),
        )

    assignment = SubphaseStaffAssignment(
        subphase_id=subphase_id,
        project_id=project_id,
        staff_id=data.staff_id,
        allocation=data.allocation or 100,
    )
    db.add(assignment)
    await db.commit()
    await db.refresh(assignment)

    # Get the assignment with staff details
    result = await db.execute(
        select(
            SubphaseStaffAssignment,
            (User.first_name + " " + User.last_name).label("staff_name"),
            User.job_title.label("staff_role"),
        )
        .join(User, SubphaseStaffAssignment.staff_id == User.id)
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

    return {
        "id": row[0].id,
        "subphase_id": row[0].subphase_id,
        "project_id": row[0].project_id,
        "staff_id": row[0].staff_id,
        "allocation": row[0].allocation,
        "staff_name": row[1],
        "staff_role": row[2],
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
    if outcome == "approval":
        return await approvals.submit_request(
            db,
            request,
            user,
            action=ACTION_UPDATE,
            level="subphase",
            project_id=project_id,
            row=assignment,
            values=booking_dict(data.allocation),
        )
    effects = await approvals.expire_overtaken(db, user, level="subphase", row=assignment)

    assignment.allocation = data.allocation

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

    return {"success": True}


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

    return {"id": assignment.id, "success": True}
