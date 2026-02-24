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

from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, and_
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User, UserSite
from app.models.site import Site
from app.models.assignment import ProjectAssignment
from app.middleware.auth import get_current_user
from app.schemas.user import (
    StaffResponse,
    StaffDetailResponse,
)

router = APIRouter()


def build_staff_row(user: User, site: Site = None) -> dict:
    """
    Build a staff response row matching Node.js format.
    
    Returns one row per user-site combination.
    """
    # Build skills list from user's skills relationship
    skills = []
    if hasattr(user, 'skills') and user.skills:
        skills = [
            {"id": skill.id, "name": skill.name, "color": skill.color}
            for skill in user.skills
        ]
    
    return {
        "id": user.id,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "name": f"{user.first_name} {user.last_name}",
        "role": user.job_title,  # Node.js uses job_title as 'role'
        "email": user.email,
        "active": user.active,
        "max_capacity": user.max_capacity if hasattr(user, 'max_capacity') else 100,
        "site_id": site.id if site else None,
        "site_name": site.name if site else None,
        "skills": skills,
    }


@router.get("/staff", response_model=List[StaffResponse])
async def get_staff(
    siteId: Optional[int] = Query(None),
    includeAllSites: Optional[bool] = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get staff members.
    
    If siteId provided, returns staff for that site.
    If includeAllSites=true, returns all staff across all sites.
    
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
        .where(User.role != 'admin')  # Exclude admins
        .where(User.active == 1)
        .options(selectinload(User.skills))
        .order_by(User.first_name, User.last_name)
    )
    
    if siteId and not includeAllSites:
        query = query.where(UserSite.site_id == siteId)
    
    result = await db.execute(query)
    rows = result.unique().all()
    
    # Build response with one row per user-site
    return [build_staff_row(user, site) for user, site in rows]


@router.get("/staff/{staff_id}", response_model=StaffDetailResponse)
async def get_staff_member(
    staff_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get a specific staff member by ID.
    
    Matches: GET /api/staff/:id
    """
    result = await db.execute(
        select(User)
        .where(User.id == staff_id)
        .options(selectinload(User.sites))
    )
    staff = result.scalar_one_or_none()
    
    if not staff:
        raise HTTPException(status_code=404, detail="Staff member not found")
    
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
    )


@router.get("/staff/{staff_id}/availability")
async def get_staff_availability(
    staff_id: int,
    startDate: str = Query(..., description="Start date (YYYY-MM-DD)"),
    endDate: str = Query(..., description="End date (YYYY-MM-DD)"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get staff availability for a date range.
    
    Matches: GET /api/staff/:id/availability
    
    Returns daily allocation percentages showing how much of
    the staff member's time is allocated and available.
    """
    start = datetime.strptime(startDate, "%Y-%m-%d").date()
    end = datetime.strptime(endDate, "%Y-%m-%d").date()
    
    # Get all assignments for this staff member that overlap with date range
    result = await db.execute(
        select(ProjectAssignment.allocation, ProjectAssignment.start_date, ProjectAssignment.end_date)
        .where(
            and_(
                ProjectAssignment.staff_id == staff_id,
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
        
        availability.append({
            "date": current.strftime("%Y-%m-%d"),
            "allocated": allocated,
            "available": max(0, 100 - allocated),
        })
        
        current += timedelta(days=1)
    
    return availability
