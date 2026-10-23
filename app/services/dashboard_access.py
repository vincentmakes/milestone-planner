"""
Who may see and edit a dashboard (2.1.0).

- **View**: an administrator (every dashboard); the owner; anyone when the
  visibility is ``everyone``; holders of one of the dashboard's roles when it
  is ``roles``. A ``roles`` dashboard whose roles were all deleted is left to
  its owner and the administrators. Opening the Dashboards view at all needs
  ``views.dashboards`` (checked by the routes).
- **Edit** (rename, share, change widgets, delete): an administrator, or the
  owner while holding ``dashboards.manage``. Deleting the default dashboard is
  the administrators' alone (the router's rule).

Visibility by role compares role **ids**: the session user carries its live
role *key*, so a route resolves the id once per request with
``role_id_for_key``. Like ``project_access``, the helpers only read ``id``,
``role`` / ``is_admin`` and ``permissions``, so they work with the session user.
"""

from typing import Any

from sqlalchemy import ColumnElement, and_, exists, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard import Dashboard, DashboardRole
from app.models.rbac import Role

MANAGE_KEY = "dashboards.manage"
VIEW_KEY = "views.dashboards"


async def role_id_for_key(db: AsyncSession, key: str | None) -> int | None:
    """The id of the role ``key`` (None for no key or an unknown one)."""
    if not key:
        return None
    result = await db.execute(select(Role.id).where(Role.key == key))
    role_id: int | None = result.scalar_one_or_none()
    return role_id


def can_view(user: Any, dashboard: Dashboard, role_id: int | None) -> bool:
    """Whether ``user`` (whose role id is ``role_id``) may open ``dashboard``."""
    if user.is_admin or dashboard.owner_id == user.id:
        return True
    if dashboard.visibility == "everyone":
        return True
    return dashboard.visibility == "roles" and role_id is not None and role_id in dashboard.role_ids


def can_edit(user: Any, dashboard: Dashboard) -> bool:
    """Whether ``user`` may change or delete ``dashboard``."""
    if user.is_admin:
        return True
    return dashboard.owner_id == user.id and bool(user.permissions.has(MANAGE_KEY))


def visible_dashboards_clause(
    user_id: int, role_id: int | None, is_admin: bool
) -> ColumnElement[bool]:
    """The SQL filter of the dashboards ``can_view`` allows (for the list)."""
    if is_admin:
        return true()
    branches: list[ColumnElement[bool]] = [
        Dashboard.owner_id == user_id,
        Dashboard.visibility == "everyone",
    ]
    if role_id is not None:
        branches.append(
            and_(
                Dashboard.visibility == "roles",
                exists().where(
                    DashboardRole.dashboard_id == Dashboard.id,
                    DashboardRole.role_id == role_id,
                ),
            )
        )
    return or_(*branches)
