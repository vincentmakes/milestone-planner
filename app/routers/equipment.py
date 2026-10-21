"""
Equipment API router.
Handles equipment and equipment assignment operations.

Matches the Node.js API at /api/equipment exactly.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.middleware.auth import get_current_user, require_superuser
from app.models.equipment import Equipment, EquipmentAssignment, EquipmentBlock, EquipmentSite
from app.models.site import Site
from app.models.user import User
from app.schemas.equipment import (
    EquipmentAssignmentResponse,
    EquipmentAssignmentUpdate,
    EquipmentBlockCreate,
    EquipmentBlockResponse,
    EquipmentBlockUpdate,
    EquipmentCreate,
    EquipmentResponse,
    EquipmentUpdate,
)
from app.services.date_range import ensure_date_order, parse_day_range
from app.services.project_access import require_project_editor
from app.services.site_access import can_access_sites, ensure_site_access
from app.services.team_rules import (
    ensure_teams_within_sites,
    load_teams,
    prune_teams_to_sites,
    team_outside_sites_detail,
)
from app.websocket.broadcast import broadcast_change

router = APIRouter()

EQUIPMENT_SITE_ACCESS_DETAIL = "You can only manage equipment for sites you're assigned to"


# ---------------------------------------------------------
# Equipment Types (derived from equipment.type field)
# ---------------------------------------------------------


EQUIPMENT_TYPE_ACCESS_DETAIL = (
    "This equipment type is also used at sites you're not assigned to; ask an administrator"
)


def _ensure_type_access(user: User, equipment_list) -> None:
    """
    403 unless the user may manage every piece of equipment of a type.

    Same rule as _ensure_equipment_access per item (admins anything,
    superusers only equipment whose every site is theirs).
    """
    if user.is_admin:
        return
    for equipment in equipment_list:
        if not equipment.site_ids or not can_access_sites(user, equipment.site_ids):
            raise HTTPException(status_code=403, detail=EQUIPMENT_TYPE_ACCESS_DETAIL)


@router.get("/equipment-types", response_model=list[str])
async def get_equipment_types(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get all unique equipment types.

    Returns a list of unique type strings from all equipment.
    """
    from sqlalchemy import distinct

    result = await db.execute(
        select(distinct(Equipment.type))
        .where(Equipment.type.isnot(None))
        .where(Equipment.type != "")
        .order_by(Equipment.type)
    )
    types = result.scalars().all()

    return list(types)


@router.put("/equipment-types/{old_type}")
async def rename_equipment_type(
    old_type: str,
    new_type: str = Query(..., description="New type name"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Rename an equipment type.

    Updates all equipment with the old type to use the new type. Types are
    tenant-wide, so a superuser may only rename one whose every piece of
    equipment is within their sites (otherwise they would silently rename
    other sites' equipment); admins may rename any.
    """
    from sqlalchemy import update

    if not new_type.strip():
        raise HTTPException(status_code=400, detail="New type name cannot be empty")

    # Check if old type exists
    result = await db.execute(select(Equipment).where(Equipment.type == old_type))
    equipment_list = result.scalars().all()

    if not equipment_list:
        raise HTTPException(status_code=404, detail=f"No equipment found with type '{old_type}'")

    _ensure_type_access(user, equipment_list)

    # Update all equipment with this type
    await db.execute(
        update(Equipment).where(Equipment.type == old_type).values(type=new_type.strip())
    )

    await db.commit()

    return {
        "success": True,
        "old_type": old_type,
        "new_type": new_type.strip(),
        "updated_count": len(equipment_list),
    }


@router.delete("/equipment-types/{type_name}")
async def delete_equipment_type(
    type_name: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Delete an equipment type.

    Only succeeds if no equipment uses this type (409 otherwise). A superuser
    asking about a type used outside their sites gets 403, like a rename.
    """
    # Check if any equipment uses this type
    result = await db.execute(select(Equipment).where(Equipment.type == type_name))
    equipment_list = result.scalars().all()

    if equipment_list:
        _ensure_type_access(user, equipment_list)
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete type '{type_name}': {len(equipment_list)} equipment item(s) still use this type",
        )

    # Type doesn't exist in any equipment - nothing to delete really
    # This endpoint is mainly for UI consistency
    return {"success": True, "type": type_name}


def build_equipment_response(equipment: Equipment, site: Site | None = None) -> dict:
    """
    Build an equipment response dict with site info.

    ``site`` is the row's site in per-site listings (one row per equipment-site
    pair); otherwise the primary site (equipment.site_id, the first linked one).
    """
    if site is None:
        site = next((s for s in equipment.sites if s.id == equipment.site_id), None)
        if site is None and equipment.sites:
            site = equipment.sites[0]
    return {
        "id": equipment.id,
        "name": equipment.name,
        "type": equipment.type,
        "site_id": site.id if site else equipment.site_id,
        "site_name": site.name if site else None,
        "site_ids": equipment.site_ids,
        "site_names": [s.name for s in equipment.sites],
        "team_ids": equipment.team_ids,
        "team_names": [t.name for t in equipment.teams],
        "description": equipment.description,
        "active": equipment.active,
        "created_at": equipment.created_at,
    }


def _ensure_equipment_access(user: User, site_ids: list[int]) -> None:
    """
    403 unless the user may manage equipment on every given site.

    Equipment without any site (legacy orphan) can only be managed by admins.
    """
    if not site_ids and not user.is_admin:
        raise HTTPException(status_code=403, detail=EQUIPMENT_SITE_ACCESS_DETAIL)
    ensure_site_access(user, site_ids, EQUIPMENT_SITE_ACCESS_DETAIL)


async def _load_sites(db: AsyncSession, site_ids: list[int]) -> list[Site]:
    """Return the de-duplicated sites ordered by id; 404 if any does not exist."""
    wanted = sorted(set(site_ids))
    result = await db.execute(select(Site).where(Site.id.in_(wanted)).order_by(Site.id))
    sites = list(result.scalars().all())
    if {s.id for s in sites} != set(wanted):
        raise HTTPException(status_code=404, detail="Site not found")
    return sites


@router.get("/equipment", response_model=list[EquipmentResponse])
async def get_equipment(
    siteId: int | None = Query(None),
    includeAllSites: bool | None = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get active equipment.

    If siteId provided, returns equipment linked to that site.
    If includeAllSites=true, returns all equipment.

    Like GET /staff, returns one row per equipment-site pair: equipment shared
    by several sites appears once per site, with that site as ``site_id`` and
    every linked site in ``site_ids``.

    Matches: GET /api/equipment
    """
    query = (
        select(Equipment, Site)
        .outerjoin(EquipmentSite, EquipmentSite.equipment_id == Equipment.id)
        .outerjoin(Site, EquipmentSite.site_id == Site.id)
        .where(Equipment.active == 1)
        .order_by(Equipment.name, Equipment.id, Site.id)
    )

    if siteId and not includeAllSites:
        query = query.where(EquipmentSite.site_id == siteId)

    result = await db.execute(query)
    rows = result.all()

    return [build_equipment_response(equipment, site) for equipment, site in rows]


@router.get("/equipment/all", response_model=list[EquipmentResponse])
async def get_all_equipment(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Get all equipment including inactive, one row per equipment.

    Requires admin or superuser authentication.
    Matches: GET /api/equipment/all
    """
    result = await db.execute(select(Equipment).order_by(Equipment.name))
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
    result = await db.execute(select(Equipment).where(Equipment.id == equipment_id))
    equipment = result.scalar_one_or_none()

    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")

    return build_equipment_response(equipment)


@router.post("/equipment", response_model=EquipmentResponse, status_code=201)
async def create_equipment(
    data: EquipmentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Create new equipment on one or more sites.

    Requires admin or superuser authentication.
    Superusers can only create equipment in sites they're assigned to.
    Matches: POST /api/equipment
    """
    sites = await _load_sites(db, data.resolved_site_ids)
    _ensure_equipment_access(user, [s.id for s in sites])
    teams = await load_teams(db, data.team_ids or [])
    ensure_teams_within_sites(teams, [s.id for s in sites], team_outside_sites_detail)

    equipment = Equipment(
        name=data.name,
        type=data.type,
        site_id=sites[0].id,
        description=data.description,
        active=1,
    )
    equipment.sites = sites
    equipment.teams = teams

    db.add(equipment)
    await db.commit()
    await db.refresh(equipment)

    return build_equipment_response(equipment)


@router.put("/equipment/{equipment_id}", response_model=EquipmentResponse)
async def update_equipment(
    equipment_id: int,
    data: EquipmentUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Update equipment. ``site_ids``, when given, replaces its site links;
    ``team_ids``, when given, replaces its teams.

    Requires admin or superuser authentication.
    Superusers must belong to every site the equipment is linked to, before
    and after the change.
    Matches: PUT /api/equipment/:id
    """
    result = await db.execute(select(Equipment).where(Equipment.id == equipment_id))
    equipment = result.scalar_one_or_none()

    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")

    _ensure_equipment_access(user, equipment.site_ids)

    if data.site_ids is not None:
        sites = await _load_sites(db, data.site_ids)
        _ensure_equipment_access(user, [s.id for s in sites])
        equipment.sites = sites
        equipment.site_id = sites[0].id

    # Teams: replaced when given (each at one of the sites); a site change
    # alone drops the teams of the removed sites.
    site_ids_now = [s.id for s in equipment.sites]
    if data.team_ids is not None:
        teams = await load_teams(db, data.team_ids)
        ensure_teams_within_sites(teams, site_ids_now, team_outside_sites_detail)
        equipment.teams = teams
    elif data.site_ids is not None:
        equipment.teams = prune_teams_to_sites(equipment.teams, site_ids_now)

    # Update fields
    if data.name is not None:
        equipment.name = data.name
    if data.type is not None:
        equipment.type = data.type
    if data.description is not None:
        equipment.description = data.description
    if data.active is not None:
        equipment.active = data.active

    await db.commit()
    await db.refresh(equipment)

    return build_equipment_response(equipment)


@router.delete("/equipment/{equipment_id}")
async def delete_equipment(
    equipment_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Delete equipment from every site it is linked to.

    Requires admin or superuser authentication.
    Superusers must belong to all of those sites.
    Matches: DELETE /api/equipment/:id
    """
    result = await db.execute(select(Equipment).where(Equipment.id == equipment_id))
    equipment = result.scalar_one_or_none()

    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")

    _ensure_equipment_access(user, equipment.site_ids)

    await db.delete(equipment)
    await db.commit()

    return {"success": True}


# ---------------------------------------------------------
# Equipment Assignments
# ---------------------------------------------------------


@router.get(
    "/equipment/{equipment_id}/assignments", response_model=list[EquipmentAssignmentResponse]
)
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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Update an equipment assignment.

    Project editors only: admin, superuser, or the project's manager.
    Matches: PUT /api/equipment-assignments/:id

    This is the live handler for the path (the router is registered before
    `routers/assignments.py`, whose shadowed duplicate was removed).
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

    await require_project_editor(db, user, assignment.project_id)

    # Rebooking onto other equipment: same site rule as creating a booking
    # (POST /projects/{id}/equipment) -- the equipment must be linked to the
    # project's site through equipment_sites.
    if data.equipment_id is not None and data.equipment_id != assignment.equipment_id:
        equipment = (
            await db.execute(select(Equipment).where(Equipment.id == data.equipment_id))
        ).scalar_one_or_none()
        if equipment is None:
            raise HTTPException(status_code=404, detail="Equipment not found")
        project_site_id = assignment.project.site_id if assignment.project else None
        if project_site_id not in equipment.site_ids:
            raise HTTPException(
                status_code=400, detail="Equipment is not available at this project's site"
            )

    # Update fields
    if data.equipment_id is not None:
        assignment.equipment_id = data.equipment_id
    if data.start_date is not None:
        assignment.start_date = data.start_date
    if data.end_date is not None:
        assignment.end_date = data.end_date
    if data.start_date is not None or data.end_date is not None:
        ensure_date_order(assignment.start_date, assignment.end_date)

    await db.commit()
    await db.refresh(assignment)

    # Reload project relationship
    result = await db.execute(
        select(EquipmentAssignment)
        .where(EquipmentAssignment.id == assignment_id)
        .options(selectinload(EquipmentAssignment.project))
    )
    assignment = result.scalar_one()

    await broadcast_change(
        request=request,
        user=user,
        entity_type="equipment_assignment",
        entity_id=assignment_id,
        project_id=assignment.project_id,
        action="update",
    )

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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Delete an equipment assignment.

    Project editors only: admin, superuser, or the project's manager.
    Matches: DELETE /api/equipment-assignments/:id
    """
    result = await db.execute(
        select(EquipmentAssignment).where(EquipmentAssignment.id == assignment_id)
    )
    assignment = result.scalar_one_or_none()

    if not assignment:
        raise HTTPException(status_code=404, detail="Equipment assignment not found")

    project_id = assignment.project_id
    await require_project_editor(db, user, project_id)

    await db.delete(assignment)
    await db.commit()

    await broadcast_change(
        request=request,
        user=user,
        entity_type="equipment_assignment",
        entity_id=assignment_id,
        project_id=project_id,
        action="delete",
    )

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
    from datetime import timedelta

    # Parse dates (400 on malformed, inverted or oversized ranges)
    start, end = parse_day_range(startDate, endDate)

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

        availability.append(
            {
                "date": date_str,
                "occupied": occupied,
                "available": not occupied,
            }
        )

        current += timedelta(days=1)

    return availability


# ---------------------------------------------------------
# Equipment Blocks (maintenance / defect periods)
# ---------------------------------------------------------


def build_block_response(block: EquipmentBlock) -> dict:
    return {
        "id": block.id,
        "equipment_id": block.equipment_id,
        "equipment_name": block.equipment.name if block.equipment else "",
        "start_date": block.start_date,
        "end_date": block.end_date,
        "reason": block.reason,
        "description": block.description,
        "created_at": block.created_at,
    }


@router.get("/equipment-blocks", response_model=list[EquipmentBlockResponse])
async def list_equipment_blocks(
    siteId: int | None = Query(None),
    equipmentId: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    List equipment blocks. Optionally filter by site or equipment.
    """
    query = select(EquipmentBlock).options(selectinload(EquipmentBlock.equipment))

    if equipmentId is not None:
        query = query.where(EquipmentBlock.equipment_id == equipmentId)

    if siteId is not None:
        # Through the junction: equipment shared with the site is included too.
        query = query.join(
            EquipmentSite, EquipmentSite.equipment_id == EquipmentBlock.equipment_id
        ).where(EquipmentSite.site_id == siteId)

    query = query.order_by(EquipmentBlock.start_date)
    result = await db.execute(query)
    blocks = result.scalars().all()

    return [build_block_response(b) for b in blocks]


@router.get("/equipment/{equipment_id}/blocks", response_model=list[EquipmentBlockResponse])
async def get_equipment_blocks(
    equipment_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List all blocks for a specific equipment."""
    result = await db.execute(
        select(EquipmentBlock)
        .where(EquipmentBlock.equipment_id == equipment_id)
        .options(selectinload(EquipmentBlock.equipment))
        .order_by(EquipmentBlock.start_date)
    )
    blocks = result.scalars().all()
    return [build_block_response(b) for b in blocks]


@router.post("/equipment-blocks", response_model=EquipmentBlockResponse, status_code=201)
async def create_equipment_block(
    data: EquipmentBlockCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Create an equipment block (maintenance / defect / calibration period).
    Requires superuser or admin.
    """
    if data.end_date < data.start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")

    equipment = await db.get(Equipment, data.equipment_id)
    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")

    _ensure_equipment_access(user, equipment.site_ids)

    block = EquipmentBlock(
        equipment_id=data.equipment_id,
        start_date=data.start_date,
        end_date=data.end_date,
        reason=data.reason or "maintenance",
        description=data.description or "Maintenance",
    )
    db.add(block)
    await db.commit()
    await db.refresh(block)
    block.equipment = equipment

    return build_block_response(block)


@router.put("/equipment-blocks/{block_id}", response_model=EquipmentBlockResponse)
async def update_equipment_block(
    block_id: int,
    data: EquipmentBlockUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """Update an equipment block. Requires superuser or admin."""
    result = await db.execute(
        select(EquipmentBlock)
        .where(EquipmentBlock.id == block_id)
        .options(selectinload(EquipmentBlock.equipment))
    )
    block = result.scalar_one_or_none()
    if not block:
        raise HTTPException(status_code=404, detail="Equipment block not found")

    _ensure_equipment_access(user, block.equipment.site_ids if block.equipment else [])

    if data.start_date is not None:
        block.start_date = data.start_date
    if data.end_date is not None:
        block.end_date = data.end_date
    if data.reason is not None:
        block.reason = data.reason
    if data.description is not None:
        block.description = data.description

    if block.end_date < block.start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")

    await db.commit()
    await db.refresh(block)

    return build_block_response(block)


@router.delete("/equipment-blocks/{block_id}")
async def delete_equipment_block(
    block_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """Delete an equipment block. Requires superuser or admin."""
    result = await db.execute(
        select(EquipmentBlock)
        .where(EquipmentBlock.id == block_id)
        .options(selectinload(EquipmentBlock.equipment))
    )
    block = result.scalar_one_or_none()
    if not block:
        raise HTTPException(status_code=404, detail="Equipment block not found")

    _ensure_equipment_access(user, block.equipment.site_ids if block.equipment else [])

    await db.delete(block)
    await db.commit()

    return {"success": True}
