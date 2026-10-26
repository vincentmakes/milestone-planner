"""
Equipment API router.
Handles equipment and equipment assignment operations.

Matches the Node.js API at /api/equipment exactly.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload, selectinload

from app.database import get_db
from app.middleware.auth import get_current_user, require_permission
from app.models.equipment import Equipment, EquipmentAssignment, EquipmentBlock, EquipmentSite
from app.models.project import Project
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
from app.services import change_notifications
from app.services.date_range import ensure_date_order, parse_day_range
from app.services.project_access import require_on_project
from app.services.site_access import (
    EQUIPMENT_NOT_FOUND_DETAIL,
    EXTERNAL_PROJECT_NAME,
    can_access_sites,
    ensure_equipment_visible,
    ensure_project_visible,
    ensure_site_access,
    ensure_site_visible,
    site_is_visible,
    visible_site_ids,
    visible_sites_clause,
)
from app.services.team_rules import (
    ensure_teams_within_sites,
    load_teams,
    prune_teams_to_sites,
    team_outside_sites_detail,
)
from app.websocket.broadcast import broadcast_change

router = APIRouter()

# A booking's project is read for its name and site only: skip its project-field
# values and selections (selectin by default, two more queries per load).
_BOOKING_PROJECT = selectinload(EquipmentAssignment.project).options(
    noload(Project.field_values), noload(Project.field_selections)
)

EQUIPMENT_SITE_ACCESS_DETAIL = "You can only manage equipment for sites you're assigned to"

# The Equipment view's reads (equipment, bookings, availability, blocks).
require_equipment_view = require_permission("views.equipment")


# ---------------------------------------------------------
# Equipment Types (derived from equipment.type field)
# ---------------------------------------------------------


EQUIPMENT_TYPE_ACCESS_DETAIL = (
    "This equipment type is also used at sites you're not assigned to; ask an administrator"
)


async def _ensure_type_access(
    request: Request, db: AsyncSession, user: User, equipment_list
) -> None:
    """
    403 unless the user may manage every piece of equipment of a type.

    Same rule as _ensure_equipment_access per item: every site of every item
    visible to the user (``sites.view_all``: any site; site-less equipment
    only with ``sites.view_all``).
    """
    if user.permissions.has("sites.view_all"):
        return
    for equipment in equipment_list:
        if not equipment.site_ids or not await can_access_sites(
            request, db, user, equipment.site_ids
        ):
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
    request: Request,
    new_type: str = Query(..., description="New type name"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("equipment_types.manage")),
):
    """
    Rename an equipment type.

    Updates all equipment with the old type to use the new type. Types are
    tenant-wide, so ``equipment_types.manage`` renames only a type whose every
    piece of equipment is at a visible site (otherwise it would silently
    rename other sites' equipment); ``sites.view_all`` renames any.
    """
    from sqlalchemy import update

    if not new_type.strip():
        raise HTTPException(status_code=400, detail="New type name cannot be empty")

    # Check if old type exists
    result = await db.execute(select(Equipment).where(Equipment.type == old_type))
    equipment_list = result.scalars().all()

    if not equipment_list:
        raise HTTPException(status_code=404, detail=f"No equipment found with type '{old_type}'")

    await _ensure_type_access(request, db, user, equipment_list)

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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("equipment_types.manage")),
):
    """
    Delete an equipment type.

    Only succeeds if no equipment uses this type (409 otherwise). Asking about
    a type used outside the visible sites gets 403, like a rename.
    """
    # Check if any equipment uses this type
    result = await db.execute(select(Equipment).where(Equipment.type == type_name))
    equipment_list = result.scalars().all()

    if equipment_list:
        await _ensure_type_access(request, db, user, equipment_list)
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


async def _ensure_equipment_access(
    request: Request, db: AsyncSession, user: User, site_ids: list[int]
) -> None:
    """
    403 unless every given site is visible to the user.

    Equipment without any site (legacy orphan) needs ``sites.view_all``.
    """
    if not site_ids and not user.permissions.has("sites.view_all"):
        raise HTTPException(status_code=403, detail=EQUIPMENT_SITE_ACCESS_DETAIL)
    await ensure_site_access(request, db, user, site_ids, EQUIPMENT_SITE_ACCESS_DETAIL)


def _booking_project_name(project, visible: frozenset[int] | None) -> str | None:
    """The booking's project name, masked for a project outside the visible sites."""
    if project is None:
        return None
    if not site_is_visible(visible, project.site_id):
        return EXTERNAL_PROJECT_NAME
    name: str | None = project.name
    return name


def _at_visible_sites(equipment_id_column, visible: frozenset[int] | None):
    """``equipment_id IN (equipment linked to a visible site)``, or None for every site."""
    in_visible = visible_sites_clause(EquipmentSite.site_id, visible)
    if in_visible is None:
        return None
    return equipment_id_column.in_(select(EquipmentSite.equipment_id).where(in_visible))


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
    request: Request,
    siteId: int | None = Query(None),
    includeAllSites: bool | None = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_equipment_view),
):
    """
    Get active equipment (``views.equipment``).

    If siteId provided, returns equipment linked to that site (403 outside the
    user's visible sites). Otherwise (or with includeAllSites=true) returns the
    equipment of every visible site.

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
        await ensure_site_visible(request, db, user, siteId)
        query = query.where(EquipmentSite.site_id == siteId)
    else:
        in_visible = visible_sites_clause(
            EquipmentSite.site_id, await visible_site_ids(request, db, user)
        )
        if in_visible is not None:
            query = query.where(in_visible)

    result = await db.execute(query)
    rows = result.all()

    return [build_equipment_response(equipment, site) for equipment, site in rows]


@router.get("/equipment/all", response_model=list[EquipmentResponse])
async def get_all_equipment(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("equipment.manage")),
):
    """
    Get all equipment including inactive, one row per equipment, linked to a
    visible site (every one, site-less included, with ``sites.view_all``).

    Requires ``equipment.manage``.
    Matches: GET /api/equipment/all
    """
    query = select(Equipment)
    at_visible = _at_visible_sites(Equipment.id, await visible_site_ids(request, db, user))
    if at_visible is not None:
        query = query.where(at_visible)
    result = await db.execute(query.order_by(Equipment.name))
    equipment_list = result.scalars().all()

    return [build_equipment_response(e) for e in equipment_list]


@router.get("/equipment/{equipment_id}", response_model=EquipmentResponse)
async def get_equipment_by_id(
    equipment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_equipment_view),
):
    """
    Get a specific equipment by ID (``views.equipment``; 404 unless linked to
    a visible site).

    Matches: GET /api/equipment/:id
    """
    await ensure_equipment_visible(request, db, user, equipment_id)
    result = await db.execute(select(Equipment).where(Equipment.id == equipment_id))
    equipment = result.scalar_one_or_none()

    if not equipment:
        raise HTTPException(status_code=404, detail=EQUIPMENT_NOT_FOUND_DETAIL)

    return build_equipment_response(equipment)


@router.post("/equipment", response_model=EquipmentResponse, status_code=201)
async def create_equipment(
    data: EquipmentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("equipment.manage")),
):
    """
    Create new equipment on one or more sites.

    Requires ``equipment.manage``, at visible sites only.
    Matches: POST /api/equipment
    """
    sites = await _load_sites(db, data.resolved_site_ids)
    await _ensure_equipment_access(request, db, user, [s.id for s in sites])
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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("equipment.manage")),
):
    """
    Update equipment. ``site_ids``, when given, replaces its site links;
    ``team_ids``, when given, replaces its teams.

    Requires ``equipment.manage``; every site the equipment is linked to must
    be visible, before and after the change.
    Matches: PUT /api/equipment/:id
    """
    result = await db.execute(select(Equipment).where(Equipment.id == equipment_id))
    equipment = result.scalar_one_or_none()

    if not equipment:
        raise HTTPException(status_code=404, detail=EQUIPMENT_NOT_FOUND_DETAIL)

    await _ensure_equipment_access(request, db, user, equipment.site_ids)

    if data.site_ids is not None:
        sites = await _load_sites(db, data.site_ids)
        await _ensure_equipment_access(request, db, user, [s.id for s in sites])
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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("equipment.manage")),
):
    """
    Delete equipment from every site it is linked to.

    Requires ``equipment.manage``; all of those sites must be visible.
    Matches: DELETE /api/equipment/:id
    """
    result = await db.execute(select(Equipment).where(Equipment.id == equipment_id))
    equipment = result.scalar_one_or_none()

    if not equipment:
        raise HTTPException(status_code=404, detail=EQUIPMENT_NOT_FOUND_DETAIL)

    await _ensure_equipment_access(request, db, user, equipment.site_ids)

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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_equipment_view),
):
    """
    Get assignments for a specific equipment (``views.equipment``; 404 unless
    linked to a visible site). Bookings of shared equipment by projects at
    other sites stay listed (their dates block the equipment) but their
    project name is masked like the cross-site project list.

    Matches: GET /api/equipment/:id/assignments
    """
    await ensure_equipment_visible(request, db, user, equipment_id)
    visible = await visible_site_ids(request, db, user)
    result = await db.execute(
        select(EquipmentAssignment)
        .where(EquipmentAssignment.equipment_id == equipment_id)
        .options(
            selectinload(EquipmentAssignment.equipment),
            _BOOKING_PROJECT,
        )
        .order_by(EquipmentAssignment.start_date)
    )
    assignments = result.scalars().all()

    return [
        EquipmentAssignmentResponse(
            id=a.id,
            project_id=a.project_id,
            project_name=_booking_project_name(a.project, visible),
            project_site_id=a.project.site_id if a.project else None,
            equipment_id=a.equipment_id,
            start_date=a.start_date,
            end_date=a.end_date,
            note=a.note,
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

    ``equipment_bookings.manage``, or the project's manager (PM bundle).
    Matches: PUT /api/equipment-assignments/:id

    This is the live handler for the path (the router is registered before
    `routers/assignments.py`, whose shadowed duplicate was removed).
    """
    result = await db.execute(
        select(EquipmentAssignment)
        .where(EquipmentAssignment.id == assignment_id)
        .options(
            selectinload(EquipmentAssignment.equipment),
            _BOOKING_PROJECT,
        )
    )
    assignment = result.scalar_one_or_none()

    if not assignment:
        raise HTTPException(status_code=404, detail="Equipment assignment not found")

    await ensure_project_visible(request, db, user, assignment.project_id)
    await require_on_project(db, user, "equipment_bookings.manage", assignment.project_id)
    old_name = assignment.equipment.name if assignment.equipment else "equipment"
    old_dates = (assignment.start_date, assignment.end_date)
    new_name: str | None = None

    # Rebooking onto other equipment: same site rule as creating a booking
    # (POST /projects/{id}/equipment) -- the equipment must be linked to the
    # project's site through equipment_sites.
    if data.equipment_id is not None and data.equipment_id != assignment.equipment_id:
        equipment = (
            await db.execute(select(Equipment).where(Equipment.id == data.equipment_id))
        ).scalar_one_or_none()
        if equipment is None:
            raise HTTPException(status_code=404, detail=EQUIPMENT_NOT_FOUND_DETAIL)
        project_site_id = assignment.project.site_id if assignment.project else None
        if project_site_id not in equipment.site_ids:
            raise HTTPException(
                status_code=400, detail="Equipment is not available at this project's site"
            )
        new_name = equipment.name

    # Update fields
    if data.equipment_id is not None:
        assignment.equipment_id = data.equipment_id
    if data.start_date is not None:
        assignment.start_date = data.start_date
    if data.end_date is not None:
        assignment.end_date = data.end_date
    if data.start_date is not None or data.end_date is not None:
        ensure_date_order(assignment.start_date, assignment.end_date)
    # Left out keeps the note, null or blank clears it. A note-only edit
    # tells nobody: only equipment and date changes notify the PM.
    if "note" in data.model_fields_set:
        assignment.note = data.note
    body = change_notifications.equipment_change_body(
        old_name=old_name,
        new_name=new_name,
        old_dates=old_dates,
        new_dates=(assignment.start_date, assignment.end_date),
    )
    intents = (
        change_notifications.equipment_intents(
            user,
            kind="update",
            project_id=assignment.project_id,
            equipment_name=old_name,
            body=body,
        )
        if body
        else []
    )

    await db.commit()
    await db.refresh(assignment)

    # Reload project relationship
    result = await db.execute(
        select(EquipmentAssignment)
        .where(EquipmentAssignment.id == assignment_id)
        .options(_BOOKING_PROJECT)
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
    await change_notifications.deliver(db, request, user.id, intents)

    return EquipmentAssignmentResponse(
        id=assignment.id,
        project_id=assignment.project_id,
        project_name=assignment.project.name if assignment.project else None,
        project_site_id=assignment.project.site_id if assignment.project else None,
        equipment_id=assignment.equipment_id,
        start_date=assignment.start_date,
        end_date=assignment.end_date,
        note=assignment.note,
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

    ``equipment_bookings.manage``, or the project's manager (PM bundle).
    Matches: DELETE /api/equipment-assignments/:id
    """
    result = await db.execute(
        select(EquipmentAssignment)
        .where(EquipmentAssignment.id == assignment_id)
        .options(selectinload(EquipmentAssignment.equipment))
    )
    assignment = result.scalar_one_or_none()

    if not assignment:
        raise HTTPException(status_code=404, detail="Equipment assignment not found")

    project_id = assignment.project_id
    await ensure_project_visible(request, db, user, project_id)
    await require_on_project(db, user, "equipment_bookings.manage", project_id)
    intents = change_notifications.equipment_intents(
        user,
        kind="remove",
        project_id=project_id,
        equipment_name=assignment.equipment.name if assignment.equipment else "equipment",
        body=f"Was from {assignment.start_date} to {assignment.end_date}",
    )

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
    await change_notifications.deliver(db, request, user.id, intents)

    return {"success": True}


@router.get("/equipment/{equipment_id}/availability")
async def get_equipment_availability(
    equipment_id: int,
    request: Request,
    startDate: str = Query(...),
    endDate: str = Query(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_equipment_view),
):
    """
    Get equipment availability for a date range (``views.equipment``; 404
    unless linked to a visible site).

    Matches: GET /api/equipment/:id/availability
    """
    from datetime import timedelta

    # Parse dates (400 on malformed, inverted or oversized ranges)
    start, end = parse_day_range(startDate, endDate)
    await ensure_equipment_visible(request, db, user, equipment_id)

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
    request: Request,
    siteId: int | None = Query(None),
    equipmentId: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_equipment_view),
):
    """
    List equipment blocks (``views.equipment``) of equipment at the user's
    visible sites. Optionally filter by site (403 outside the visible sites)
    or equipment.
    """
    query = select(EquipmentBlock).options(selectinload(EquipmentBlock.equipment))

    if equipmentId is not None:
        query = query.where(EquipmentBlock.equipment_id == equipmentId)

    if siteId is not None:
        await ensure_site_visible(request, db, user, siteId)
        # Through the junction: equipment shared with the site is included too.
        query = query.join(
            EquipmentSite, EquipmentSite.equipment_id == EquipmentBlock.equipment_id
        ).where(EquipmentSite.site_id == siteId)
    else:
        at_visible = _at_visible_sites(
            EquipmentBlock.equipment_id, await visible_site_ids(request, db, user)
        )
        if at_visible is not None:
            query = query.where(at_visible)

    query = query.order_by(EquipmentBlock.start_date)
    result = await db.execute(query)
    blocks = result.scalars().all()

    return [build_block_response(b) for b in blocks]


@router.get("/equipment/{equipment_id}/blocks", response_model=list[EquipmentBlockResponse])
async def get_equipment_blocks(
    equipment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_equipment_view),
):
    """List all blocks for a specific equipment (``views.equipment``; 404 unless
    linked to a visible site)."""
    await ensure_equipment_visible(request, db, user, equipment_id)
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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("equipment_blocks.manage")),
):
    """
    Create an equipment block (maintenance / defect / calibration period).
    Requires ``equipment_blocks.manage`` at the equipment's sites.
    """
    if data.end_date < data.start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")

    equipment = await db.get(Equipment, data.equipment_id)
    if not equipment:
        raise HTTPException(status_code=404, detail=EQUIPMENT_NOT_FOUND_DETAIL)

    await _ensure_equipment_access(request, db, user, equipment.site_ids)

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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("equipment_blocks.manage")),
):
    """Update an equipment block (``equipment_blocks.manage``)."""
    result = await db.execute(
        select(EquipmentBlock)
        .where(EquipmentBlock.id == block_id)
        .options(selectinload(EquipmentBlock.equipment))
    )
    block = result.scalar_one_or_none()
    if not block:
        raise HTTPException(status_code=404, detail="Equipment block not found")

    await _ensure_equipment_access(
        request, db, user, block.equipment.site_ids if block.equipment else []
    )

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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("equipment_blocks.manage")),
):
    """Delete an equipment block (``equipment_blocks.manage``)."""
    result = await db.execute(
        select(EquipmentBlock)
        .where(EquipmentBlock.id == block_id)
        .options(selectinload(EquipmentBlock.equipment))
    )
    block = result.scalar_one_or_none()
    if not block:
        raise HTTPException(status_code=404, detail="Equipment block not found")

    await _ensure_equipment_access(
        request, db, user, block.equipment.site_ids if block.equipment else []
    )

    await db.delete(block)
    await db.commit()

    return {"success": True}
