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
- PUT /api/equipment-assignments/:id
- DELETE /api/equipment-assignments/:id
"""

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_superuser
from app.models.user import User
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.assignment import (
    ProjectAssignment,
    PhaseStaffAssignment,
    SubphaseStaffAssignment,
)
from app.models.equipment import EquipmentAssignment
from app.schemas.base import (
    serialize_datetime_js,
    serialize_date_as_datetime_js,
)
from app.websocket.broadcast import broadcast_change

router = APIRouter(tags=["assignments"])


# ---------------------------------------------------------
# Request/Response Models
# ---------------------------------------------------------

class ProjectStaffAssignmentCreate(BaseModel):
    """Request to assign staff to a project."""
    staff_id: int
    allocation: int = 100
    start_date: date
    end_date: date


class ProjectStaffAssignmentUpdate(BaseModel):
    """Request to update a project staff assignment."""
    allocation: int
    start_date: date
    end_date: date


class PhaseStaffAssignmentCreate(BaseModel):
    """Request to assign staff to a phase."""
    staff_id: int
    project_id: int
    allocation: Optional[int] = 100


class PhaseStaffAssignmentUpdate(BaseModel):
    """Request to update a phase staff assignment."""
    allocation: int


class SubphaseStaffAssignmentCreate(BaseModel):
    """Request to assign staff to a subphase."""
    staff_id: int
    project_id: int
    allocation: Optional[int] = 100


class SubphaseStaffAssignmentUpdate(BaseModel):
    """Request to update a subphase staff assignment."""
    allocation: int


class EquipmentAssignmentCreate(BaseModel):
    """Request to assign equipment to a project."""
    equipment_id: int
    start_date: date
    end_date: date


class EquipmentAssignmentUpdate(BaseModel):
    """Request to update an equipment assignment."""
    start_date: date
    end_date: date


# ---------------------------------------------------------
# Project Staff Assignment Routes
# ---------------------------------------------------------

@router.get("/staff/{staff_id}/assignments")
async def get_staff_assignments(
    staff_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get all project assignments for a staff member.
    
    Matches: GET /api/staff/:id/assignments
    """
    result = await db.execute(
        select(
            ProjectAssignment,
            Project.name.label("project_name"),
            Project.site_id.label("project_site_id"),
        )
        .join(Project, ProjectAssignment.project_id == Project.id)
        .where(ProjectAssignment.staff_id == staff_id)
        .order_by(ProjectAssignment.start_date)
    )
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
    user: User = Depends(require_superuser),
):
    """
    Assign staff to a project.
    
    Matches: POST /api/projects/:projectId/staff
    """
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
        entity_type="assignment",
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
    user: User = Depends(require_superuser),
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
    
    assignment.allocation = data.allocation
    assignment.start_date = data.start_date
    assignment.end_date = data.end_date
    
    await db.commit()
    
    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="update",
    )
    
    return {"success": True}


@router.delete("/assignments/{assignment_id}")
async def delete_project_staff_assignment(
    assignment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
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
    
    await db.delete(assignment)
    await db.commit()
    
    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="delete",
    )
    
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
    user: User = Depends(require_superuser),
):
    """
    Assign staff to a phase.
    
    Matches: POST /api/phases/:phaseId/staff
    """
    assignment = PhaseStaffAssignment(
        phase_id=phase_id,
        project_id=data.project_id,
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
        entity_type="assignment",
        entity_id=assignment.id,
        project_id=data.project_id,
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
    user: User = Depends(require_superuser),
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
    
    assignment.allocation = data.allocation
    
    await db.commit()
    
    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="update",
    )
    
    return {"success": True}


@router.delete("/phase-staff/{assignment_id}")
async def delete_phase_staff_assignment(
    assignment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
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
    
    await db.delete(assignment)
    await db.commit()
    
    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="delete",
    )
    
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
    user: User = Depends(require_superuser),
):
    """
    Assign staff to a subphase.
    
    Matches: POST /api/subphases/:subphaseId/staff
    """
    assignment = SubphaseStaffAssignment(
        subphase_id=subphase_id,
        project_id=data.project_id,
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
        entity_type="assignment",
        entity_id=assignment.id,
        project_id=data.project_id,
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
    user: User = Depends(require_superuser),
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
    
    assignment.allocation = data.allocation
    
    await db.commit()
    
    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="update",
    )
    
    return {"success": True}


@router.delete("/subphase-staff/{assignment_id}")
async def delete_subphase_staff_assignment(
    assignment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
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
    
    await db.delete(assignment)
    await db.commit()
    
    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="delete",
    )
    
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
    user: User = Depends(require_superuser),
):
    """
    Assign equipment to a project.
    
    Matches: POST /api/projects/:projectId/equipment
    """
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
        entity_type="assignment",
        entity_id=assignment.id,
        project_id=project_id,
        action="create",
    )
    
    return {"id": assignment.id, "success": True}


@router.put("/equipment-assignments/{assignment_id}")
async def update_equipment_assignment(
    assignment_id: int,
    data: EquipmentAssignmentUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Update an equipment assignment.
    
    Matches: PUT /api/equipment-assignments/:id
    """
    result = await db.execute(
        select(EquipmentAssignment).where(EquipmentAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()
    
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")
    
    project_id = assignment.project_id
    
    assignment.start_date = data.start_date
    assignment.end_date = data.end_date
    
    await db.commit()
    
    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="update",
    )
    
    return {"success": True}


@router.delete("/equipment-assignments/{assignment_id}")
async def delete_equipment_assignment(
    assignment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Delete an equipment assignment.
    
    Matches: DELETE /api/equipment-assignments/:id
    """
    result = await db.execute(
        select(EquipmentAssignment).where(EquipmentAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()
    
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")
    
    project_id = assignment.project_id
    
    await db.delete(assignment)
    await db.commit()
    
    # Broadcast change
    await broadcast_change(
        request=request,
        user=user,
        entity_type="assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="delete",
    )
    
    return {"success": True}
