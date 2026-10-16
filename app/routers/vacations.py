"""
Vacations API router.
Handles vacation/time-off operations.

Matches the Node.js API at /api/vacations exactly.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.absence_type import AbsenceType
from app.models.user import User, UserSite
from app.models.vacation import Vacation
from app.schemas.vacation import (
    ImportResult,
    VacationCreate,
    VacationImportRequest,
    VacationResponse,
    VacationUpdate,
)
from app.services.date_range import ensure_date_order

router = APIRouter()


def build_vacation_response(vacation: Vacation, can_edit: bool = False) -> dict:
    """Build vacation response dict."""
    staff_name = vacation.staff.full_name if vacation.staff else ""

    return {
        "id": vacation.id,
        "staff_id": vacation.staff_id,
        "staff_name": staff_name,
        "start_date": vacation.start_date,
        "end_date": vacation.end_date,
        "description": vacation.description,
        "absence_type_id": vacation.absence_type_id,
        "created_at": vacation.created_at,
        "canEdit": can_edit,
    }


async def ensure_absence_types_exist(db: AsyncSession, type_ids: set[int]) -> None:
    """Raise 400 if any of the given absence type ids does not exist."""
    if not type_ids:
        return
    result = await db.execute(select(AbsenceType.id).where(AbsenceType.id.in_(type_ids)))
    missing = type_ids - set(result.scalars().all())
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown absence type: {', '.join(str(i) for i in sorted(missing))}",
        )


@router.get("/vacations", response_model=list[VacationResponse])
async def get_vacations(
    siteId: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Get vacations.

    If siteId provided, returns vacations for staff in that site. Without it,
    superusers/admins get every absence; a plain user gets their own plus
    those of people sharing at least one site with them (absence
    descriptions are personal, so not tenant-wide for everyone).

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
    elif current_user.is_admin or current_user.is_superuser:
        # Get all vacations
        result = await db.execute(
            select(Vacation).options(selectinload(Vacation.staff)).order_by(Vacation.start_date)
        )
    else:
        # Site memberships come from the database, not the session snapshot.
        my_sites = select(UserSite.site_id).where(UserSite.user_id == current_user.id)
        colleagues = select(UserSite.user_id).where(UserSite.site_id.in_(my_sites))
        result = await db.execute(
            select(Vacation)
            .where(
                or_(
                    Vacation.staff_id == current_user.id,
                    Vacation.staff_id.in_(colleagues),
                )
            )
            .options(selectinload(Vacation.staff))
            .order_by(Vacation.start_date)
        )

    vacations = result.scalars().all()

    # Determine canEdit for each vacation based on current user
    response = []
    for v in vacations:
        # User can edit their own vacations, or admin/superuser can edit any
        can_edit = (
            v.staff_id == current_user.id or current_user.is_admin or current_user.is_superuser
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
        select(Vacation).where(Vacation.id == vacation_id).options(selectinload(Vacation.staff))
    )
    vacation = result.scalar_one_or_none()

    if not vacation:
        raise HTTPException(status_code=404, detail="Vacation not found")

    can_edit = (
        vacation.staff_id == current_user.id or current_user.is_admin or current_user.is_superuser
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
    result = await db.execute(select(User).where(User.id == data.staff_id))
    staff = result.scalar_one_or_none()

    if not staff:
        raise HTTPException(status_code=404, detail="Staff member not found")

    # Check permission - users can only create for themselves
    if data.staff_id != current_user.id and not (
        current_user.is_admin or current_user.is_superuser
    ):
        raise HTTPException(status_code=403, detail="You can only create vacations for yourself")

    if data.absence_type_id is not None:
        await ensure_absence_types_exist(db, {data.absence_type_id})

    vacation = Vacation(
        staff_id=data.staff_id,
        start_date=data.start_date,
        end_date=data.end_date,
        description=data.description or "Vacation",
        absence_type_id=data.absence_type_id,
    )

    db.add(vacation)
    await db.commit()
    await db.refresh(vacation)

    # Load staff relationship
    vacation.staff = staff

    return build_vacation_response(vacation, can_edit=True)


@router.post("/vacations/import", response_model=ImportResult)
async def import_vacations(
    data: VacationImportRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Import absences for one staff member (e.g. parsed from an .ics file).

    Same permission rule as create: users import for themselves only,
    admins/superusers for anyone. Items whose (start_date, end_date) already
    exist for that person - or repeat within the batch - are skipped. All rows
    are written in one transaction.
    """
    result = await db.execute(select(User).where(User.id == data.staff_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Staff member not found")

    if data.staff_id != current_user.id and not (
        current_user.is_admin or current_user.is_superuser
    ):
        raise HTTPException(status_code=403, detail="You can only create vacations for yourself")

    for index, item in enumerate(data.items):
        if item.end_date < item.start_date:
            raise HTTPException(
                status_code=400,
                detail=f"Item {index + 1}: end date is before start date",
            )

    await ensure_absence_types_exist(
        db, {item.absence_type_id for item in data.items if item.absence_type_id is not None}
    )

    existing = await db.execute(
        select(Vacation.start_date, Vacation.end_date).where(Vacation.staff_id == data.staff_id)
    )
    taken = {(row.start_date, row.end_date) for row in existing}

    created = skipped = 0
    for item in data.items:
        key = (item.start_date, item.end_date)
        if key in taken:
            skipped += 1
            continue
        taken.add(key)
        db.add(
            Vacation(
                staff_id=data.staff_id,
                start_date=item.start_date,
                end_date=item.end_date,
                description=item.description or "Vacation",
                absence_type_id=item.absence_type_id,
            )
        )
        created += 1

    if created:
        await db.commit()

    return {"created": created, "skipped": skipped}


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
        select(Vacation).where(Vacation.id == vacation_id).options(selectinload(Vacation.staff))
    )
    vacation = result.scalar_one_or_none()

    if not vacation:
        raise HTTPException(status_code=404, detail="Vacation not found")

    # Check permission
    if vacation.staff_id != current_user.id and not (
        current_user.is_admin or current_user.is_superuser
    ):
        raise HTTPException(status_code=403, detail="You can only edit your own vacations")

    # Update fields
    if data.start_date is not None:
        vacation.start_date = data.start_date
    if data.end_date is not None:
        vacation.end_date = data.end_date
    if data.start_date is not None or data.end_date is not None:
        ensure_date_order(vacation.start_date, vacation.end_date)
    if data.description is not None:
        vacation.description = data.description
    # Explicit null clears the type, so check whether the field was sent at all.
    if "absence_type_id" in data.model_fields_set:
        if data.absence_type_id is not None:
            await ensure_absence_types_exist(db, {data.absence_type_id})
        vacation.absence_type_id = data.absence_type_id

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
    result = await db.execute(select(Vacation).where(Vacation.id == vacation_id))
    vacation = result.scalar_one_or_none()

    if not vacation:
        raise HTTPException(status_code=404, detail="Vacation not found")

    # Check permission
    if vacation.staff_id != current_user.id and not (
        current_user.is_admin or current_user.is_superuser
    ):
        raise HTTPException(status_code=403, detail="You can only delete your own vacations")

    await db.delete(vacation)
    await db.commit()

    return {"success": True}
