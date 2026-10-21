"""
Authentication middleware and dependencies.

Provides FastAPI dependencies for protecting routes with authentication
and permission-based access control: ``get_current_user`` resolves the user's
live role and its permissions (``user.permissions``, a ``PermissionSet``) on
every request, and ``require_permission`` / ``require_any_permission`` /
``require_project_permission`` gate routes on permission keys.
"""

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Cookie, Depends, HTTPException, Path, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.rbac import Role, RolePermission
from app.models.user import User
from app.services.permissions import (
    PERMISSION_KEYS,
    PM_BUNDLE,
    PermissionSet,
    permission_required_detail,
)
from app.services.project_access import project_pm_id
from app.services.session import SessionService, parse_session_cookie

UserDependency = Callable[..., Awaitable[User]]


async def load_live_user(db: AsyncSession, user_id: Any) -> tuple[bool, str, PermissionSet] | None:
    """
    The live ``(active, role, permissions)`` of a user, or None if the row is gone.

    One round trip: the ``users`` row outer-joined to its role's
    ``role_permissions`` rows (one result row per permission, a single row
    with NULL permission columns for a role without rows, such as admin).
    """
    rows = (
        await db.execute(
            select(User.active, User.role, RolePermission.permission, RolePermission.mode)
            .select_from(User)
            .outerjoin(Role, Role.key == User.role)
            .outerjoin(RolePermission, RolePermission.role_id == Role.id)
            .where(User.id == user_id)
        )
    ).all()
    if not rows:
        return None
    active, role = rows[0][0], rows[0][1]
    modes = {row[2]: row[3] for row in rows if row[2] is not None}
    return bool(active), role, PermissionSet(role, modes)


async def get_current_user_from_session(request: Request) -> dict[str, Any] | None:
    """
    Get current user data directly from request session.

    This is a standalone function (not a dependency) for use in custom routes
    (the API-docs gate). The session is resolved in the *request's* database —
    the tenant's in multi-tenant mode, never the ``DB_*`` default for a tenant
    URL — and the live ``role``/``active`` and the role's permissions are
    re-read like ``get_current_user`` does. Returns the user dict (with the live
    ``role`` and ``permissions``, a ``PermissionSet``), or None.
    """
    from app.config import get_settings
    from app.database import get_session_factory, resolve_tenant_session_factory

    # Get session cookie
    connect_sid = request.cookies.get("connect.sid")
    if not connect_sid:
        return None

    session_id = parse_session_cookie(connect_sid)
    if not session_id:
        return None

    try:
        session_factory = resolve_tenant_session_factory(request)
    except HTTPException:
        return None
    if session_factory is None:
        if get_settings().multi_tenant:
            # No tenant context: there is no sessions table to consult.
            return None
        session_factory = get_session_factory()

    async with session_factory() as db:
        user_data = await SessionService(db).get_user_from_session(session_id)
        if not user_data or not user_data.get("id"):
            return None
        live = await load_live_user(db, user_data["id"])
        if live is None or not live[0]:
            return None
        return {**user_data, "role": live[1], "permissions": live[2]}


async def get_session_id(
    request: Request,
    connect_sid: str | None = Cookie(None, alias="connect.sid"),
) -> str | None:
    """
    Extract session ID from cookie.

    Handles the express-session cookie format.
    """
    if connect_sid:
        return parse_session_cookie(connect_sid)
    return None


async def get_current_user_optional(
    session_id: str | None = Depends(get_session_id),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """
    Get current user if authenticated, None otherwise.

    Use this for routes that work both authenticated and anonymous.
    """
    if not session_id:
        return None

    session_service = SessionService(db)
    user_data = await session_service.get_user_from_session(session_id)

    if not user_data:
        return None

    # Create a User-like object from session data to avoid extra DB query
    # The session already contains all the user info we need
    user_id = user_data.get("id")
    if not user_id:
        return None

    # For most operations, we can use the cached session data
    # Only fetch from DB if we need fresh data or relationships
    class SessionUser:
        """Lightweight user object from session data."""

        def __init__(self, data: dict):
            self.id = data.get("id")
            self.email = data.get("email")
            self.first_name = data.get("first_name")
            self.last_name = data.get("last_name")
            self.job_title = data.get("job_title")
            self.role = data.get("role")
            # The login-time role's set, without rows (deny but the admin and
            # the locked view); get_current_user replaces it with the live one.
            self.permissions = PermissionSet(self.role or "", {})
            self._site_ids = data.get("site_ids", [])
            self._site_names = data.get("site_names", [])
            # These are used for auth checks
            self.is_active = True  # If session exists, user was active

        @property
        def is_admin(self) -> bool:
            return self.role == "admin"

        @property
        def site_ids(self) -> list:
            return self._site_ids

        @property
        def sites(self) -> list:
            # Return lightweight site-like objects
            class SiteRef:
                def __init__(self, id, name):
                    self.id = id
                    self.name = name

            return [
                SiteRef(id, name)
                for id, name in zip(self._site_ids, self._site_names, strict=False)
            ]

    return SessionUser(user_data)  # type: ignore[return-value]


async def get_current_user(
    request: Request,
    user: User | None = Depends(get_current_user_optional),
    session_id: str | None = Depends(get_session_id),
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    Get current authenticated user.

    Raises 401 if not authenticated.
    Use this for routes that require authentication.

    The session holds a login-time snapshot of the user, so the live
    ``active`` flag, ``role`` and the role's permissions are re-read on every
    call (one query, ``load_live_user``; no cross-request cache): a
    deactivated or deleted user is rejected with 401 and their session
    destroyed, and a role change or an edit of the role's matrix takes effect
    on the next request rather than when the cookie expires. The result is
    stored as ``user.role`` and ``user.permissions``. Other snapshot fields
    (name, sites) are still served from the session.

    Side-effect: stashes a small dict identifying the authenticated user in
    `scope["state"]["current_user"]` so ASGI middleware running outside the
    request context (e.g. the auto-broadcast middleware) can attribute the
    change without doing another tenant-aware DB roundtrip.
    """
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    live = await load_live_user(db, user.id)

    if live is None or not live[0]:
        if session_id:
            await SessionService(db).delete_session(session_id)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is disabled",
        )

    user.role = live[1]
    user.permissions = live[2]

    state = request.scope.get("state")
    if isinstance(state, dict):
        state["current_user"] = {
            "id": user.id,
            "first_name": getattr(user, "first_name", "") or "",
            "last_name": getattr(user, "last_name", "") or "",
        }

    return user


async def require_admin(
    user: User = Depends(get_current_user),
) -> User:
    """
    Require the admin role (the lockout-proof surface only: the roles and
    approval-policy writes). Every other gate names a permission key through
    ``require_permission`` / ``require_any_permission`` /
    ``require_project_permission``.

    Raises 403 if user is not an admin.
    """
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user


def _ensure_known(keys: tuple[str, ...]) -> None:
    """Fail at import time on a misspelt key instead of denying silently."""
    if not keys:
        raise ValueError("A permission gate needs at least one key")
    unknown = [key for key in keys if key not in PERMISSION_KEYS]
    if unknown:
        raise ValueError(f"Unknown permission: {', '.join(unknown)}")


def require_permission(key: str) -> UserDependency:
    """
    Dependency factory: the current user must hold ``key`` (allow mode).

    403 ``Permission required: <key>`` otherwise; the admin role passes.
    """
    _ensure_known((key,))

    async def dependency(user: User = Depends(get_current_user)) -> User:
        if not user.permissions.has(key):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail=permission_required_detail(key)
            )
        return user

    return dependency


def require_any_permission(*keys: str) -> UserDependency:
    """
    Dependency factory: the current user must hold at least one of ``keys``.

    403 ``Permission required: <a> or <b>`` otherwise.
    """
    _ensure_known(keys)

    async def dependency(user: User = Depends(get_current_user)) -> User:
        if not any(user.permissions.has(key) for key in keys):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail=permission_required_detail(*keys)
            )
        return user

    return dependency


def require_project_permission(key: str) -> UserDependency:
    """
    Dependency factory for routes with a ``project_id`` path parameter: the
    current user must hold ``key``, or reach it through the PM bundle on that
    project (``key`` in ``PM_BUNDLE``, the role allows
    ``projects.manage_as_pm`` and ``projects.pm_id`` is the user).

    The ``pm_id`` is read server-side (one query, only when the key is not
    held outright and the role may act as PM; 404 if the project is missing).
    403 ``Permission required: <key>`` otherwise.

    Constraint: the route's path parameter must be named ``project_id``. It is
    bound as an explicit ``Path()`` parameter, so on a route whose parameter
    is named differently every request fails with 422 -- it can never be
    supplied (and the PM check steered) through a ``?project_id=`` query
    string. Such routes resolve the project id in the handler instead
    (``project_access.require_on_project``).
    """
    _ensure_known((key,))

    async def dependency(
        project_id: int = Path(),
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        permissions = user.permissions
        if permissions.has(key):
            return user
        if key in PM_BUNDLE and permissions.has("projects.manage_as_pm"):
            # The role may act as PM for this key: is the user this project's PM?
            pm_id = await project_pm_id(db, project_id)
            if permissions.can(key, pm_id=pm_id, user_id=user.id):
                return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=permission_required_detail(key)
        )

    return dependency
