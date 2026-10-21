"""
Staff API router.
Handles staff (users as resources) read operations.

Staff are users who can be assigned to projects.
Matches the Node.js API at /api/staff exactly.

Note: The Node.js API returns one row per user-site combination,
so users with multiple sites appear multiple times in the results.

Staff CUD (Create/Update/Delete) operations are handled via
User Management (/api/users routes). Staff = non-admin users assigned to sites.
"""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.middleware.auth import get_current_user, require_permission
from app.models.assignment import ProjectAssignment
from app.models.site import Site
from app.models.user import User, UserSite
from app.schemas.user import (
    StaffDetailResponse,
    StaffResponse,
)
from app.services.date_range import parse_day_range
from app.services.response_builders import build_skills_list, get_max_capacity
from app.services.site_access import (
    ensure_person_visible,
    ensure_site_visible,
    visible_site_ids,
    visible_sites_clause,
)

STAFF_NOT_FOUND_DETAIL = "Staff member not found"

router = APIRouter()


def build_staff_row(user: User, site: Site | None = None) -> dict:
    """
    Build a staff response row matching Node.js format.

    Returns one row per user-site combination.
    """
    return {
        "id": user.id,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "name": user.full_name,
        "role": user.job_title,  # Node.js uses job_title as 'role'
        "email": user.email,
        "active": user.active,
        "max_capacity": get_max_capacity(user),
        "site_id": site.id if site else None,
        "site_name": site.name if site else None,
        "skills": build_skills_list(user),
        # Only the teams at this row's site (a team belongs to one site).
        "team_ids": sorted(t.id for t in user.teams if site is not None and t.site_id == site.id),
    }


@router.get("/staff", response_model=list[StaffResponse])
async def get_staff(
    request: Request,
    siteId: int | None = Query(None),
    includeAllSites: bool | None = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get staff members.

    If siteId provided, returns staff for that site (403 outside the user's
    visible sites). Otherwise (or with includeAllSites=true) returns the staff
    of every visible site.

    Note: Returns one row per user-site combination (matching Node.js).
    Admin users are excluded from results.

    Matches: GET /api/staff
    """
    # Build query matching Node.js exactly:
    # - Excludes admin users
    # - Returns one row per user-site combo
    # - Orders by first_name, last_name
    # - Eager load skills
    query = (
        select(User, Site)
        .outerjoin(UserSite, User.id == UserSite.user_id)
        .outerjoin(Site, UserSite.site_id == Site.id)
        .where(User.role != "admin")  # Exclude admins
        .where(User.active == 1)
        .options(selectinload(User.skills), selectinload(User.teams))
        .order_by(User.first_name, User.last_name)
    )

    if siteId and not includeAllSites:
        await ensure_site_visible(request, db, user, siteId)
        query = query.where(UserSite.site_id == siteId)
    else:
        in_visible = visible_sites_clause(
            UserSite.site_id, await visible_site_ids(request, db, user)
        )
        if in_visible is not None:
            query = query.where(in_visible)

    result = await db.execute(query)
    rows = result.unique().all()

    # Build response with one row per user-site
    return [build_staff_row(user, site) for user, site in rows]


@router.get("/staff/{staff_id}", response_model=StaffDetailResponse)
async def get_staff_member(
    staff_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get a specific staff member by ID: oneself or someone sharing a visible
    site (404 otherwise).

    Matches: GET /api/staff/:id
    """
    await ensure_person_visible(
        request, db, current_user, staff_id, status_code=404, detail=STAFF_NOT_FOUND_DETAIL
    )
    result = await db.execute(
        select(User).where(User.id == staff_id).options(selectinload(User.sites))
    )
    staff = result.scalar_one_or_none()

    if not staff:
        raise HTTPException(status_code=404, detail=STAFF_NOT_FOUND_DETAIL)

    return StaffDetailResponse(
        id=staff.id,
        email=staff.email,
        first_name=staff.first_name,
        last_name=staff.last_name,
        job_title=staff.job_title,
        role=staff.role,
        active=staff.active,
        created_at=staff.created_at,
        sites=[{"id": s.id, "name": s.name} for s in staff.sites],
        team_ids=staff.team_ids,
    )


@router.get("/staff/{staff_id}/availability")
async def get_staff_availability(
    staff_id: int,
    request: Request,
    startDate: str = Query(..., description="Start date (YYYY-MM-DD)"),
    endDate: str = Query(..., description="End date (YYYY-MM-DD)"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("views.staff")),
):
    """
    Get staff availability for a date range (``views.staff``; the person must
    be oneself or share a visible site, 404 otherwise).

    Matches: GET /api/staff/:id/availability

    Returns daily allocation percentages showing how much of
    the staff member's time is allocated and available.
    """
    start, end = parse_day_range(startDate, endDate)
    await ensure_person_visible(
        request, db, user, staff_id, status_code=404, detail=STAFF_NOT_FOUND_DETAIL
    )

    # Get all assignments for this staff member that overlap with date range
    result = await db.execute(
        select(
            ProjectAssignment.allocation, ProjectAssignment.start_date, ProjectAssignment.end_date
        ).where(
            and_(
                ProjectAssignment.staff_id == staff_id,
                # A booking awaiting approval does not take capacity yet.
                ProjectAssignment.approval_status == "approved",
                ProjectAssignment.start_date <= end,
                ProjectAssignment.end_date >= start,
            )
        )
    )
    assignments = result.all()

    # Calculate daily availability
    availability = []
    current = start
    while current <= end:
        allocated = 0

        for alloc, a_start, a_end in assignments:
            if a_start <= current and a_end >= current:
                allocated += alloc

        availability.append(
            {
                "date": current.strftime("%Y-%m-%d"),
                "allocated": allocated,
                "available": max(0, 100 - allocated),
            }
        )

        current += timedelta(days=1)

    return availability
