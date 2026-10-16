"""
Users API router.
Handles user management operations (admin functions).

Matches the Node.js API at /api/users exactly.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.middleware.auth import get_session_id, require_admin, require_superuser
from app.models.site import Site
from app.models.skill import Skill, UserSkill
from app.models.user import User, UserSite
from app.schemas.base import PaginationParams
from app.schemas.user import (
    StaffCreate,
    StaffUpdate,
    UserDetailResponse,
    UserResponse,
)
from app.services.encryption import PasswordTooLongError, hash_user_password
from app.services.response_builders import build_skills_list, build_user_base, get_sorted_sites
from app.services.session import SessionService

router = APIRouter()


def _hash_password_or_400(password: str) -> str:
    """bcrypt-hash a password, turning bcrypt's 72-byte limit into a 400."""
    try:
        return hash_user_password(password)
    except PasswordTooLongError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


def _unique(ids: list[int]) -> list[int]:
    """De-duplicate, keeping the caller's order (a repeat would hit the PK)."""
    return list(dict.fromkeys(ids))


async def _load_sites(db: AsyncSession, site_ids: list[int] | None) -> list[Site]:
    """The sites for ``site_ids`` in request order; 400 naming unknown ids."""
    wanted = _unique(site_ids or [])
    if not wanted:
        return []
    found = {s.id: s for s in (await db.execute(select(Site).where(Site.id.in_(wanted)))).scalars()}
    missing = [i for i in wanted if i not in found]
    if missing:
        raise HTTPException(
            status_code=400, detail=f"Unknown site: {', '.join(str(i) for i in missing)}"
        )
    return [found[i] for i in wanted]


async def _load_skills(db: AsyncSession, skill_ids: list[int] | None) -> list[Skill]:
    """The skills for ``skill_ids`` in request order; 400 naming unknown ids."""
    wanted = _unique(skill_ids or [])
    if not wanted:
        return []
    found = {
        s.id: s for s in (await db.execute(select(Skill).where(Skill.id.in_(wanted)))).scalars()
    }
    missing = [i for i in wanted if i not in found]
    if missing:
        raise HTTPException(
            status_code=400, detail=f"Unknown skill: {', '.join(str(i) for i in missing)}"
        )
    return [found[i] for i in wanted]


def build_user_list_response(user: User) -> dict:
    """Build user response for list view (includes job_title, skills, and site_names)."""
    sorted_sites = get_sorted_sites(user)
    return {
        **build_user_base(user),
        "is_system": user.is_system if user.is_system is not None else 0,
        "created_at": user.created_at,
        "site_ids": [s.id for s in sorted_sites],
        "site_names": [s.name for s in sorted_sites],
        "skills": build_skills_list(user),
    }


def build_user_detail_response(user: User) -> dict:
    """Build user response for detail view (has sites array, no site_names)."""
    sorted_sites = get_sorted_sites(user)
    return {
        **build_user_base(user),
        "is_system": user.is_system if user.is_system is not None else 0,
        "created_at": user.created_at,
        "site_ids": [s.id for s in sorted_sites],
        "sites": [{"id": s.id, "name": s.name} for s in sorted_sites],
        "skills": build_skills_list(user),
    }


@router.get("/users")
async def get_users(
    include_disabled: bool = Query(False, alias="includeDisabled"),
    pagination: PaginationParams = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Get all users with pagination.

    Requires admin or superuser authentication.
    Matches: GET /api/users
    """
    base_query = select(User)

    if not include_disabled:
        base_query = base_query.where(User.active == 1)

    # Get total count
    count_result = await db.execute(select(func.count()).select_from(base_query.subquery()))
    total = count_result.scalar() or 0

    # Paginated query
    query = (
        base_query.options(selectinload(User.sites))
        .options(selectinload(User.skills))
        .order_by(User.last_name, User.first_name)
        .offset(pagination.offset)
        .limit(pagination.limit)
    )

    result = await db.execute(query)
    users = result.unique().scalars().all()

    return {
        "items": [build_user_list_response(u) for u in users],
        "total": total,
        "offset": pagination.offset,
        "limit": pagination.limit,
    }


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
        password=_hash_password_or_400(data.password),
        first_name=data.first_name,
        last_name=data.last_name,
        job_title=data.job_title,
        role=data.role,
        max_capacity=data.max_capacity,
        active=1,
    )

    # Unknown sites/skills are a 400 before anything is written (they used to
    # end in an FK violation -> 500 at commit).
    sites = await _load_sites(db, data.site_ids)
    skills = await _load_skills(db, data.skill_ids)

    db.add(user)
    await db.flush()  # Get the user ID

    for site in sites:
        db.add(UserSite(user_id=user.id, site_id=site.id))
    for skill in skills:
        db.add(UserSkill(user_id=user.id, skill_id=skill.id))

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
    session_id: str | None = Depends(get_session_id),
):
    """
    Update a user.

    Requires admin or superuser authentication.
    Superusers can only:
    - Assign sites they themselves have access to
    - Assign skills to users
    - Update basic info (name, job_title, capacity) but NOT role or active status
    - Change email/password on their OWN account only
    and cannot modify an admin account at all (no superuser -> admin takeover).

    A role change, deactivation or password change destroys the target's
    existing sessions (except the caller's own current session).
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

    # Superusers cannot touch admin accounts, nor change role or active status
    if not is_admin:
        if user.role == "admin":
            raise HTTPException(
                status_code=403, detail="Only administrators can modify administrator accounts"
            )
        if user.id != current_user.id:
            # The settings form re-sends the unchanged email, so only an actual
            # change is refused.
            email_changed = (
                data.email is not None and data.email.lower() != (user.email or "").lower()
            )
            if email_changed or data.password is not None:
                raise HTTPException(
                    status_code=403,
                    detail="Only administrators can change another user's email or password",
                )
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

    # Changes that must end the target's existing logins (see B1-1): the
    # session snapshot would otherwise keep the old role/credentials alive.
    role_changed = data.role is not None and data.role != user.role
    deactivated = data.active is not None and data.active == 0 and user.active != 0
    password_changed = data.password is not None
    new_password_hash = _hash_password_or_400(data.password) if data.password is not None else None

    # A superuser's re-sent (unchanged) email for someone else is ignored
    may_set_email = is_admin or user.id == current_user.id

    # Update fields
    if data.email is not None and may_set_email:
        # Check for duplicate email
        existing = await db.execute(
            select(User).where(User.email == data.email).where(User.id != user_id)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="A user with this email already exists")
        user.email = data.email

    if new_password_hash is not None:
        user.password = new_password_hash
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

        sites = await _load_sites(db, data.site_ids)

        # Replace existing associations
        await db.execute(delete(UserSite).where(UserSite.user_id == user_id))
        for site in sites:
            db.add(UserSite(user_id=user_id, site_id=site.id))

    # Update skill associations if provided
    skills = list(user.skills) if user.skills else []
    if data.skill_ids is not None:
        skills = await _load_skills(db, data.skill_ids)

        # Replace existing skill associations
        await db.execute(delete(UserSkill).where(UserSkill.user_id == user_id))
        for skill in skills:
            db.add(UserSkill(user_id=user_id, skill_id=skill.id))

    if role_changed or deactivated or password_changed:
        await SessionService(db).destroy_user_sessions(
            user_id, except_session_id=session_id, commit=False
        )

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

    # End any live logins of the deleted user
    await SessionService(db).destroy_user_sessions(user_id, commit=False)

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

    # Same protection as PUT /users/{id}: the provisioned admin cannot be disabled
    if user.is_system_user and user.active == 1:
        raise HTTPException(status_code=403, detail="Cannot deactivate system administrator")

    # Toggle active status
    user.active = 0 if user.active == 1 else 1

    if user.active == 0:
        # A deactivated user's existing sessions must stop working now
        await SessionService(db).destroy_user_sessions(user_id, commit=False)

    await db.commit()
    await db.refresh(user)

    return build_user_list_response(user)
