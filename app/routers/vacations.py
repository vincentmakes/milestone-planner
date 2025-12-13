"""
Vacations API router.
Handles vacation/time-off operations.

Matches the Node.js API at /api/vacations exactly.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.vacation import Vacation
from app.models.user import User, UserSite
from app.middleware.auth import get_current_user, require_superuser
from app.schemas.vacation import (
    VacationResponse,
    VacationCreate,
    VacationUpdate,
)

router = APIRouter()


def build_vacation_response(vacation: Vacation, can_edit: bool = False) -> dict:
    """Build vacation response dict."""
    staff_name = ""
    if vacation.staff:
        staff_name = f"{vacation.staff.first_name} {vacation.staff.last_name}".strip()
    
    return {
        "id": vacation.id,
        "staff_id": vacation.staff_id,
        "staff_name": staff_name,
        "start_date": vacation.start_date,
        "end_date": vacation.end_date,
        "description": vacation.description,
        "created_at": vacation.created_at,
        "canEdit": can_edit,
    }


@router.get("/vacations", response_model=List[VacationResponse])
async def get_vacations(
    siteId: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get vacations.
    
    If siteId provided, returns vacations for staff in that site.
    
    Matches: GET /api/vacations
    """
    if siteId:
        # Get vacations for staff in specific site
        result = await db.execute(
            select(Vacation)
            .join(User, Vacation.staff_id == User.id)
            .join(UserSite, User.id == UserSite.user_id)
            .where(UserSite.site_id == siteId)
            .options(selectinload(Vacation.staff))
            .order_by(Vacation.start_date)
        )
    else:
        # Get all vacations
        result = await db.execute(
            select(Vacation)
            .options(selectinload(Vacation.staff))
            .order_by(Vacation.start_date)
        )
    
    vacations = result.scalars().all()
    
    # Determine canEdit for each vacation based on current user
    response = []
    for v in vacations:
        # User can edit their own vacations, or admin/superuser can edit any
        can_edit = (
            v.staff_id == current_user.id or 
            current_user.is_admin or 
            current_user.is_superuser
        )
        response.append(build_vacation_response(v, can_edit=can_edit))
    
    return response


@router.get("/vacations/{vacation_id}", response_model=VacationResponse)
async def get_vacation(
    vacation_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get a specific vacation by ID.
    """
    result = await db.execute(
        select(Vacation)
        .where(Vacation.id == vacation_id)
        .options(selectinload(Vacation.staff))
    )
    vacation = result.scalar_one_or_none()
    
    if not vacation:
        raise HTTPException(status_code=404, detail="Vacation not found")
    
    can_edit = (
        vacation.staff_id == current_user.id or 
        current_user.is_admin or 
        current_user.is_superuser
    )
    return build_vacation_response(vacation, can_edit=can_edit)


@router.post("/vacations", response_model=VacationResponse, status_code=201)
async def create_vacation(
    data: VacationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Create a new vacation.
    
    Requires authentication.
    Users can only create vacations for themselves.
    Admins/superusers can create for anyone.
    
    Matches: POST /api/vacations
    """
    # Verify staff exists
    result = await db.execute(
        select(User).where(User.id == data.staff_id)
    )
    staff = result.scalar_one_or_none()
    
    if not staff:
        raise HTTPException(status_code=404, detail="Staff member not found")
    
    # Check permission - users can only create for themselves
    if data.staff_id != current_user.id and not (current_user.is_admin or current_user.is_superuser):
        raise HTTPException(
            status_code=403,
            detail="You can only create vacations for yourself"
        )
    
    vacation = Vacation(
        staff_id=data.staff_id,
        start_date=data.start_date,
        end_date=data.end_date,
        description=data.description or "Vacation",
    )
    
    db.add(vacation)
    await db.commit()
    await db.refresh(vacation)
    
    # Load staff relationship
    vacation.staff = staff
    
    return build_vacation_response(vacation, can_edit=True)


@router.put("/vacations/{vacation_id}", response_model=VacationResponse)
async def update_vacation(
    vacation_id: int,
    data: VacationUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Update a vacation.
    
    Requires authentication.
    Users can only update their own vacations.
    Admins/superusers can update any.
    
    Matches: PUT /api/vacations/:id
    """
    result = await db.execute(
        select(Vacation)
        .where(Vacation.id == vacation_id)
        .options(selectinload(Vacation.staff))
    )
    vacation = result.scalar_one_or_none()
    
    if not vacation:
        raise HTTPException(status_code=404, detail="Vacation not found")
    
    # Check permission
    if vacation.staff_id != current_user.id and not (current_user.is_admin or current_user.is_superuser):
        raise HTTPException(
            status_code=403,
            detail="You can only edit your own vacations"
        )
    
    # Update fields
    if data.start_date is not None:
        vacation.start_date = data.start_date
    if data.end_date is not None:
        vacation.end_date = data.end_date
    if data.description is not None:
        vacation.description = data.description
    
    await db.commit()
    await db.refresh(vacation)
    
    return build_vacation_response(vacation, can_edit=True)


@router.delete("/vacations/{vacation_id}")
async def delete_vacation(
    vacation_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Delete a vacation.
    
    Requires authentication.
    Users can only delete their own vacations.
    Admins/superusers can delete any.
    
    Matches: DELETE /api/vacations/:id
    """
    result = await db.execute(
        select(Vacation).where(Vacation.id == vacation_id)
    )
    vacation = result.scalar_one_or_none()
    
    if not vacation:
        raise HTTPException(status_code=404, detail="Vacation not found")
    
    # Check permission
    if vacation.staff_id != current_user.id and not (current_user.is_admin or current_user.is_superuser):
        raise HTTPException(
            status_code=403,
            detail="You can only delete your own vacations"
        )
    
    await db.delete(vacation)
    await db.commit()
    
    return {"success": True}
