"""
Who may see and edit a dashboard (2.1.0).

- **View**: an administrator (every dashboard); the owner; anyone when the
  visibility is ``everyone``; for ``shared``, anyone matching one of its
  targets -- holding one of its roles, being a member (live ``user_sites``) of
  one of its sites or a member of one of its teams, or being one of its
  people. Any match is enough. A ``sites.view_all`` holder who is not a
  member of a site does not match it. A ``shared`` dashboard whose targets
  were all deleted is left to its owner and the administrators. Opening the
  Dashboards view at all needs ``views.dashboards`` (checked by the routes).
- **Edit** (rename, share, change widgets, delete): an administrator, or the
  owner while holding ``dashboards.manage``. Shared access is view only.
  Deleting the default dashboard is the administrators' alone (the router's
  rule).

The viewer's side of the match is resolved **once per request** by
``load_viewer_scope``: the session user carries its live role *key*, not the
id, and neither its sites nor its teams. Like ``project_access``, the helpers
only read ``id``, ``role`` / ``is_admin`` and ``permissions``, so they work
with the session user.
"""

from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, and_, exists, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dashboard import (
    Dashboard,
    DashboardRole,
    DashboardSite,
    DashboardTeam,
    DashboardUser,
)
from app.models.rbac import Role
from app.models.team import TeamMember
from app.services import site_access

MANAGE_KEY = "dashboards.manage"
VIEW_KEY = "views.dashboards"


@dataclass(frozen=True)
class ViewerScope:
    """What a viewer matches a ``shared`` dashboard on."""

    user_id: int
    is_admin: bool
    role_id: int | None = None
    site_ids: frozenset[int] = frozenset()
    team_ids: frozenset[int] = frozenset()


async def load_viewer_scope(db: AsyncSession, user: Any) -> ViewerScope:
    """
    The caller's scope: role id (by its key), member sites and teams.

    Sites are the raw ``user_sites`` membership (never the "every site" of
    ``sites.view_all``): sharing with a site means its members. An
    administrator sees every dashboard, so nothing is queried for one.
    """
    if user.is_admin:
        return ViewerScope(user_id=user.id, is_admin=True)
    role_id: int | None = None
    if user.role:
        result = await db.execute(select(Role.id).where(Role.key == user.role))
        role_id = result.scalar_one_or_none()
    site_ids = await site_access._load_user_site_ids(db, user.id)
    teams = await db.execute(select(TeamMember.team_id).where(TeamMember.user_id == user.id))
    return ViewerScope(
        user_id=user.id,
        is_admin=False,
        role_id=role_id,
        site_ids=frozenset(site_ids),
        team_ids=frozenset(teams.scalars().all()),
    )


def can_view(scope: ViewerScope, dashboard: Dashboard) -> bool:
    """Whether the viewer of ``scope`` may open ``dashboard``."""
    if scope.is_admin or dashboard.owner_id == scope.user_id:
        return True
    if dashboard.visibility == "everyone":
        return True
    if dashboard.visibility != "shared":
        return False
    return (
        (scope.role_id is not None and scope.role_id in dashboard.role_ids)
        or not scope.site_ids.isdisjoint(dashboard.site_ids)
        or not scope.team_ids.isdisjoint(dashboard.team_ids)
        or scope.user_id in dashboard.user_ids
    )


def can_edit(user: Any, dashboard: Dashboard) -> bool:
    """Whether ``user`` may change or delete ``dashboard``."""
    if user.is_admin:
        return True
    return dashboard.owner_id == user.id and bool(user.permissions.has(MANAGE_KEY))


def visible_dashboards_clause(scope: ViewerScope) -> ColumnElement[bool]:
    """The SQL filter of the dashboards ``can_view`` allows (for the list)."""
    if scope.is_admin:
        return true()
    matches: list[ColumnElement[bool]] = [
        exists().where(
            DashboardUser.dashboard_id == Dashboard.id,
            DashboardUser.user_id == scope.user_id,
        )
    ]
    if scope.role_id is not None:
        matches.append(
            exists().where(
                DashboardRole.dashboard_id == Dashboard.id,
                DashboardRole.role_id == scope.role_id,
            )
        )
    if scope.site_ids:
        matches.append(
            exists().where(
                DashboardSite.dashboard_id == Dashboard.id,
                DashboardSite.site_id.in_(sorted(scope.site_ids)),
            )
        )
    if scope.team_ids:
        matches.append(
            exists().where(
                DashboardTeam.dashboard_id == Dashboard.id,
                DashboardTeam.team_id.in_(sorted(scope.team_ids)),
            )
        )
    return or_(
        Dashboard.owner_id == scope.user_id,
        Dashboard.visibility == "everyone",
        and_(Dashboard.visibility == "shared", or_(*matches)),
    )
