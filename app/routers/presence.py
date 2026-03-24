"""
Project Presence API endpoints.

Handles tracking which users are viewing/editing projects to prevent conflicts.
"""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import and_, delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.middleware.auth import get_current_user as require_user
from app.models.presence import PRESENCE_TIMEOUT_SECONDS, ProjectPresence
from app.models.project import Project
from app.models.user import User

router = APIRouter(tags=["presence"])


# ============================================================================
# Schemas
# ============================================================================


class PresenceHeartbeat(BaseModel):
    """Heartbeat request to maintain presence."""

    project_id: int
    activity: str = "viewing"  # viewing or editing


class PresenceUser(BaseModel):
    """User presence info."""

    user_id: int
    first_name: str
    last_name: str
    activity: str
    started_at: datetime
    last_seen_at: datetime

    class Config:
        from_attributes = True


class ProjectPresenceResponse(BaseModel):
    """Response with all active viewers for a project."""

    project_id: int
    viewers: list[PresenceUser]


class MultiProjectPresenceResponse(BaseModel):
    """Response with presence for multiple projects."""

    presence: dict[int, list[PresenceUser]]  # project_id -> viewers


class ConflictCheckResponse(BaseModel):
    """Response for conflict check before saving."""

    has_conflict: bool
    message: str | None = None
    last_modified_at: datetime | None = None
    last_modified_by: str | None = None
    active_editors: list[PresenceUser] = []


# ============================================================================
# Helper Functions
# ============================================================================


async def cleanup_stale_presence(db: AsyncSession) -> None:
    """Remove presence records older than timeout."""
    cutoff = datetime.utcnow() - timedelta(seconds=PRESENCE_TIMEOUT_SECONDS)
    await db.execute(delete(ProjectPresence).where(ProjectPresence.last_seen_at < cutoff))


async def get_active_presence(
    db: AsyncSession, project_id: int, exclude_user_id: int | None = None
) -> list[ProjectPresence]:
    """Get active presence records for a project."""
    cutoff = datetime.utcnow() - timedelta(seconds=PRESENCE_TIMEOUT_SECONDS)

    query = (
        select(ProjectPresence)
        .options(selectinload(ProjectPresence.user))
        .where(
            and_(ProjectPresence.project_id == project_id, ProjectPresence.last_seen_at >= cutoff)
        )
    )

    if exclude_user_id:
        query = query.where(ProjectPresence.user_id != exclude_user_id)

    result = await db.execute(query)
    return list(result.scalars().all())


# ============================================================================
# Endpoints
# ============================================================================


@router.post("/presence/heartbeat")
async def send_heartbeat(
    data: PresenceHeartbeat,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_user),
):
    """
    Send a heartbeat to maintain presence on a project.

    Frontend should call this every 30 seconds while viewing a project.
    """
    # Clean up stale records periodically
    await cleanup_stale_presence(db)

    # Find existing presence record
    result = await db.execute(
        select(ProjectPresence).where(
            and_(ProjectPresence.project_id == data.project_id, ProjectPresence.user_id == user.id)
        )
    )
    presence = result.scalar_one_or_none()

    if presence:
        # Update existing
        presence.activity = data.activity
        presence.last_seen_at = datetime.utcnow()
    else:
        # Create new
        presence = ProjectPresence(
            project_id=data.project_id,
            user_id=user.id,
            activity=data.activity,
            started_at=datetime.utcnow(),
            last_seen_at=datetime.utcnow(),
        )
        db.add(presence)

    await db.commit()

    # Return current viewers (excluding self)
    viewers = await get_active_presence(db, data.project_id, exclude_user_id=user.id)

    return {
        "success": True,
        "viewers": [
            {
                "user_id": v.user_id,
                "first_name": v.user.first_name,
                "last_name": v.user.last_name,
                "activity": v.activity,
                "started_at": v.started_at.isoformat() + "Z",
                "last_seen_at": v.last_seen_at.isoformat() + "Z",
            }
            for v in viewers
        ],
    }


@router.delete("/presence/{project_id}")
async def leave_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_user),
):
    """
    Remove presence when leaving a project view.

    Frontend should call this when navigating away from a project.
    """
    await db.execute(
        delete(ProjectPresence).where(
            and_(ProjectPresence.project_id == project_id, ProjectPresence.user_id == user.id)
        )
    )
    await db.commit()

    return {"success": True}


@router.get("/presence/project/{project_id}")
async def get_project_presence(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_user),
) -> ProjectPresenceResponse:
    """
    Get all active viewers for a specific project.
    """
    viewers = await get_active_presence(db, project_id)

    return ProjectPresenceResponse(
        project_id=project_id,
        viewers=[
            PresenceUser(
                user_id=v.user_id,
                first_name=v.user.first_name,
                last_name=v.user.last_name,
                activity=v.activity,
                started_at=v.started_at,
                last_seen_at=v.last_seen_at,
            )
            for v in viewers
        ],
    )


@router.get("/presence/site/{site_id}")
async def get_site_presence(
    site_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_user),
) -> MultiProjectPresenceResponse:
    """
    Get presence for all projects in a site.

    Returns a map of project_id -> list of viewers.
    Useful for showing presence indicators in project list.
    """
    cutoff = datetime.utcnow() - timedelta(seconds=PRESENCE_TIMEOUT_SECONDS)

    # Get all active presence records for projects in this site
    result = await db.execute(
        select(ProjectPresence)
        .options(selectinload(ProjectPresence.user))
        .join(Project)
        .where(and_(Project.site_id == site_id, ProjectPresence.last_seen_at >= cutoff))
    )

    presence_records = result.scalars().all()

    # Group by project
    presence_map: dict[int, list[PresenceUser]] = {}
    for p in presence_records:
        if p.project_id not in presence_map:
            presence_map[p.project_id] = []
        presence_map[p.project_id].append(
            PresenceUser(
                user_id=p.user_id,
                first_name=p.user.first_name,
                last_name=p.user.last_name,
                activity=p.activity,
                started_at=p.started_at,
                last_seen_at=p.last_seen_at,
            )
        )

    return MultiProjectPresenceResponse(presence=presence_map)


@router.post("/presence/check-conflict/{project_id}")
async def check_conflict(
    project_id: int,
    expected_updated_at: datetime | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_user),
) -> ConflictCheckResponse:
    """
    Check if there's a conflict before saving.

    - Compares expected_updated_at with actual project.updated_at
    - Returns list of other users currently editing

    Frontend should call this before saving changes.
    """
    # Get project
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check for timestamp conflict
    has_conflict = False
    message = None

    if expected_updated_at:
        # Allow 1 second tolerance for timestamp comparison
        time_diff = abs((project.updated_at - expected_updated_at).total_seconds())
        if time_diff > 1:
            has_conflict = True
            message = "This project has been modified since you loaded it."

    # Get other editors
    editors = await get_active_presence(db, project_id, exclude_user_id=user.id)
    active_editors = [
        PresenceUser(
            user_id=e.user_id,
            first_name=e.user.first_name,
            last_name=e.user.last_name,
            activity=e.activity,
            started_at=e.started_at,
            last_seen_at=e.last_seen_at,
        )
        for e in editors
        if e.activity == "editing"
    ]

    if active_editors and not has_conflict:
        message = f"{active_editors[0].first_name} {active_editors[0].last_name} is currently editing this project."

    return ConflictCheckResponse(
        has_conflict=has_conflict,
        message=message,
        last_modified_at=project.updated_at,
        active_editors=active_editors,
    )
