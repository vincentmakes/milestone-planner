"""
Predefined Phases API router.
Handles CRUD operations for phase templates.

Matches the Node.js API at /api/predefined-phases exactly.
"""

from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.settings import PredefinedPhase
from app.models.user import User
from app.middleware.auth import get_current_user, require_superuser
from app.schemas.predefined_phases import (
    PredefinedPhaseResponse,
    PredefinedPhaseCreate,
    PredefinedPhaseUpdate,
    PhaseReorderRequest,
)

router = APIRouter()


@router.get("/predefined-phases", response_model=List[PredefinedPhaseResponse])
async def get_active_predefined_phases(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get all active predefined phases.
    
    Requires authentication.
    Matches: GET /api/predefined-phases
    """
    result = await db.execute(
        select(PredefinedPhase)
        .where(PredefinedPhase.is_active == 1)
        .order_by(PredefinedPhase.sort_order)
    )
    phases = result.scalars().all()
    return phases


@router.get("/predefined-phases/all", response_model=List[PredefinedPhaseResponse])
async def get_all_predefined_phases(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Get all predefined phases including inactive ones.
    
    Requires admin or superuser authentication.
    Matches: GET /api/predefined-phases/all
    """
    result = await db.execute(
        select(PredefinedPhase).order_by(PredefinedPhase.sort_order)
    )
    phases = result.scalars().all()
    return phases


@router.post("/predefined-phases", response_model=PredefinedPhaseResponse, status_code=201)
async def create_predefined_phase(
    data: PredefinedPhaseCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Create a new predefined phase.
    
    Requires admin or superuser authentication.
    Matches: POST /api/predefined-phases
    """
    # Get max sort_order
    result = await db.execute(
        select(func.max(PredefinedPhase.sort_order))
    )
    max_order = result.scalar() or -1
    
    # Create new phase
    phase = PredefinedPhase(
        name=data.name.strip(),
        sort_order=max_order + 1,
        is_active=1,
    )
    
    try:
        db.add(phase)
        await db.commit()
        await db.refresh(phase)
    except Exception as e:
        await db.rollback()
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(
                status_code=400,
                detail="A phase with this name already exists"
            )
        raise HTTPException(status_code=500, detail=str(e))
    
    return phase


@router.put("/predefined-phases/reorder")
async def reorder_predefined_phases(
    data: PhaseReorderRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Reorder predefined phases.
    
    Requires admin or superuser authentication.
    Matches: PUT /api/predefined-phases/reorder
    """
    for index, phase_id in enumerate(data.phase_order):
        result = await db.execute(
            select(PredefinedPhase).where(PredefinedPhase.id == phase_id)
        )
        phase = result.scalar_one_or_none()
        if phase:
            phase.sort_order = index
    
    await db.commit()
    return {"success": True}


@router.put("/predefined-phases/{phase_id}", response_model=PredefinedPhaseResponse)
async def update_predefined_phase(
    phase_id: int,
    data: PredefinedPhaseUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Update a predefined phase.
    
    Requires admin or superuser authentication.
    Matches: PUT /api/predefined-phases/:id
    """
    result = await db.execute(
        select(PredefinedPhase).where(PredefinedPhase.id == phase_id)
    )
    phase = result.scalar_one_or_none()
    
    if not phase:
        raise HTTPException(status_code=404, detail="Predefined phase not found")
    
    # Update fields if provided
    if data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Phase name cannot be empty")
        phase.name = name
    
    if data.is_active is not None:
        phase.is_active = 1 if data.is_active else 0
    
    try:
        await db.commit()
        await db.refresh(phase)
    except Exception as e:
        await db.rollback()
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(
                status_code=400,
                detail="A phase with this name already exists"
            )
        raise HTTPException(status_code=500, detail=str(e))
    
    return phase


@router.delete("/predefined-phases/{phase_id}")
async def delete_predefined_phase(
    phase_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Delete a predefined phase.
    
    Requires admin or superuser authentication.
    Matches: DELETE /api/predefined-phases/:id
    """
    result = await db.execute(
        select(PredefinedPhase).where(PredefinedPhase.id == phase_id)
    )
    phase = result.scalar_one_or_none()
    
    if not phase:
        raise HTTPException(status_code=404, detail="Predefined phase not found")
    
    await db.delete(phase)
    await db.commit()
    
    return {"success": True}
