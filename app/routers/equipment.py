"""
Equipment API router.
Handles equipment and equipment assignment operations.

Matches the Node.js API at /api/equipment exactly.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.equipment import Equipment, EquipmentAssignment
from app.models.site import Site
from app.models.user import User
from app.middleware.auth import get_current_user, require_admin, require_superuser
from app.schemas.equipment import (
    EquipmentResponse,
    EquipmentCreate,
    EquipmentUpdate,
    EquipmentAssignmentResponse,
    EquipmentAssignmentCreate,
    EquipmentAssignmentUpdate,
)

router = APIRouter()


def build_equipment_response(equipment: Equipment) -> dict:
    """Build equipment response dict with site info."""
    return {
        "id": equipment.id,
        "name": equipment.name,
        "type": equipment.type,
        "site_id": equipment.site_id,
        "site_name": equipment.site.name if equipment.site else None,
        "description": equipment.description,
        "active": equipment.active,
        "created_at": equipment.created_at,
    }


@router.get("/equipment", response_model=List[EquipmentResponse])
async def get_equipment(
    siteId: Optional[int] = Query(None),
    includeAllSites: Optional[bool] = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get equipment list.
    
    If siteId provided, returns equipment for that site.
    If includeAllSites=true, returns all equipment.
    
    Matches: GET /api/equipment
    """
    query = select(Equipment).where(Equipment.active == 1)
    
    if not includeAllSites and siteId:
        query = query.where(Equipment.site_id == siteId)
    
    query = query.options(selectinload(Equipment.site)).order_by(Equipment.name)
    
    result = await db.execute(query)
    equipment_list = result.scalars().all()
    
    return [build_equipment_response(e) for e in equipment_list]


@router.get("/equipment/all", response_model=List[EquipmentResponse])
async def get_all_equipment(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Get all equipment including inactive.
    
    Requires admin authentication.
    Matches: GET /api/equipment/all
    """
    result = await db.execute(
        select(Equipment)
        .options(selectinload(Equipment.site))
        .order_by(Equipment.name)
    )
    equipment_list = result.scalars().all()
    
    return [build_equipment_response(e) for e in equipment_list]


@router.get("/equipment/{equipment_id}", response_model=EquipmentResponse)
async def get_equipment_by_id(
    equipment_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get a specific equipment by ID.
    
    Matches: GET /api/equipment/:id
    """
    result = await db.execute(
        select(Equipment)
        .where(Equipment.id == equipment_id)
        .options(selectinload(Equipment.site))
    )
    equipment = result.scalar_one_or_none()
    
    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")
    
    return build_equipment_response(equipment)


@router.post("/equipment", response_model=EquipmentResponse, status_code=201)
async def create_equipment(
    data: EquipmentCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Create new equipment.
    
    Requires admin authentication.
    Matches: POST /api/equipment
    """
    equipment = Equipment(
        name=data.name,
        type=data.type,
        site_id=data.site_id,
        description=data.description,
        active=1,
    )
    
    db.add(equipment)
    await db.commit()
    await db.refresh(equipment)
    
    # Load site relationship
    if equipment.site_id:
        result = await db.execute(
            select(Site).where(Site.id == equipment.site_id)
        )
        equipment.site = result.scalar_one_or_none()
    
    return build_equipment_response(equipment)


@router.put("/equipment/{equipment_id}", response_model=EquipmentResponse)
async def update_equipment(
    equipment_id: int,
    data: EquipmentUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Update equipment.
    
    Requires admin authentication.
    Matches: PUT /api/equipment/:id
    """
    result = await db.execute(
        select(Equipment)
        .where(Equipment.id == equipment_id)
        .options(selectinload(Equipment.site))
    )
    equipment = result.scalar_one_or_none()
    
    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")
    
    # Update fields
    if data.name is not None:
        equipment.name = data.name
    if data.type is not None:
        equipment.type = data.type
    if data.site_id is not None:
        equipment.site_id = data.site_id
    if data.description is not None:
        equipment.description = data.description
    if data.active is not None:
        equipment.active = data.active
    
    await db.commit()
    await db.refresh(equipment)
    
    # Reload site relationship
    if equipment.site_id:
        result = await db.execute(
            select(Site).where(Site.id == equipment.site_id)
        )
        equipment.site = result.scalar_one_or_none()
    
    return build_equipment_response(equipment)


@router.delete("/equipment/{equipment_id}")
async def delete_equipment(
    equipment_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Delete equipment.
    
    Requires admin authentication.
    Matches: DELETE /api/equipment/:id
    """
    result = await db.execute(
        select(Equipment).where(Equipment.id == equipment_id)
    )
    equipment = result.scalar_one_or_none()
    
    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")
    
    await db.delete(equipment)
    await db.commit()
    
    return {"success": True}


# ---------------------------------------------------------
# Equipment Assignments
# ---------------------------------------------------------

@router.get("/equipment/{equipment_id}/assignments", response_model=List[EquipmentAssignmentResponse])
async def get_equipment_assignments(
    equipment_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get assignments for a specific equipment.
    
    Matches: GET /api/equipment/:id/assignments
    """
    result = await db.execute(
        select(EquipmentAssignment)
        .where(EquipmentAssignment.equipment_id == equipment_id)
        .options(
            selectinload(EquipmentAssignment.equipment),
            selectinload(EquipmentAssignment.project),
        )
        .order_by(EquipmentAssignment.start_date)
    )
    assignments = result.scalars().all()
    
    return [
        EquipmentAssignmentResponse(
            id=a.id,
            project_id=a.project_id,
            project_name=a.project.name if a.project else None,
            project_site_id=a.project.site_id if a.project else None,
            equipment_id=a.equipment_id,
            start_date=a.start_date,
            end_date=a.end_date,
            created_at=a.created_at,
        )
        for a in assignments
    ]


@router.put("/equipment-assignments/{assignment_id}", response_model=EquipmentAssignmentResponse)
async def update_equipment_assignment(
    assignment_id: int,
    data: EquipmentAssignmentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Update an equipment assignment.
    
    Requires admin or superuser authentication.
    Matches: PUT /api/equipment-assignments/:id
    """
    result = await db.execute(
        select(EquipmentAssignment)
        .where(EquipmentAssignment.id == assignment_id)
        .options(
            selectinload(EquipmentAssignment.equipment),
            selectinload(EquipmentAssignment.project),
        )
    )
    assignment = result.scalar_one_or_none()
    
    if not assignment:
        raise HTTPException(status_code=404, detail="Equipment assignment not found")
    
    # Update fields
    if data.equipment_id is not None:
        assignment.equipment_id = data.equipment_id
    if data.start_date is not None:
        assignment.start_date = data.start_date
    if data.end_date is not None:
        assignment.end_date = data.end_date
    
    await db.commit()
    await db.refresh(assignment)
    
    # Reload project relationship
    result = await db.execute(
        select(EquipmentAssignment)
        .where(EquipmentAssignment.id == assignment_id)
        .options(selectinload(EquipmentAssignment.project))
    )
    assignment = result.scalar_one()
    
    return EquipmentAssignmentResponse(
        id=assignment.id,
        project_id=assignment.project_id,
        project_name=assignment.project.name if assignment.project else None,
        project_site_id=assignment.project.site_id if assignment.project else None,
        equipment_id=assignment.equipment_id,
        start_date=assignment.start_date,
        end_date=assignment.end_date,
        created_at=assignment.created_at,
    )


@router.delete("/equipment-assignments/{assignment_id}")
async def delete_equipment_assignment(
    assignment_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Delete an equipment assignment.
    
    Requires admin or superuser authentication.
    Matches: DELETE /api/equipment-assignments/:id
    """
    result = await db.execute(
        select(EquipmentAssignment).where(EquipmentAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()
    
    if not assignment:
        raise HTTPException(status_code=404, detail="Equipment assignment not found")
    
    await db.delete(assignment)
    await db.commit()
    
    return {"success": True}


@router.get("/equipment/{equipment_id}/availability")
async def get_equipment_availability(
    equipment_id: int,
    startDate: str = Query(...),
    endDate: str = Query(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get equipment availability for a date range.
    
    Matches: GET /api/equipment/:id/availability
    """
    from datetime import datetime, timedelta, date as date_type
    
    # Parse dates
    start = datetime.strptime(startDate, "%Y-%m-%d").date()
    end = datetime.strptime(endDate, "%Y-%m-%d").date()
    
    # Get assignments in range - use proper date types for comparison
    result = await db.execute(
        select(EquipmentAssignment)
        .where(EquipmentAssignment.equipment_id == equipment_id)
        .where(EquipmentAssignment.start_date <= end)  # Use date object, not string
        .where(EquipmentAssignment.end_date >= start)  # Use date object, not string
    )
    assignments = result.scalars().all()
    
    # Calculate daily availability
    availability = []
    current = start
    while current <= end:
        date_str = current.strftime("%Y-%m-%d")
        occupied = False
        
        for a in assignments:
            if a.start_date <= current <= a.end_date:
                occupied = True
                break
        
        availability.append({
            "date": date_str,
            "occupied": occupied,
            "available": not occupied,
        })
        
        current += timedelta(days=1)
    
    return availability
