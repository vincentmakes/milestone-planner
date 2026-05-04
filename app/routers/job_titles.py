"""
Job Titles API router.
Handles CRUD operations for the managed list of user job titles.

SSO provisioning intentionally bypasses this list — see app/routers/auth.py
where job_title is taken directly from the Entra ID claim.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_superuser
from app.models.settings import JobTitle
from app.models.user import User
from app.schemas.job_titles import (
    JobTitleCreate,
    JobTitleReorderRequest,
    JobTitleResponse,
    JobTitleUpdate,
)

router = APIRouter()


@router.get("/job-titles", response_model=list[JobTitleResponse])
async def get_active_job_titles(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get active job titles. Any authenticated user."""
    result = await db.execute(
        select(JobTitle).where(JobTitle.is_active == 1).order_by(JobTitle.sort_order)
    )
    return result.scalars().all()


@router.get("/job-titles/all", response_model=list[JobTitleResponse])
async def get_all_job_titles(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """Get all job titles, including inactive ones. Admin/superuser only."""
    result = await db.execute(select(JobTitle).order_by(JobTitle.sort_order))
    return result.scalars().all()


@router.post("/job-titles", response_model=JobTitleResponse, status_code=201)
async def create_job_title(
    data: JobTitleCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    result = await db.execute(select(func.max(JobTitle.sort_order)))
    max_order = result.scalar() or -1

    job_title = JobTitle(name=data.name.strip(), sort_order=max_order + 1, is_active=1)

    try:
        db.add(job_title)
        await db.commit()
        await db.refresh(job_title)
    except Exception as e:
        await db.rollback()
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(
                status_code=400, detail="A job title with this name already exists"
            ) from e
        raise HTTPException(status_code=500, detail=str(e)) from e

    return job_title


@router.put("/job-titles/reorder")
async def reorder_job_titles(
    data: JobTitleReorderRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    for index, job_title_id in enumerate(data.job_title_order):
        result = await db.execute(select(JobTitle).where(JobTitle.id == job_title_id))
        job_title = result.scalar_one_or_none()
        if job_title:
            job_title.sort_order = index

    await db.commit()
    return {"success": True}


@router.put("/job-titles/{job_title_id}", response_model=JobTitleResponse)
async def update_job_title(
    job_title_id: int,
    data: JobTitleUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    result = await db.execute(select(JobTitle).where(JobTitle.id == job_title_id))
    job_title = result.scalar_one_or_none()

    if not job_title:
        raise HTTPException(status_code=404, detail="Job title not found")

    if data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Job title name cannot be empty")
        job_title.name = name

    if data.is_active is not None:
        job_title.is_active = 1 if data.is_active else 0

    try:
        await db.commit()
        await db.refresh(job_title)
    except Exception as e:
        await db.rollback()
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(
                status_code=400, detail="A job title with this name already exists"
            ) from e
        raise HTTPException(status_code=500, detail=str(e)) from e

    return job_title


@router.delete("/job-titles/{job_title_id}")
async def delete_job_title(
    job_title_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    result = await db.execute(select(JobTitle).where(JobTitle.id == job_title_id))
    job_title = result.scalar_one_or_none()

    if not job_title:
        raise HTTPException(status_code=404, detail="Job title not found")

    await db.delete(job_title)
    await db.commit()

    return {"success": True}
