"""
Absence types API router.

Absence types categorise vacations (Holidays, Home Office, Illness, ...). They
are tenant-wide, so only admins manage them; every user can read them.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_admin
from app.models.absence_type import AbsenceType
from app.models.user import User
from app.models.vacation import Vacation
from app.schemas.absence_type import (
    AbsenceTypeCreate,
    AbsenceTypeReorderRequest,
    AbsenceTypeResponse,
    AbsenceTypeUpdate,
)

router = APIRouter()

DUPLICATE_NAME_DETAIL = "An absence type with this name already exists"
IN_USE_DETAIL = "This absence type is in use; deactivate it instead"


async def _name_taken(db: AsyncSession, name: str, exclude_id: int | None = None) -> bool:
    query = select(AbsenceType.id).where(AbsenceType.name == name)
    if exclude_id is not None:
        query = query.where(AbsenceType.id != exclude_id)
    result = await db.execute(query)
    return result.scalar_one_or_none() is not None


@router.get("/absence-types", response_model=list[AbsenceTypeResponse])
async def get_absence_types(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get all absence types, active and inactive.

    Inactive types are still returned so existing absences keep their label
    and colour; clients hide them from pickers.
    """
    result = await db.execute(select(AbsenceType).order_by(AbsenceType.sort_order, AbsenceType.id))
    return result.scalars().all()


@router.post("/absence-types", response_model=AbsenceTypeResponse, status_code=201)
async def create_absence_type(
    data: AbsenceTypeCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Create an absence type, appended at the end of the list. Admin only."""
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Absence type name cannot be empty")
    if await _name_taken(db, name):
        raise HTTPException(status_code=400, detail=DUPLICATE_NAME_DETAIL)

    max_order = (await db.execute(select(func.max(AbsenceType.sort_order)))).scalar()
    absence_type = AbsenceType(
        name=name,
        color=data.color,
        counts_as_unavailable=data.counts_as_unavailable,
        is_active=data.is_active,
        sort_order=(max_order + 1) if max_order is not None else 0,
    )
    db.add(absence_type)
    await db.commit()
    await db.refresh(absence_type)
    return absence_type


# Declared before the /{type_id} routes so "reorder" is not parsed as an id.
@router.put("/absence-types/reorder")
async def reorder_absence_types(
    data: AbsenceTypeReorderRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Reorder absence types. Admin only."""
    if data.type_order:
        result = await db.execute(select(AbsenceType).where(AbsenceType.id.in_(data.type_order)))
        by_id = {t.id: t for t in result.scalars().all()}
        for index, type_id in enumerate(data.type_order):
            if type_id in by_id:
                by_id[type_id].sort_order = index

    await db.commit()
    return {"success": True}


@router.put("/absence-types/{type_id}", response_model=AbsenceTypeResponse)
async def update_absence_type(
    type_id: int,
    data: AbsenceTypeUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Update an absence type (partial). Admin only."""
    absence_type = await db.get(AbsenceType, type_id)
    if not absence_type:
        raise HTTPException(status_code=404, detail="Absence type not found")

    if data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Absence type name cannot be empty")
        if name != absence_type.name and await _name_taken(db, name, exclude_id=type_id):
            raise HTTPException(status_code=400, detail=DUPLICATE_NAME_DETAIL)
        absence_type.name = name
    if data.color is not None:
        absence_type.color = data.color
    if data.counts_as_unavailable is not None:
        absence_type.counts_as_unavailable = data.counts_as_unavailable
    if data.is_active is not None:
        absence_type.is_active = data.is_active

    await db.commit()
    await db.refresh(absence_type)
    return absence_type


@router.delete("/absence-types/{type_id}")
async def delete_absence_type(
    type_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Delete an absence type. Admin only.

    Refused with 409 while any vacation still uses the type: deleting it would
    silently turn those absences into untyped ones. Deactivate it instead.
    """
    absence_type = await db.get(AbsenceType, type_id)
    if not absence_type:
        raise HTTPException(status_code=404, detail="Absence type not found")

    in_use = await db.execute(
        select(Vacation.id).where(Vacation.absence_type_id == type_id).limit(1)
    )
    if in_use.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail=IN_USE_DETAIL)

    await db.delete(absence_type)
    await db.commit()
    return {"success": True}
