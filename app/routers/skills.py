"""
Skills API endpoints.
Skills are global (shared across all sites) and can be assigned to staff members.
Definitions need ``skills.manage``; setting a user's skills needs
``skills.assign`` and the right to edit that user (``users.edit``, or
``users.edit_admins`` for an administrator), who must be oneself or a member
of one of the caller's visible sites.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import require_permission
from app.models.skill import Skill, UserSkill
from app.models.user import User
from app.routers.auth import get_current_user
from app.schemas.skill import (
    SkillCreate,
    SkillListResponse,
    SkillResponse,
    SkillUpdate,
    UserSkillAssignment,
    UserSkillResponse,
)
from app.services.site_access import ensure_person_visible
from app.services.user_access import USER_OUTSIDE_SITES_DETAIL, ensure_may_edit_user

router = APIRouter(prefix="/skills", tags=["skills"])


async def _ensure_target_visible(
    request: Request, db: AsyncSession, current_user: User, user_id: int
) -> None:
    """403 unless the target is oneself or a member of one of the caller's visible sites."""
    await ensure_person_visible(
        request, db, current_user, user_id, status_code=403, detail=USER_OUTSIDE_SITES_DETAIL
    )


# =============================================================================
# SKILL CRUD
# =============================================================================


@router.get("", response_model=list[SkillListResponse])
async def get_skills(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get all skills (available to all authenticated users)."""
    result = await db.execute(select(Skill).order_by(Skill.name))
    skills = result.scalars().all()
    return skills


@router.get("/{skill_id}", response_model=SkillResponse)
async def get_skill(
    skill_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single skill by ID."""
    result = await db.execute(select(Skill).where(Skill.id == skill_id))
    skill = result.scalar_one_or_none()

    if not skill:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found")

    return skill


@router.post("", response_model=SkillResponse, status_code=status.HTTP_201_CREATED)
async def create_skill(
    skill_data: SkillCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("skills.manage")),
):
    """Create a new skill (``skills.manage``)."""
    # Check for duplicate name
    result = await db.execute(select(Skill).where(Skill.name == skill_data.name))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="A skill with this name already exists"
        )

    skill = Skill(
        name=skill_data.name,
        description=skill_data.description,
        color=skill_data.color,
    )
    db.add(skill)
    await db.commit()
    await db.refresh(skill)

    return skill


@router.put("/{skill_id}", response_model=SkillResponse)
async def update_skill(
    skill_id: int,
    skill_data: SkillUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("skills.manage")),
):
    """Update a skill (``skills.manage``)."""
    result = await db.execute(select(Skill).where(Skill.id == skill_id))
    skill = result.scalar_one_or_none()

    if not skill:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found")

    # Check for duplicate name if name is being changed
    if skill_data.name and skill_data.name != skill.name:
        result = await db.execute(select(Skill).where(Skill.name == skill_data.name))
        if result.scalar_one_or_none():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A skill with this name already exists",
            )

    # Update fields
    update_data = skill_data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(skill, key, value)

    await db.commit()
    await db.refresh(skill)

    return skill


@router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(
    skill_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("skills.manage")),
):
    """Delete a skill (``skills.manage``)."""
    result = await db.execute(select(Skill).where(Skill.id == skill_id))
    skill = result.scalar_one_or_none()

    if not skill:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found")

    await db.delete(skill)
    await db.commit()

    return None


# =============================================================================
# USER SKILL ASSIGNMENTS
# =============================================================================


@router.get("/user/{user_id}", response_model=list[UserSkillResponse])
async def get_user_skills(
    user_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get all skills assigned to a user: oneself or a member of a visible site (404 otherwise)."""
    await ensure_person_visible(
        request, db, current_user, user_id, status_code=404, detail="User not found"
    )
    # Verify user exists
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Get user skills with proficiency
    result = await db.execute(
        select(Skill, UserSkill.proficiency)
        .join(UserSkill, Skill.id == UserSkill.skill_id)
        .where(UserSkill.user_id == user_id)
        .order_by(Skill.name)
    )
    rows = result.all()

    return [
        UserSkillResponse(id=skill.id, name=skill.name, color=skill.color, proficiency=proficiency)
        for skill, proficiency in rows
    ]


@router.put("/user/{user_id}", response_model=list[UserSkillResponse])
async def update_user_skills(
    user_id: int,
    assignment: UserSkillAssignment,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("skills.assign")),
):
    """
    Update skills assigned to a user (``skills.assign`` on a user the caller
    may edit). This replaces all existing skill assignments with the provided
    list.
    """
    # Verify user exists
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_may_edit_user(current_user, user.role)
    await _ensure_target_visible(request, db, current_user, user_id)

    # Verify all skill IDs exist
    if assignment.skill_ids:
        result = await db.execute(select(Skill).where(Skill.id.in_(assignment.skill_ids)))
        found_skills = result.scalars().all()
        found_ids = {s.id for s in found_skills}
        missing_ids = set(assignment.skill_ids) - found_ids

        if missing_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Skills not found: {list(missing_ids)}",
            )

    # Delete existing assignments
    await db.execute(delete(UserSkill).where(UserSkill.user_id == user_id))

    # Create new assignments (a repeated id would violate the primary key)
    for skill_id in dict.fromkeys(assignment.skill_ids):
        user_skill = UserSkill(
            user_id=user_id,
            skill_id=skill_id,
            proficiency=3,  # Default proficiency
        )
        db.add(user_skill)

    await db.commit()

    # Return updated skills
    return await get_user_skills(user_id, request, db, current_user)


@router.post("/user/{user_id}/{skill_id}", response_model=list[UserSkillResponse])
async def add_user_skill(
    user_id: int,
    skill_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("skills.assign")),
):
    """Add a single skill to a user (``skills.assign`` on a user the caller may edit)."""
    # Verify user exists
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    ensure_may_edit_user(current_user, user.role)
    await _ensure_target_visible(request, db, current_user, user_id)

    # Verify skill exists
    result = await db.execute(select(Skill).where(Skill.id == skill_id))
    skill = result.scalar_one_or_none()

    if not skill:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found")

    # Check if already assigned
    result = await db.execute(
        select(UserSkill).where(UserSkill.user_id == user_id, UserSkill.skill_id == skill_id)
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Skill already assigned to user"
        )

    # Create assignment
    user_skill = UserSkill(
        user_id=user_id,
        skill_id=skill_id,
        proficiency=3,
    )
    db.add(user_skill)
    await db.commit()

    return await get_user_skills(user_id, request, db, current_user)


@router.delete("/user/{user_id}/{skill_id}", response_model=list[UserSkillResponse])
async def remove_user_skill(
    user_id: int,
    skill_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("skills.assign")),
):
    """Remove a single skill from a user (``skills.assign`` on a user the caller may edit)."""
    permissions = current_user.permissions
    if not (permissions.has("users.edit") and permissions.has("users.edit_admins")):
        # The target's role decides which edit key applies (404 if unknown).
        role = (await db.execute(select(User.role).where(User.id == user_id))).scalar_one_or_none()
        if role is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        ensure_may_edit_user(current_user, role)
    await _ensure_target_visible(request, db, current_user, user_id)

    # Delete the assignment
    result = await db.execute(
        delete(UserSkill).where(UserSkill.user_id == user_id, UserSkill.skill_id == skill_id)
    )

    if result.rowcount == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Skill assignment not found"
        )

    await db.commit()

    return await get_user_skills(user_id, request, db, current_user)
