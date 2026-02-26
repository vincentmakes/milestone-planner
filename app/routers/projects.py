"""
Project, Phase, and Subphase API routes.
Handles all project management operations including CRUD for projects,
phases, subphases, and their staff assignments.
"""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, get_db_readonly
from app.middleware.auth import get_current_user, require_superuser
from app.models.assignment import (
    PhaseStaffAssignment,
    ProjectAssignment,
    SubphaseStaffAssignment,
)
from app.models.equipment import Equipment, EquipmentAssignment
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.site import Site
from app.models.user import User
from app.schemas.base import PaginationParams
from app.schemas.project import (
    PhaseCreate,
    PhaseReorderRequest,
    PhaseUpdate,
    ProjectCreate,
    ProjectDetailResponse,
    ProjectUpdate,
    SubphaseCreate,
    SubphaseReorderRequest,
    SubphaseUpdate,
)
from app.websocket.broadcast import broadcast_change

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------


def build_subphase_tree_optimized(
    subphases: list[ProjectSubphase],
    subphase_staff: list,  # List of staff assignment objects with subphase_id
    parent_id: int,
    parent_type: str,
    # Pre-built indexes (built once, passed through recursion)
    children_index: dict | None = None,
    staff_index: dict | None = None,
) -> list[dict]:
    """
    Build recursive subphase tree structure.

    Optimized version using pre-built indexes for O(n) performance.
    """
    # Build indexes on first call
    if children_index is None:
        # Index subphases by (parent_id, parent_type) for O(1) child lookup
        children_index = {}
        for sp in subphases:
            key = (sp.parent_id, sp.parent_type)
            if key not in children_index:
                children_index[key] = []
            children_index[key].append(sp)

        # Index staff assignments by subphase_id for O(1) lookup
        staff_index = {}
        for ssa in subphase_staff:
            sid = ssa.subphase_id
            if sid not in staff_index:
                staff_index[sid] = []
            staff_index[sid].append(ssa)

    # Get children for this parent - O(1) lookup
    key = (parent_id, parent_type)
    direct_children = children_index.get(key, [])

    children = []
    for sp in direct_children:
        # Get staff assignments for this subphase - O(1) lookup
        staff_list = staff_index.get(sp.id, []) if staff_index else []
        staff = [
            {
                "id": ssa.id,
                "subphase_id": ssa.subphase_id,
                "project_id": ssa.project_id,
                "staff_id": ssa.staff_id,
                "allocation": ssa.allocation,
                "staff_name": ssa.staff_name if hasattr(ssa, "staff_name") else None,
                "staff_role": ssa.staff_role if hasattr(ssa, "staff_role") else None,
            }
            for ssa in staff_list
        ]

        # Parse dependencies
        deps = []
        if sp.dependencies:
            try:
                deps = json.loads(sp.dependencies)
            except json.JSONDecodeError:
                deps = []

        children.append(
            {
                "id": sp.id,
                "parent_id": sp.parent_id,
                "parent_type": sp.parent_type,
                "project_id": sp.project_id,
                "name": sp.name,
                "start_date": sp.start_date,
                "end_date": sp.end_date,
                "is_milestone": sp.is_milestone == 1,
                "sort_order": sp.sort_order,
                "depth": sp.depth,
                "completion": sp.completion,
                "dependencies": deps,
                "created_at": sp.created_at,
                "staffAssignments": staff,
                "children": build_subphase_tree_optimized(
                    subphases, subphase_staff, sp.id, "subphase", children_index, staff_index
                ),
            }
        )
    return children


# Keep old function name as alias for compatibility
def build_subphase_tree(
    subphases: list[ProjectSubphase], subphase_staff: list, parent_id: int, parent_type: str
) -> list[dict]:
    """Build recursive subphase tree structure (optimized)."""
    return build_subphase_tree_optimized(subphases, subphase_staff, parent_id, parent_type)


# ---------------------------------------------------------
# Project Routes
# ---------------------------------------------------------


@router.get("/projects")
async def get_projects(
    siteId: int | None = Query(None),
    includeOtherSites: str | None = Query(None),
    archived: str | None = Query(None),
    pagination: PaginationParams = Depends(),
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(get_current_user),
):
    """
    Get list of projects with pagination.

    Query params:
    - siteId: Filter by site
    - includeOtherSites: If 'true', show all sites but mask external project details
    - archived: 'true' for archived only, 'all' for all, default is non-archived
    - offset: Number of items to skip (default 0)
    - limit: Max items to return (default 50, max 200)

    Matches: GET /api/projects
    """
    # Build base filter query
    base_filter = select(Project.id)

    # Filter by archived status
    if archived == "true":
        base_filter = base_filter.where(Project.archived == 1)
    elif archived != "all":
        base_filter = base_filter.where(or_(Project.archived == 0, Project.archived.is_(None)))

    # Filter by site
    if siteId and includeOtherSites != "true":
        base_filter = base_filter.where(Project.site_id == int(siteId))

    # Get total count
    count_result = await db.execute(select(func.count()).select_from(base_filter.subquery()))
    total = count_result.scalar() or 0

    # Build paginated query with joins
    query = (
        select(
            Project,
            Site.name.label("site_name"),
            (User.first_name + " " + User.last_name).label("pm_name"),
        )
        .outerjoin(Site, Project.site_id == Site.id)
        .outerjoin(User, Project.pm_id == User.id)
    )

    if archived == "true":
        query = query.where(Project.archived == 1)
    elif archived != "all":
        query = query.where(or_(Project.archived == 0, Project.archived.is_(None)))

    if siteId and includeOtherSites != "true":
        query = query.where(Project.site_id == int(siteId))

    query = query.order_by(Project.start_date).offset(pagination.offset).limit(pagination.limit)

    result = await db.execute(query)
    rows = result.all()

    projects = []
    for row in rows:
        project = row[0]
        site_name = row[1]
        pm_name = row[2]

        # Mask external project details if viewing cross-site
        if includeOtherSites == "true" and siteId and project.site_id != int(siteId):
            projects.append(
                {
                    "id": project.id,
                    "name": "[External Project]",
                    "site_id": project.site_id,
                    "site_name": site_name,
                    "customer": "[Hidden]",
                    "pm_id": project.pm_id,
                    "pm_name": pm_name,
                    "sales_pm": "[Hidden]",
                    "confirmed": project.confirmed,
                    "volume": None,
                    "start_date": project.start_date,
                    "end_date": project.end_date,
                    "notes": None,
                    "archived": project.archived,
                    "created_at": project.created_at,
                    "updated_at": project.updated_at,
                }
            )
        else:
            projects.append(
                {
                    "id": project.id,
                    "name": project.name,
                    "site_id": project.site_id,
                    "site_name": site_name,
                    "customer": project.customer,
                    "pm_id": project.pm_id,
                    "pm_name": pm_name,
                    "sales_pm": project.sales_pm,
                    "confirmed": project.confirmed,
                    "volume": project.volume,
                    "start_date": project.start_date,
                    "end_date": project.end_date,
                    "notes": project.notes,
                    "archived": project.archived,
                    "created_at": project.created_at,
                    "updated_at": project.updated_at,
                }
            )

    return {
        "items": projects,
        "total": total,
        "offset": pagination.offset,
        "limit": pagination.limit,
    }


@router.get("/projects/{project_id}", response_model=ProjectDetailResponse)
async def get_project(
    project_id: int,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(get_current_user),
):
    """
    Get single project with all nested data (phases, subphases, assignments).

    Matches: GET /api/projects/:id
    """
    import time

    t0 = time.perf_counter()

    # Run all queries concurrently using asyncio.gather
    # This should be faster than running them sequentially

    async def query_project():
        return await db.execute(
            select(
                Project,
                Site.name.label("site_name"),
                (User.first_name + " " + User.last_name).label("pm_name"),
            )
            .outerjoin(Site, Project.site_id == Site.id)
            .outerjoin(User, Project.pm_id == User.id)
            .where(Project.id == project_id)
        )

    async def query_phases():
        return await db.execute(
            select(ProjectPhase)
            .where(ProjectPhase.project_id == project_id)
            .order_by(ProjectPhase.sort_order, ProjectPhase.start_date)
        )

    async def query_subphases():
        return await db.execute(
            select(ProjectSubphase)
            .where(ProjectSubphase.project_id == project_id)
            .order_by(ProjectSubphase.depth, ProjectSubphase.sort_order, ProjectSubphase.start_date)
        )

    async def query_phase_staff():
        return await db.execute(
            select(
                PhaseStaffAssignment,
                (User.first_name + " " + User.last_name).label("staff_name"),
                User.job_title.label("staff_role"),
            )
            .join(User, PhaseStaffAssignment.staff_id == User.id)
            .where(PhaseStaffAssignment.project_id == project_id)
        )

    async def query_subphase_staff():
        return await db.execute(
            select(
                SubphaseStaffAssignment,
                (User.first_name + " " + User.last_name).label("staff_name"),
                User.job_title.label("staff_role"),
            )
            .join(User, SubphaseStaffAssignment.staff_id == User.id)
            .where(SubphaseStaffAssignment.project_id == project_id)
        )

    async def query_project_staff():
        return await db.execute(
            select(
                ProjectAssignment,
                (User.first_name + " " + User.last_name).label("staff_name"),
                User.job_title.label("staff_role"),
            )
            .join(User, ProjectAssignment.staff_id == User.id)
            .where(ProjectAssignment.project_id == project_id)
            .order_by(ProjectAssignment.start_date)
        )

    async def query_equipment():
        return await db.execute(
            select(
                EquipmentAssignment,
                Equipment.name.label("equipment_name"),
                Equipment.type.label("equipment_type"),
            )
            .join(Equipment, EquipmentAssignment.equipment_id == Equipment.id)
            .where(EquipmentAssignment.project_id == project_id)
            .order_by(EquipmentAssignment.start_date)
        )

    # Execute all queries - note: SQLAlchemy async sessions are NOT thread-safe
    # and queries on the same session must run sequentially
    # So we run them one by one but track timing
    result = await query_project()
    t1 = time.perf_counter()

    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")

    project = row[0]
    site_name = row[1]
    pm_name = row[2]

    phases_result = await query_phases()
    t2 = time.perf_counter()
    phases_raw = phases_result.scalars().all()

    subphases_result = await query_subphases()
    t3 = time.perf_counter()
    subphases_raw = subphases_result.scalars().all()

    phase_staff_result = await query_phase_staff()
    t4 = time.perf_counter()
    phase_staff_rows = phase_staff_result.all()

    subphase_staff_result = await query_subphase_staff()
    t5 = time.perf_counter()
    subphase_staff_rows = subphase_staff_result.all()

    project_staff_result = await query_project_staff()
    t6 = time.perf_counter()
    project_staff_rows = project_staff_result.all()

    equipment_result = await query_equipment()
    t7 = time.perf_counter()
    equipment_rows = equipment_result.all()

    # Log all query times
    logger.debug(
        "PROJECT %s: q1=%dms q2=%dms q3=%dms q4=%dms q5=%dms q6=%dms q7=%dms TOTAL=%dms",
        project_id, int((t1 - t0) * 1000), int((t2 - t1) * 1000), int((t3 - t2) * 1000),
        int((t4 - t3) * 1000), int((t5 - t4) * 1000), int((t6 - t5) * 1000),
        int((t7 - t6) * 1000), int((t7 - t0) * 1000),
    )

    # Convert to list with attributes
    class StaffAssignmentWithName:
        def __init__(self, assignment, staff_name, staff_role):
            self.id = assignment.id
            self.phase_id = getattr(assignment, "phase_id", None)
            self.subphase_id = getattr(assignment, "subphase_id", None)
            self.project_id = assignment.project_id
            self.staff_id = assignment.staff_id
            self.allocation = assignment.allocation
            self.staff_name = staff_name
            self.staff_role = staff_role

    phase_staff = [StaffAssignmentWithName(r[0], r[1], r[2]) for r in phase_staff_rows]
    subphase_staff = [StaffAssignmentWithName(r[0], r[1], r[2]) for r in subphase_staff_rows]

    # Build phases with nested data
    phases = []
    for p in phases_raw:
        # Get staff assignments for this phase
        staff = [
            {
                "id": psa.id,
                "phase_id": psa.phase_id,
                "project_id": psa.project_id,
                "staff_id": psa.staff_id,
                "allocation": psa.allocation,
                "staff_name": psa.staff_name,
                "staff_role": psa.staff_role,
            }
            for psa in phase_staff
            if psa.phase_id == p.id
        ]

        # Parse dependencies
        deps = []
        if p.dependencies:
            try:
                deps = json.loads(p.dependencies)
            except json.JSONDecodeError:
                deps = []

        phases.append(
            {
                "id": p.id,
                "project_id": p.project_id,
                "type": p.type,
                "start_date": p.start_date,
                "end_date": p.end_date,
                "is_milestone": p.is_milestone == 1,
                "sort_order": p.sort_order,
                "completion": p.completion,
                "dependencies": deps,
                "created_at": p.created_at,
                "staffAssignments": staff,
                "children": build_subphase_tree(subphases_raw, subphase_staff, p.id, "phase"),
            }
        )

    # Build project staff assignments from already-fetched data
    staff_assignments = [
        {
            "id": r[0].id,
            "project_id": r[0].project_id,
            "staff_id": r[0].staff_id,
            "allocation": r[0].allocation,
            "start_date": r[0].start_date,
            "end_date": r[0].end_date,
            "staff_name": r[1],
            "staff_role": r[2],
        }
        for r in project_staff_rows
    ]

    # Build equipment assignments from already-fetched data
    equipment_assignments = [
        {
            "created_at": r[0].created_at,
            "end_date": r[0].end_date,
            "equipment_id": r[0].equipment_id,
            "equipment_name": r[1],
            "equipment_type": r[2],
            "id": r[0].id,
            "project_id": r[0].project_id,
            "start_date": r[0].start_date,
        }
        for r in equipment_rows
    ]
    t8 = time.perf_counter()

    logger.debug(
        "PROJECT %s TIMING: q6=%dms q7=%dms proc=%dms TOTAL=%dms",
        project_id, int((t6 - t5) * 1000), int((t7 - t6) * 1000),
        int((t8 - t7) * 1000), int((t8 - t0) * 1000),
    )

    return {
        "id": project.id,
        "name": project.name,
        "site_id": project.site_id,
        "site_name": site_name,
        "customer": project.customer,
        "pm_id": project.pm_id,
        "pm_name": pm_name,
        "sales_pm": project.sales_pm,
        "confirmed": project.confirmed,
        "volume": project.volume,
        "start_date": project.start_date,
        "end_date": project.end_date,
        "notes": project.notes,
        "archived": project.archived,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
        "phases": phases,
        "staffAssignments": staff_assignments,
        "equipmentAssignments": equipment_assignments,
    }


@router.post("/projects")
async def create_project(
    data: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Create a new project.

    Matches: POST /api/projects
    """
    project = Project(
        name=data.name,
        site_id=data.site_id,
        customer=data.customer,
        pm_id=data.pm_id,
        sales_pm=data.sales_pm,
        confirmed=1 if data.confirmed else 0,
        volume=data.volume,
        start_date=data.start_date,
        end_date=data.end_date,
        notes=data.notes,
    )

    db.add(project)
    await db.flush()  # Get the project ID

    # Create phases if provided
    if data.phases:
        for index, phase_data in enumerate(data.phases):
            phase = ProjectPhase(
                project_id=project.id,
                type=phase_data.type,
                start_date=phase_data.start_date,
                end_date=phase_data.end_date,
                is_milestone=1 if phase_data.is_milestone else 0,
                sort_order=index,
            )
            db.add(phase)

    await db.commit()

    return {"id": project.id, "success": True}


@router.put("/projects/{project_id}")
async def update_project(
    project_id: int,
    data: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Update a project.

    Matches: PUT /api/projects/:id
    """
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Update fields if provided
    if data.name is not None:
        project.name = data.name
    if data.customer is not None:
        project.customer = data.customer
    if data.pm_id is not None:
        project.pm_id = data.pm_id
    if data.sales_pm is not None:
        project.sales_pm = data.sales_pm
    if data.confirmed is not None:
        project.confirmed = 1 if data.confirmed else 0
    if data.volume is not None:
        project.volume = data.volume
    if data.start_date is not None:
        project.start_date = data.start_date
    if data.end_date is not None:
        project.end_date = data.end_date
    if data.notes is not None:
        project.notes = data.notes
    if data.archived is not None:
        project.archived = 1 if data.archived else 0

    await db.commit()

    return {"success": True}


@router.delete("/projects/{project_id}")
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Delete a project and all related data.

    Matches: DELETE /api/projects/:id
    """
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Delete related data (cascade should handle most, but be explicit)
    await db.execute(ProjectPhase.__table__.delete().where(ProjectPhase.project_id == project_id))
    await db.execute(
        ProjectSubphase.__table__.delete().where(ProjectSubphase.project_id == project_id)
    )
    await db.execute(
        ProjectAssignment.__table__.delete().where(ProjectAssignment.project_id == project_id)
    )
    await db.execute(
        EquipmentAssignment.__table__.delete().where(EquipmentAssignment.project_id == project_id)
    )

    await db.delete(project)
    await db.commit()

    return {"success": True}


# ---------------------------------------------------------
# Phase Routes
# ---------------------------------------------------------


@router.post("/projects/{project_id}/phases")
async def create_phase(
    project_id: int,
    data: PhaseCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Add a phase to a project.

    Matches: POST /api/projects/:id/phases
    """
    # Verify project exists
    result = await db.execute(select(Project).where(Project.id == project_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")

    # Determine sort_order
    if data.order_index is not None:
        # Insert at specific position - shift existing phases
        await db.execute(
            update(ProjectPhase)
            .where(ProjectPhase.project_id == project_id)
            .where(ProjectPhase.sort_order >= data.order_index)
            .values(sort_order=ProjectPhase.sort_order + 1)
        )
        sort_order = data.order_index
    else:
        # Get max sort_order and append
        max_result = await db.execute(
            select(func.max(ProjectPhase.sort_order)).where(ProjectPhase.project_id == project_id)
        )
        max_order = max_result.scalar() or -1
        sort_order = max_order + 1

    # Create phase
    phase = ProjectPhase(
        project_id=project_id,
        type=data.type,
        start_date=data.start_date,
        end_date=data.end_date,
        is_milestone=1 if data.is_milestone else 0,
        sort_order=sort_order,
        dependencies=json.dumps(data.dependencies) if data.dependencies else None,
    )

    db.add(phase)
    await db.commit()

    return {"id": phase.id, "success": True}


@router.put("/phases/{phase_id}")
async def update_phase(
    phase_id: int,
    data: PhaseUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Update a phase.

    Matches: PUT /api/phases/:id
    """
    result = await db.execute(select(ProjectPhase).where(ProjectPhase.id == phase_id))
    phase = result.scalar_one_or_none()

    if not phase:
        raise HTTPException(status_code=404, detail="Phase not found")

    project_id = phase.project_id

    if data.type is not None:
        phase.type = data.type
    if data.start_date is not None:
        phase.start_date = data.start_date
    if data.end_date is not None:
        phase.end_date = data.end_date
    if data.is_milestone is not None:
        phase.is_milestone = 1 if data.is_milestone else 0
    if data.dependencies is not None:
        phase.dependencies = json.dumps(data.dependencies)
    if data.completion is not None:
        phase.completion = data.completion

    await db.commit()

    # Broadcast change to other users
    await broadcast_change(
        request=request,
        user=user,
        entity_type="phase",
        entity_id=phase_id,
        project_id=project_id,
        action="update",
    )

    return {"success": True}


@router.delete("/phases/{phase_id}")
async def delete_phase(
    phase_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Delete a phase.

    Matches: DELETE /api/phases/:id
    """
    result = await db.execute(select(ProjectPhase).where(ProjectPhase.id == phase_id))
    phase = result.scalar_one_or_none()

    if not phase:
        raise HTTPException(status_code=404, detail="Phase not found")

    await db.delete(phase)
    await db.commit()

    return {"success": True}


@router.put("/projects/{project_id}/phases/reorder")
async def reorder_phases(
    project_id: int,
    data: PhaseReorderRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Reorder phases within a project.

    Matches: PUT /api/projects/:id/phases/reorder
    """
    for index, phase_id in enumerate(data.phase_order):
        await db.execute(
            ProjectPhase.__table__.update()
            .where(and_(ProjectPhase.id == phase_id, ProjectPhase.project_id == project_id))
            .values(sort_order=index)
        )

    await db.commit()

    return {"success": True}


# ---------------------------------------------------------
# Subphase Routes
# ---------------------------------------------------------


@router.post("/phases/{phase_id}/subphases")
async def create_subphase_under_phase(
    phase_id: int,
    data: SubphaseCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Add a subphase to a phase.

    Matches: POST /api/phases/:phaseId/subphases
    """
    # Verify phase exists
    result = await db.execute(select(ProjectPhase).where(ProjectPhase.id == phase_id))
    phase = result.scalar_one_or_none()
    if not phase:
        raise HTTPException(status_code=404, detail="Phase not found")

    # Determine sort_order
    if data.order_index is not None:
        # Insert at specific position - shift existing subphases
        await db.execute(
            update(ProjectSubphase)
            .where(
                and_(
                    ProjectSubphase.parent_id == phase_id,
                    ProjectSubphase.parent_type == "phase",
                    ProjectSubphase.sort_order >= data.order_index,
                )
            )
            .values(sort_order=ProjectSubphase.sort_order + 1)
        )
        sort_order = data.order_index
    else:
        # Get max sort_order and append
        max_result = await db.execute(
            select(func.max(ProjectSubphase.sort_order)).where(
                and_(ProjectSubphase.parent_id == phase_id, ProjectSubphase.parent_type == "phase")
            )
        )
        max_order = max_result.scalar() or 0
        sort_order = max_order + 1

    subphase = ProjectSubphase(
        parent_id=phase_id,
        parent_type="phase",
        project_id=data.project_id,
        name=data.name,
        start_date=data.start_date,
        end_date=data.end_date,
        is_milestone=1 if data.is_milestone else 0,
        depth=1,
        sort_order=sort_order,
        dependencies=json.dumps(data.dependencies) if data.dependencies else None,
    )

    db.add(subphase)
    await db.commit()

    return {
        "id": subphase.id,
        "parent_id": subphase.parent_id,
        "parent_type": subphase.parent_type,
        "project_id": subphase.project_id,
        "name": subphase.name,
        "start_date": subphase.start_date,
        "end_date": subphase.end_date,
        "is_milestone": subphase.is_milestone == 1,
        "sort_order": subphase.sort_order,
        "depth": subphase.depth,
        "completion": subphase.completion,
        "dependencies": [],
        "staffAssignments": [],
        "children": [],
    }


@router.post("/subphases/{subphase_id}/children")
async def create_child_subphase(
    subphase_id: int,
    data: SubphaseCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Add a child subphase to an existing subphase.

    Matches: POST /api/subphases/:subphaseId/children
    """
    # Get parent subphase
    result = await db.execute(select(ProjectSubphase).where(ProjectSubphase.id == subphase_id))
    parent = result.scalar_one_or_none()

    if not parent:
        raise HTTPException(status_code=404, detail="Parent subphase not found")

    # Use parent's project_id if not provided
    project_id = data.project_id or parent.project_id

    # Check max depth
    new_depth = (parent.depth or 1) + 1
    if new_depth > 10:
        raise HTTPException(status_code=400, detail="Maximum depth of 10 levels reached")

    # Determine sort_order
    if data.order_index is not None:
        # Insert at specific position - shift existing subphases
        await db.execute(
            update(ProjectSubphase)
            .where(
                and_(
                    ProjectSubphase.parent_id == subphase_id,
                    ProjectSubphase.parent_type == "subphase",
                    ProjectSubphase.sort_order >= data.order_index,
                )
            )
            .values(sort_order=ProjectSubphase.sort_order + 1)
        )
        sort_order = data.order_index
    else:
        # Get max sort_order and append
        max_result = await db.execute(
            select(func.max(ProjectSubphase.sort_order)).where(
                and_(
                    ProjectSubphase.parent_id == subphase_id,
                    ProjectSubphase.parent_type == "subphase",
                )
            )
        )
        max_order = max_result.scalar() or 0
        sort_order = max_order + 1

    subphase = ProjectSubphase(
        parent_id=subphase_id,
        parent_type="subphase",
        project_id=project_id,
        name=data.name,
        start_date=data.start_date,
        end_date=data.end_date,
        is_milestone=1 if data.is_milestone else 0,
        depth=new_depth,
        sort_order=sort_order,
        dependencies=json.dumps(data.dependencies) if data.dependencies else None,
    )

    db.add(subphase)
    await db.commit()

    return {
        "id": subphase.id,
        "parent_id": subphase.parent_id,
        "parent_type": subphase.parent_type,
        "project_id": subphase.project_id,
        "name": subphase.name,
        "start_date": subphase.start_date,
        "end_date": subphase.end_date,
        "is_milestone": subphase.is_milestone == 1,
        "sort_order": subphase.sort_order,
        "depth": subphase.depth,
        "completion": subphase.completion,
        "dependencies": [],
        "staffAssignments": [],
        "children": [],
    }


@router.put("/subphases/{subphase_id}")
async def update_subphase(
    subphase_id: int,
    data: SubphaseUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Update a subphase.

    Matches: PUT /api/subphases/:id
    """
    result = await db.execute(select(ProjectSubphase).where(ProjectSubphase.id == subphase_id))
    subphase = result.scalar_one_or_none()

    if not subphase:
        raise HTTPException(status_code=404, detail="Subphase not found")

    project_id = subphase.project_id

    if data.name is not None:
        subphase.name = data.name
    if data.start_date is not None:
        subphase.start_date = data.start_date
    if data.end_date is not None:
        subphase.end_date = data.end_date
    if data.is_milestone is not None:
        subphase.is_milestone = 1 if data.is_milestone else 0
    if data.dependencies is not None:
        subphase.dependencies = json.dumps(data.dependencies)
    if data.completion is not None:
        subphase.completion = data.completion

    await db.commit()

    # Broadcast change to other users
    await broadcast_change(
        request=request,
        user=user,
        entity_type="subphase",
        entity_id=subphase_id,
        project_id=project_id,
        action="update",
    )

    return {"success": True}


@router.delete("/subphases/{subphase_id}")
async def delete_subphase(
    subphase_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Delete a subphase and all its descendants.

    Matches: DELETE /api/subphases/:id
    """
    # For SQLite/PostgreSQL, we need to recursively delete descendants
    # PostgreSQL doesn't support recursive CTEs in DELETE directly through SQLAlchemy
    # So we'll do it iteratively

    async def get_descendant_ids(parent_id: int) -> list[int]:
        """Get all descendant subphase IDs recursively."""
        ids = [parent_id]
        result = await db.execute(
            select(ProjectSubphase.id).where(
                and_(
                    ProjectSubphase.parent_id == parent_id,
                    ProjectSubphase.parent_type == "subphase",
                )
            )
        )
        child_ids = [r[0] for r in result.all()]
        for child_id in child_ids:
            ids.extend(await get_descendant_ids(child_id))
        return ids

    all_ids = await get_descendant_ids(subphase_id)

    # Delete all staff assignments for these subphases
    await db.execute(
        SubphaseStaffAssignment.__table__.delete().where(
            SubphaseStaffAssignment.subphase_id.in_(all_ids)
        )
    )

    # Delete subphases (children first due to potential FK constraints)
    for sp_id in reversed(all_ids):
        await db.execute(ProjectSubphase.__table__.delete().where(ProjectSubphase.id == sp_id))

    await db.commit()

    return {"success": True}


@router.put("/subphases/{parent_id}/reorder")
async def reorder_subphases(
    parent_id: int,
    data: SubphaseReorderRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Reorder subphases within a parent.

    Matches: PUT /api/subphases/:parentId/reorder
    """
    for index, subphase_id in enumerate(data.subphase_order):
        await db.execute(
            ProjectSubphase.__table__.update()
            .where(
                and_(
                    ProjectSubphase.id == subphase_id,
                    ProjectSubphase.parent_id == parent_id,
                    ProjectSubphase.parent_type == data.parent_type,
                )
            )
            .values(sort_order=index)
        )

    await db.commit()

    return {"success": True}
