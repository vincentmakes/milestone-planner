"""
Users API router.
Handles user management operations, gated on the ``users.*`` keys; the
account rules (edit target, escalation guard, last active admin) live in
app/services/user_access.py.

Matches the Node.js API at /api/users exactly.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.middleware.auth import (
    get_session_id,
    require_any_permission,
    require_permission,
)
from app.models.rbac import Role
from app.models.site import Site
from app.models.skill import Skill, UserSkill
from app.models.team import TeamMember
from app.models.user import User, UserSite
from app.schemas.base import PaginationParams
from app.schemas.user import (
    StaffCreate,
    StaffUpdate,
    UserDetailResponse,
    UserResponse,
)
from app.services import approvals
from app.services.encryption import PasswordTooLongError, hash_user_password
from app.services.permissions import (
    ADMIN_ROLE_KEY,
    DEFAULT_ROLE_KEY,
    SYSTEM_ROLE_KEYS,
    permission_required_detail,
    role_display_name,
)
from app.services.response_builders import (
    build_skills_list,
    build_user_base,
    get_sorted_sites,
    get_sorted_teams,
)
from app.services.session import SessionService
from app.services.site_access import (
    ensure_person_visible,
    ensure_site_access,
    person_is_visible,
    visible_site_ids,
    visible_sites_clause,
)
from app.services.team_rules import (
    TEAM_SITE_ACCESS_DETAIL,
    ensure_teams_within_sites,
    load_teams,
    prune_teams_to_sites,
    team_outside_user_sites_detail,
)
from app.services.user_access import (
    USER_OUTSIDE_SITES_DETAIL,
    ensure_may_assign_role,
    ensure_may_change_role_of,
    ensure_may_edit_user,
    ensure_not_last_active_admin,
)

router = APIRouter()


def _hash_password_or_400(password: str) -> str:
    """bcrypt-hash a password, turning bcrypt's 72-byte limit into a 400."""
    try:
        return hash_user_password(password)
    except PasswordTooLongError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


ROLE_NOT_FOUND_DETAIL = "Role not found"


async def _ensure_role_exists(db: AsyncSession, role_key: str) -> None:
    """404 unless ``role_key`` is a role (the system roles always exist: no query)."""
    if role_key in SYSTEM_ROLE_KEYS:
        return
    found = await db.execute(select(Role.key).where(Role.key == role_key))
    if found.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail=ROLE_NOT_FOUND_DETAIL)


USER_NOT_FOUND_DETAIL = "User not found"


async def _ensure_target_visible(
    request: Request, db: AsyncSession, current_user: User, user_id: int
) -> None:
    """403 unless the target is oneself or a member of one of the caller's visible sites."""
    await ensure_person_visible(
        request, db, current_user, user_id, status_code=403, detail=USER_OUTSIDE_SITES_DETAIL
    )


def _forbidden(key: str) -> HTTPException:
    return HTTPException(status_code=403, detail=permission_required_detail(key))


async def _ensure_sites_visible(
    request: Request, db: AsyncSession, current_user: User, site_ids: list[int]
) -> None:
    """403 naming the first site the caller may not assign (outside their visible sites)."""
    visible = await visible_site_ids(request, db, current_user)
    if visible is None:
        return
    for site_id in site_ids:
        if site_id not in visible:
            raise HTTPException(
                status_code=403,
                detail=f"You can only assign sites you have access to (site {site_id} not allowed)",
            )


# Any of these reaches PUT /users/{id}; the handler checks each change.
_UPDATE_KEYS = (
    "users.edit",
    "users.edit_admins",
    "users.edit_credentials",
    "users.change_role",
    "users.toggle_active",
)


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
    sorted_teams = get_sorted_teams(user)
    return {
        **build_user_base(user),
        "role_name": role_display_name(user.role, user.role_name),
        "is_system": user.is_system if user.is_system is not None else 0,
        "created_at": user.created_at,
        "site_ids": [s.id for s in sorted_sites],
        "site_names": [s.name for s in sorted_sites],
        "skills": build_skills_list(user),
        "team_ids": [t.id for t in sorted_teams],
        "team_names": [t.name for t in sorted_teams],
    }


def build_user_detail_response(user: User) -> dict:
    """Build user response for detail view (has sites array, no site_names)."""
    sorted_sites = get_sorted_sites(user)
    sorted_teams = get_sorted_teams(user)
    return {
        **build_user_base(user),
        "role_name": role_display_name(user.role, user.role_name),
        "is_system": user.is_system if user.is_system is not None else 0,
        "created_at": user.created_at,
        "site_ids": [s.id for s in sorted_sites],
        "sites": [{"id": s.id, "name": s.name} for s in sorted_sites],
        "skills": build_skills_list(user),
        "team_ids": [t.id for t in sorted_teams],
        "team_names": [t.name for t in sorted_teams],
    }


@router.get("/users")
async def get_users(
    request: Request,
    include_disabled: bool = Query(False, alias="includeDisabled"),
    pagination: PaginationParams = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("users.view")),
):
    """
    Get users with pagination: oneself and the members of the caller's
    visible sites (everyone with ``sites.view_all``).

    Requires ``users.view``.
    Matches: GET /api/users
    """
    base_query = select(User)

    if not include_disabled:
        base_query = base_query.where(User.active == 1)

    in_visible = visible_sites_clause(UserSite.site_id, await visible_site_ids(request, db, user))
    if in_visible is not None:
        base_query = base_query.where(
            or_(User.id == user.id, User.id.in_(select(UserSite.user_id).where(in_visible)))
        )

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
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("users.view")),
):
    """
    Get a specific user by ID: oneself or a member of a visible site (404
    otherwise).

    Requires ``users.view``.
    Matches: GET /api/users/:id
    """
    if not await person_is_visible(request, db, user, user_id):
        raise HTTPException(status_code=404, detail=USER_NOT_FOUND_DETAIL)
    result = await db.execute(
        select(User)
        .where(User.id == user_id)
        .options(selectinload(User.sites))
        .options(selectinload(User.skills))
    )
    user = result.unique().scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail=USER_NOT_FOUND_DETAIL)

    return build_user_detail_response(user)


@router.post("/users", response_model=UserResponse, status_code=201)
async def create_user(
    data: StaffCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_permission("users.create")),
):
    """
    Create a new user.

    Requires ``users.create``, which alone creates an account with the default
    ``user`` role; any other role also needs ``users.change_role`` and passes
    the escalation guard. Sites and teams must be at the caller's visible sites.
    Matches: POST /api/users
    """
    assigns_role = data.role != DEFAULT_ROLE_KEY
    if assigns_role and not admin.permissions.has("users.change_role"):
        raise _forbidden("users.change_role")

    # Check for existing email
    existing = await db.execute(select(User).where(User.email == data.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="A user with this email already exists")
    await _ensure_role_exists(db, data.role)
    if assigns_role:
        await ensure_may_assign_role(db, admin, data.role)
    await _ensure_sites_visible(request, db, admin, _unique(data.site_ids or []))

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
    # Unknown teams are a 404; a team must be at one of the user's sites (400).
    teams = await load_teams(db, data.team_ids)
    await ensure_site_access(
        request, db, admin, {t.site_id for t in teams}, TEAM_SITE_ACCESS_DETAIL
    )
    ensure_teams_within_sites(teams, [s.id for s in sites], team_outside_user_sites_detail)

    db.add(user)
    await db.flush()  # Get the user ID

    for site in sites:
        db.add(UserSite(user_id=user.id, site_id=site.id))
    for skill in skills:
        db.add(UserSkill(user_id=user.id, skill_id=skill.id))
    for team in teams:
        db.add(TeamMember(team_id=team.id, user_id=user.id))

    await db.commit()
    await db.refresh(user)
    user.sites = sites
    user.skills = skills
    user.teams = teams

    return build_user_list_response(user)


@router.put("/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    data: StaffUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_any_permission(*_UPDATE_KEYS)),
    session_id: str | None = Depends(get_session_id),
):
    """
    Update a user. Each kind of change needs its key:

    - name, job title, capacity, sites, teams, skills: ``users.edit`` (sites
      and teams within the caller's visible sites);
    - an account holding the admin role at all: ``users.edit_admins``;
    - another user's email or password: ``users.edit_credentials`` (one's own:
      always);
    - the role: ``users.change_role`` plus the escalation guard;
    - ``active``: ``users.toggle_active``.

    Nobody changes their own role or deactivates themself (400), the system
    administrator keeps the admin role and stays active (403), and the last
    active administrator cannot be demoted or deactivated (400).

    A role change, deactivation or password change destroys the target's
    existing sessions (except the caller's own current session).
    Matches: PUT /api/users/:id
    """
    result = await db.execute(
        select(User)
        .where(User.id == user_id)
        .options(selectinload(User.sites))
        .options(selectinload(User.skills))
        .options(selectinload(User.teams))
    )
    user = result.unique().scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail=USER_NOT_FOUND_DETAIL)
    await _ensure_target_visible(request, db, current_user, user_id)

    permissions = current_user.permissions
    is_self = user.id == current_user.id
    target_is_admin = user.role == ADMIN_ROLE_KEY

    # An administrator account needs users.edit_admins for any change.
    if target_is_admin:
        ensure_may_edit_user(current_user, user.role)

    edits_profile = any(
        value is not None
        for value in (
            data.first_name,
            data.last_name,
            data.job_title,
            data.max_capacity,
            data.site_ids,
            data.team_ids,
            data.skill_ids,
        )
    )
    if edits_profile and not target_is_admin:
        ensure_may_edit_user(current_user, user.role)

    # The settings form re-sends the unchanged email, so only an actual change
    # counts; one's own email and password are always one's own to change.
    may_set_credentials = is_self or permissions.has("users.edit_credentials")
    email_changed = data.email is not None and data.email.lower() != (user.email or "").lower()
    if not may_set_credentials and (email_changed or data.password is not None):
        raise _forbidden("users.edit_credentials")

    role_changed = data.role is not None and data.role != user.role
    if role_changed and not permissions.has("users.change_role"):
        raise _forbidden("users.change_role")
    deactivated = data.active is not None and data.active == 0 and user.active != 0
    active_changed = data.active is not None and data.active != user.active
    if active_changed and not permissions.has("users.toggle_active"):
        raise _forbidden("users.toggle_active")

    # Protect system users from role/active changes
    if user.is_system_user:
        if data.role is not None and data.role != ADMIN_ROLE_KEY:
            raise HTTPException(
                status_code=403, detail="Cannot change role of system administrator"
            )
        if data.active is not None and data.active == 0:
            raise HTTPException(status_code=403, detail="Cannot deactivate system administrator")

    # Nobody changes their own role or deactivates themself
    if is_self and role_changed:
        detail = (
            "Cannot change your own admin role"
            if target_is_admin
            else "Cannot change your own role"
        )
        raise HTTPException(status_code=400, detail=detail)
    if is_self and deactivated:
        raise HTTPException(status_code=400, detail="Cannot deactivate your own account")

    if role_changed:
        assert data.role is not None
        await _ensure_role_exists(db, data.role)
        await ensure_may_change_role_of(db, current_user, user.role)
        await ensure_may_assign_role(db, current_user, data.role)
    if (role_changed and target_is_admin) or deactivated:
        await ensure_not_last_active_admin(db, current_user, user)

    # Changes that must end the target's existing logins (see B1-1): the
    # session snapshot would otherwise keep the old role/credentials alive.
    password_changed = data.password is not None
    new_password_hash = _hash_password_or_400(data.password) if data.password is not None else None

    # Someone else's re-sent (unchanged) email is ignored without the key
    may_set_email = may_set_credentials

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
        # Only sites the caller can see (sites.view_all: any)
        await _ensure_sites_visible(request, db, current_user, data.site_ids)

        sites = await _load_sites(db, data.site_ids)

        # Replace existing associations
        await db.execute(delete(UserSite).where(UserSite.user_id == user_id))
        for site in sites:
            db.add(UserSite(user_id=user_id, site_id=site.id))

    # Replace team memberships if provided: unknown teams are a 404, teams
    # only at the caller's visible sites (403), and every team must be at one
    # of the user's (resulting) sites (400). Otherwise a site change drops the
    # user from the teams at the sites they left.
    teams = list(user.teams) if user.teams else []
    if data.team_ids is not None:
        teams = await load_teams(db, data.team_ids)
        await ensure_site_access(
            request, db, current_user, {t.site_id for t in teams}, TEAM_SITE_ACCESS_DETAIL
        )
        ensure_teams_within_sites(teams, [s.id for s in sites], team_outside_user_sites_detail)

        await db.execute(delete(TeamMember).where(TeamMember.user_id == user_id))
        for team in teams:
            db.add(TeamMember(team_id=team.id, user_id=user_id))
    elif data.site_ids is not None:
        kept = prune_teams_to_sites(teams, [s.id for s in sites])
        kept_ids = {t.id for t in kept}
        dropped = [t.id for t in teams if t.id not in kept_ids]
        if dropped:
            await db.execute(
                delete(TeamMember).where(
                    TeamMember.user_id == user_id, TeamMember.team_id.in_(dropped)
                )
            )
        teams = kept

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
    # A deactivated requester's pending approval requests expire.
    expired = (
        await approvals.expire_for_requester(db, current_user, user_id) if deactivated else None
    )

    await db.commit()
    if expired is not None:
        await approvals.publish(request, current_user, expired)
    await db.refresh(user)
    user.sites = sites
    user.skills = skills
    user.teams = teams

    return build_user_list_response(user)


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_permission("users.delete")),
):
    """
    Delete a user.

    Requires ``users.delete`` (an administrator account also
    ``users.edit_admins``); never oneself, the system administrator or the
    last active administrator.
    Matches: DELETE /api/users/:id
    """
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail=USER_NOT_FOUND_DETAIL)
    await _ensure_target_visible(request, db, admin, user_id)

    # Protect system users (created via master admin panel)
    if user.is_system_user:
        raise HTTPException(
            status_code=403,
            detail="Cannot delete system administrator. This account was created during tenant provisioning.",
        )
    if user.role == ADMIN_ROLE_KEY:
        ensure_may_edit_user(admin, user.role)
        await ensure_not_last_active_admin(db, admin, user)

    # Delete site associations first
    await db.execute(delete(UserSite).where(UserSite.user_id == user_id))

    # End any live logins of the deleted user
    await SessionService(db).destroy_user_sessions(user_id, commit=False)
    # Their pending approval requests expire (and then cascade with the user).
    expired = await approvals.expire_for_requester(db, admin, user_id, deleted=True)

    # Delete user
    await db.delete(user)
    await db.commit()
    await approvals.publish(request, admin, expired)

    return {"success": True}


@router.put("/users/{user_id}/toggle-active")
async def toggle_user_active(
    user_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_permission("users.toggle_active")),
):
    """
    Toggle a user's active status.

    Requires ``users.toggle_active`` (an administrator account also
    ``users.edit_admins``); never oneself, the system administrator or the
    last active administrator.
    Matches: PUT /api/users/:id/toggle-active
    """
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Cannot deactivate your own account")

    result = await db.execute(
        select(User).where(User.id == user_id).options(selectinload(User.sites))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=404, detail=USER_NOT_FOUND_DETAIL)
    await _ensure_target_visible(request, db, admin, user_id)

    # Same protection as PUT /users/{id}: the provisioned admin cannot be disabled
    if user.is_system_user and user.active == 1:
        raise HTTPException(status_code=403, detail="Cannot deactivate system administrator")
    if user.role == ADMIN_ROLE_KEY:
        ensure_may_edit_user(admin, user.role)
        if user.active == 1:
            await ensure_not_last_active_admin(db, admin, user)

    # Toggle active status
    user.active = 0 if user.active == 1 else 1

    expired = None
    if user.active == 0:
        # A deactivated user's existing sessions must stop working now
        await SessionService(db).destroy_user_sessions(user_id, commit=False)
        # ... and their pending approval requests expire.
        expired = await approvals.expire_for_requester(db, admin, user_id)

    await db.commit()
    if expired is not None:
        await approvals.publish(request, admin, expired)
    await db.refresh(user)

    return build_user_list_response(user)
