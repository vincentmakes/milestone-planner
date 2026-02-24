"""
Users API router.
Handles user management operations (admin functions).

Matches the Node.js API at /api/users exactly.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.middleware.auth import require_admin, require_superuser
from app.models.site import Site
from app.models.skill import Skill, UserSkill
from app.models.user import User, UserSite
from app.schemas.user import (
    StaffCreate,
    StaffUpdate,
    UserDetailResponse,
    UserResponse,
)
from app.services.encryption import hash_user_password

router = APIRouter()


def build_user_list_response(user: User) -> dict:
    """Build user response for list view (includes job_title, skills, and site_names)."""
    sites = user.sites if hasattr(user, "sites") and user.sites else []
    # Sort by site ID to match Node.js behavior
    sorted_sites = sorted(sites, key=lambda s: s.id)

    # Build skills list
    skills = []
    if hasattr(user, "skills") and user.skills:
        skills = [
            {"id": skill.id, "name": skill.name, "color": skill.color} for skill in user.skills
        ]

    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "job_title": user.job_title,
        "role": user.role,
        "max_capacity": user.max_capacity if hasattr(user, "max_capacity") else 100,
        "active": user.active,
        "is_system": user.is_system if user.is_system is not None else 0,
        "created_at": user.created_at,
        "site_ids": [s.id for s in sorted_sites],
        "site_names": [s.name for s in sorted_sites],
        "skills": skills,
    }


def build_user_detail_response(user: User) -> dict:
    """Build user response for detail view (has sites array, no site_names)."""
    sites = user.sites if hasattr(user, "sites") and user.sites else []

    # Build skills list
    skills = []
    if hasattr(user, "skills") and user.skills:
        skills = [
            {"id": skill.id, "name": skill.name, "color": skill.color} for skill in user.skills
        ]

    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "job_title": user.job_title,
        "role": user.role,
        "max_capacity": user.max_capacity if hasattr(user, "max_capacity") else 100,
        "active": user.active,
        "is_system": user.is_system if user.is_system is not None else 0,
        "created_at": user.created_at,
        "site_ids": [s.id for s in sites],
        "sites": [{"id": s.id, "name": s.name} for s in sites],
        "skills": skills,
    }


@router.get("/users", response_model=list[UserResponse])
async def get_users(
    include_disabled: bool = Query(False, alias="includeDisabled"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Get all users.

    Requires admin or superuser authentication.
    Matches: GET /api/users
    """
    query = (
        select(User)
        .options(selectinload(User.sites))
        .options(selectinload(User.skills))
        .order_by(User.last_name, User.first_name)
    )

    if not include_disabled:
        query = query.where(User.active == 1)

    result = await db.execute(query)
    users = result.unique().scalars().all()

    return [build_user_list_response(u) for u in users]


@router.get("/users/{user_id}", response_model=UserDetailResponse)
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Get a specific user by ID.

    Requires admin authentication.
    Matches: GET /api/users/:id
    """
    result = await db.execute(
        select(User)
        .where(User.id == user_id)
        .options(selectinload(User.sites))
        .options(selectinload(User.skills))
    )
    user = result.unique().scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return build_user_detail_response(user)


@router.post("/users", response_model=UserResponse, status_code=201)
async def create_user(
    data: StaffCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Create a new user.

    Requires admin authentication.
    Matches: POST /api/users
    """
    # Check for existing email
    existing = await db.execute(select(User).where(User.email == data.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="A user with this email already exists")

    # Create user
    user = User(
        email=data.email,
        password=hash_user_password(data.password),
        first_name=data.first_name,
        last_name=data.last_name,
        job_title=data.job_title,
        role=data.role,
        max_capacity=data.max_capacity,
        active=1,
    )

    db.add(user)
    await db.flush()  # Get the user ID

    # Add site associations
    sites = []
    if data.site_ids:
        for site_id in data.site_ids:
            user_site = UserSite(user_id=user.id, site_id=site_id)
            db.add(user_site)

            # Fetch site for response
            site_result = await db.execute(select(Site).where(Site.id == site_id))
            site = site_result.scalar_one_or_none()
            if site:
                sites.append(site)

    # Add skill associations
    skills = []
    if hasattr(data, "skill_ids") and data.skill_ids:
        for skill_id in data.skill_ids:
            user_skill = UserSkill(user_id=user.id, skill_id=skill_id)
            db.add(user_skill)

            # Fetch skill for response
            skill_result = await db.execute(select(Skill).where(Skill.id == skill_id))
            skill = skill_result.scalar_one_or_none()
            if skill:
                skills.append(skill)

    await db.commit()
    await db.refresh(user)
    user.sites = sites
    user.skills = skills

    return build_user_list_response(user)


@router.put("/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    data: StaffUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_superuser),
):
    """
    Update a user.

    Requires admin or superuser authentication.
    Superusers can only:
    - Assign sites they themselves have access to
    - Assign skills to users
    - Update basic info (name, job_title) but NOT role or active status
    Matches: PUT /api/users/:id
    """
    result = await db.execute(
        select(User)
        .where(User.id == user_id)
        .options(selectinload(User.sites))
        .options(selectinload(User.skills))
    )
    user = result.unique().scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    is_admin = current_user.role == "admin"

    # Superusers cannot change role or active status
    if not is_admin:
        if data.role is not None:
            raise HTTPException(status_code=403, detail="Only administrators can change user roles")
        if data.active is not None:
            raise HTTPException(
                status_code=403, detail="Only administrators can change user active status"
            )

    # Protect system users from role/active changes
    if user.is_system_user:
        if data.role is not None and data.role != "admin":
            raise HTTPException(
                status_code=403, detail="Cannot change role of system administrator"
            )
        if data.active is not None and data.active == 0:
            raise HTTPException(status_code=403, detail="Cannot deactivate system administrator")

    # Prevent admin from demoting themselves
    if is_admin and user.id == current_user.id and data.role and data.role != "admin":
        raise HTTPException(status_code=400, detail="Cannot change your own admin role")

    # Prevent admin from deactivating themselves
    if is_admin and user.id == current_user.id and data.active is not None and data.active == 0:
        raise HTTPException(status_code=400, detail="Cannot deactivate your own account")

    # Update fields
    if data.email is not None:
        # Check for duplicate email
        existing = await db.execute(
            select(User).where(User.email == data.email).where(User.id != user_id)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="A user with this email already exists")
        user.email = data.email

    if data.password is not None:
        user.password = hash_user_password(data.password)
    if data.first_name is not None:
        user.first_name = data.first_name
    if data.last_name is not None:
        user.last_name = data.last_name
    if data.job_title is not None:
        user.job_title = data.job_title
    if data.role is not None:
        user.role = data.role
    if data.max_capacity is not None:
        user.max_capacity = data.max_capacity
    if data.active is not None:
        user.active = data.active

    # Update site associations if provided
    sites = list(user.sites) if user.sites else []
    if data.site_ids is not None:
        # Superusers can only assign sites they have access to
        if not is_admin:
            current_user_site_ids = [s.id for s in current_user.sites] if current_user.sites else []
            for site_id in data.site_ids:
                if site_id not in current_user_site_ids:
                    raise HTTPException(
                        status_code=403,
                        detail=f"You can only assign sites you have access to (site {site_id} not allowed)",
                    )

        # Remove existing associations
        await db.execute(delete(UserSite).where(UserSite.user_id == user_id))

        # Add new associations
        sites = []
        for site_id in data.site_ids:
            user_site = UserSite(user_id=user_id, site_id=site_id)
            db.add(user_site)

            # Fetch site for response
            site_result = await db.execute(select(Site).where(Site.id == site_id))
            site = site_result.scalar_one_or_none()
            if site:
                sites.append(site)

    # Update skill associations if provided
    skills = list(user.skills) if user.skills else []
    if hasattr(data, "skill_ids") and data.skill_ids is not None:
        # Remove existing skill associations
        await db.execute(delete(UserSkill).where(UserSkill.user_id == user_id))

        # Add new skill associations
        skills = []
        for skill_id in data.skill_ids:
            user_skill = UserSkill(user_id=user_id, skill_id=skill_id)
            db.add(user_skill)

            # Fetch skill for response
            skill_result = await db.execute(select(Skill).where(Skill.id == skill_id))
            skill = skill_result.scalar_one_or_none()
            if skill:
                skills.append(skill)

    await db.commit()
    await db.refresh(user)
    user.sites = sites
    user.skills = skills

    return build_user_list_response(user)


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Delete a user.

    Requires admin authentication.
    Matches: DELETE /api/users/:id
    """
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Protect system users (created via master admin panel)
    if user.is_system_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot delete system administrator. This account was created during tenant provisioning.",
        )

    # Delete site associations first
    await db.execute(delete(UserSite).where(UserSite.user_id == user_id))

    # Delete user
    await db.delete(user)
    await db.commit()

    return {"success": True}


@router.put("/users/{user_id}/toggle-active")
async def toggle_user_active(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """
    Toggle a user's active status.

    Requires admin authentication.
    Matches: PUT /api/users/:id/toggle-active
    """
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot deactivate your own account")

    result = await db.execute(
        select(User).where(User.id == user_id).options(selectinload(User.sites))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Toggle active status
    user.active = 0 if user.active == 1 else 1

    await db.commit()
    await db.refresh(user)

    return build_user_list_response(user)
