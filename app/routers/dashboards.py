"""
Dashboards API (2.1.0): KPI and chart dashboards over the planning data.

- ``GET /dashboards`` (``views.dashboards``) -- the dashboards the caller may
  open (own, ``everyone``, ``shared`` with one of the caller's role, member
  sites, teams or the caller; admins: all), default first, then by name,
  with ``widget_count``, ``owner_name``, ``can_edit``, the target id lists
  and ``shared_with`` (the targets by name).
- ``GET /dashboards/shareable-users`` (``dashboards.manage``) -- the people
  the caller may share with: active members of the caller's visible sites and
  every active user whose role sees all sites (``people_lists``).
- ``GET /dashboards/{id}`` -- one dashboard with its widgets (404 unless the
  caller may open it).
- ``POST /dashboards`` (``dashboards.manage``) -- create; ``source_id`` copies
  the widgets of a dashboard the caller may open (``widgets`` in the body
  win; its sharing is never copied); ``shared`` needs at least one role,
  site, team or person (400) and each must be one the caller may pick (any
  role, a visible site, a team at one, a shareable person -- else 404 per
  kind); ``is_default`` is never set here; the caller owns it. 201 with the
  dashboard.
- ``PUT /dashboards/{id}`` -- the owner holding ``dashboards.manage``, or an
  admin (404 for those who may not open it, 403 for viewers): replaces the
  name, description and -- when given -- the sharing (any of ``visibility``
  and the four target lists; absent, the sharing stays as it is) and the
  widgets (new ids). Targets already on the dashboard stay accepted even when
  the editor could not pick them any more. ``is_default`` and the owner never
  change.
- ``DELETE /dashboards/{id}`` -- same rule; the default dashboard only by an
  admin (403). 204.
- ``POST /dashboards/query`` (``views.dashboards``) -- answer one metric query
  (the builder's preview). ``person`` needs ``views.staff``, ``archived:
  include | only`` needs ``views.archived`` (422 in plain words).
- ``POST /dashboards/{id}/data`` -- every widget's result. The facts are
  loaded **once**, for the union of the widgets' periods; each widget applies
  its own period and filters. A widget that cannot be answered (unreadable or
  invalid query, deleted field, a permission the viewer lacks) carries
  ``{error}`` alone.

Every query is cut to the caller's visible sites, so a shared dashboard shows
each viewer their own numbers. A widget's ``query``, ``options`` and
``layout`` travel as JSON objects and are stored as compact JSON text.
Writes are coarse-broadcast as ``change:dashboard``; ``/query`` and
``/{id}/data`` are reads and are skipped (``BroadcastMiddleware``). The
routes are What-If-exempt on the client (reports, never plan data).
"""

import json
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, get_db_readonly
from app.middleware.auth import get_current_user, require_permission
from app.models.dashboard import (
    Dashboard,
    DashboardRole,
    DashboardSite,
    DashboardTeam,
    DashboardUser,
    DashboardWidget,
)
from app.models.rbac import Role
from app.models.site import Site
from app.models.team import Team
from app.models.user import User, UserSite
from app.schemas.base import serialize_datetime_js
from app.schemas.dashboard import DashboardIn, MetricQuery, WidgetIn
from app.services.dashboard_access import (
    MANAGE_KEY,
    VIEW_KEY,
    ViewerScope,
    can_edit,
    can_view,
    load_viewer_scope,
    visible_dashboards_clause,
)
from app.services.metrics import (
    ARCHIVED_NEEDS,
    Facts,
    MetricError,
    Viewer,
    aggregate,
    load_extent,
    load_facts,
    missing_permission,
    permission_message,
    resolve_period,
)
from app.services.people_lists import shareable_users_statement
from app.services.site_access import visible_site_ids
from app.utils import utcnow_naive

router = APIRouter(prefix="/dashboards", tags=["dashboards"])

DASHBOARD_NOT_FOUND_DETAIL = "Dashboard not found"
CANNOT_EDIT_DETAIL = "You cannot edit this dashboard"
DEFAULT_DELETE_DETAIL = "Only an administrator can delete the default dashboard"
TARGET_REQUIRED_DETAIL = "Choose at least one role, site, team or person"
ROLE_NOT_FOUND_DETAIL = "Role not found"
SITE_NOT_FOUND_DETAIL = "Site not found"
TEAM_NOT_FOUND_DETAIL = "Team not found"
PERSON_NOT_FOUND_DETAIL = "Person not found"
UNREADABLE_QUERY_DETAIL = "This widget's query cannot be read"


def _today() -> date:
    """The server's UTC date (per-site time zones later)."""
    return datetime.now(UTC).date()


def _viewer(user: User) -> Viewer:
    return Viewer(
        can_see_staff=user.permissions.has("views.staff"),
        can_see_archived=user.permissions.has(ARCHIVED_NEEDS),
    )


def _dump(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _loads(text: str | None) -> dict[str, Any]:
    try:
        value = json.loads(text or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _widget_rows(widgets: list[WidgetIn]) -> list[DashboardWidget]:
    return [
        DashboardWidget(
            kind=widget.kind,
            title=widget.title,
            query=_dump(widget.query.model_dump(mode="json", by_alias=True, exclude_unset=True)),
            options=_dump(widget.options.model_dump(mode="json", exclude_unset=True)),
            layout=_dump(widget.layout.model_dump(mode="json")),
            sort_order=widget.sort_order if widget.sort_order is not None else index,
        )
        for index, widget in enumerate(widgets)
    ]


def _widget_out(widget: DashboardWidget) -> dict[str, Any]:
    return {
        "id": widget.id,
        "kind": widget.kind,
        "title": widget.title,
        "query": _loads(widget.query),
        "options": _loads(widget.options),
        "layout": _loads(widget.layout),
        "sort_order": widget.sort_order,
    }


def _full_name(first: str | None, last: str | None) -> str | None:
    if first is None and last is None:
        return None
    return f"{first or ''} {last or ''}".strip()


def _can_edit_owned(user: User, owner_id: int | None) -> bool:
    return user.is_admin or (owner_id == user.id and user.permissions.has(MANAGE_KEY))


async def _get_dashboard(db: AsyncSession, dashboard_id: int) -> Dashboard | None:
    result = await db.execute(
        select(Dashboard)
        .where(Dashboard.id == dashboard_id)
        .execution_options(populate_existing=True)
    )
    dashboard: Dashboard | None = result.scalar_one_or_none()
    return dashboard


async def _visible_dashboard(db: AsyncSession, scope: ViewerScope, dashboard_id: int) -> Dashboard:
    """The dashboard if the caller may open it, else 404 (its existence stays hidden)."""
    dashboard = await _get_dashboard(db, dashboard_id)
    if dashboard is None or not can_view(scope, dashboard):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=DASHBOARD_NOT_FOUND_DETAIL
        )
    return dashboard


async def _owner_name(db: AsyncSession, owner_id: int | None) -> str | None:
    if owner_id is None:
        return None
    result = await db.execute(select(User.first_name, User.last_name).where(User.id == owner_id))
    row = result.first()
    return _full_name(row[0], row[1]) if row else None


def _empty_sharing() -> dict[str, Any]:
    return {
        "role_ids": [],
        "site_ids": [],
        "team_ids": [],
        "user_ids": [],
        "shared_with": {"roles": [], "sites": [], "teams": [], "users": []},
    }


async def _sharing(db: AsyncSession, dashboard_ids: list[int]) -> dict[int, dict[str, Any]]:
    """
    Per dashboard: the four target id lists (ascending) and ``shared_with``,
    the targets by name (case-insensitive name order; teams with their site).
    One query per kind over every given dashboard.
    """
    sharing = {dashboard_id: _empty_sharing() for dashboard_id in dashboard_ids}
    if not dashboard_ids:
        return sharing

    def add(dashboard_id: int, kind: str, ids_key: str, entry: dict[str, Any]) -> None:
        sharing[dashboard_id][ids_key].append(entry["id"])
        sharing[dashboard_id]["shared_with"][kind].append(entry)

    roles = await db.execute(
        select(DashboardRole.dashboard_id, Role.id, Role.name)
        .join(Role, Role.id == DashboardRole.role_id)
        .where(DashboardRole.dashboard_id.in_(dashboard_ids))
        .order_by(func.lower(Role.name), Role.id)
    )
    for dashboard_id, role_id, name in roles.all():
        add(dashboard_id, "roles", "role_ids", {"id": role_id, "name": name})
    sites = await db.execute(
        select(DashboardSite.dashboard_id, Site.id, Site.name)
        .join(Site, Site.id == DashboardSite.site_id)
        .where(DashboardSite.dashboard_id.in_(dashboard_ids))
        .order_by(func.lower(Site.name), Site.id)
    )
    for dashboard_id, site_id, name in sites.all():
        add(dashboard_id, "sites", "site_ids", {"id": site_id, "name": name})
    teams = await db.execute(
        select(DashboardTeam.dashboard_id, Team.id, Team.name, Site.name)
        .join(Team, Team.id == DashboardTeam.team_id)
        .join(Site, Site.id == Team.site_id)
        .where(DashboardTeam.dashboard_id.in_(dashboard_ids))
        .order_by(func.lower(Team.name), func.lower(Site.name), Team.id)
    )
    for dashboard_id, team_id, name, site_name in teams.all():
        add(
            dashboard_id,
            "teams",
            "team_ids",
            {"id": team_id, "name": name, "site_name": site_name},
        )
    users = await db.execute(
        select(DashboardUser.dashboard_id, User.id, User.first_name, User.last_name)
        .join(User, User.id == DashboardUser.user_id)
        .where(DashboardUser.dashboard_id.in_(dashboard_ids))
        .order_by(func.lower(User.first_name), func.lower(User.last_name), User.id)
    )
    for dashboard_id, user_id, first, last in users.all():
        add(dashboard_id, "users", "user_ids", {"id": user_id, "name": _full_name(first, last)})
    for entry in sharing.values():
        for ids_key in ("role_ids", "site_ids", "team_ids", "user_ids"):
            entry[ids_key].sort()
    return sharing


async def _dashboard_out(db: AsyncSession, user: User, dashboard: Dashboard) -> dict[str, Any]:
    widgets = [_widget_out(widget) for widget in dashboard.widgets]
    sharing = (await _sharing(db, [dashboard.id]))[dashboard.id]
    return {
        "id": dashboard.id,
        "name": dashboard.name,
        "description": dashboard.description,
        "visibility": dashboard.visibility,
        **sharing,
        "owner_id": dashboard.owner_id,
        "owner_name": await _owner_name(db, dashboard.owner_id),
        "is_default": dashboard.is_default,
        "widget_count": len(widgets),
        "can_edit": can_edit(user, dashboard),
        "updated_at": serialize_datetime_js(dashboard.updated_at),
        "widgets": widgets,
    }


@dataclass
class _Targets:
    """The targets a dashboard is stored with (all empty unless ``shared``)."""

    role_ids: list[int] = field(default_factory=list)
    site_ids: list[int] = field(default_factory=list)
    team_ids: list[int] = field(default_factory=list)
    user_ids: list[int] = field(default_factory=list)


# The PUT body keys that change the sharing (absent: it stays as it is).
SHARING_KEYS = frozenset({"visibility", "role_ids", "site_ids", "team_ids", "user_ids"})


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


async def _checked_targets(
    db: AsyncSession,
    request: Request,
    user: User,
    body: DashboardIn,
    visibility: str,
    current: Dashboard | None = None,
) -> _Targets:
    """
    The targets of a ``shared`` dashboard (``visibility``, the one being
    stored): at least one of any kind (400), each one the caller may pick (else
    404 per kind): any existing role, a visible site, a team at a visible site
    (inactive ones too), a shareable person. Targets ``current`` already holds
    pass as they are (they were checked when added; a person deactivated or a
    site left since must not block a save). Other visibilities store no target.
    """
    if visibility != "shared":
        return _Targets()
    targets = _Targets(
        role_ids=body.role_ids,
        site_ids=body.site_ids,
        team_ids=body.team_ids,
        user_ids=body.user_ids,
    )
    if not (targets.role_ids or targets.site_ids or targets.team_ids or targets.user_ids):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=TARGET_REQUIRED_DETAIL)

    def new(ids: list[int], kept: list[int]) -> list[int]:
        return sorted(set(ids) - set(kept))

    roles = new(targets.role_ids, current.role_ids if current else [])
    sites = new(targets.site_ids, current.site_ids if current else [])
    teams = new(targets.team_ids, current.team_ids if current else [])
    people = new(targets.user_ids, current.user_ids if current else [])
    visible = await visible_site_ids(request, db, user) if (sites or teams or people) else None

    if roles:
        found = await db.execute(select(Role.id).where(Role.id.in_(roles)))
        if set(found.scalars().all()) != set(roles):
            raise _not_found(ROLE_NOT_FOUND_DETAIL)
    if sites:
        site_query = select(Site.id).where(Site.id.in_(sites))
        if visible is not None:
            site_query = site_query.where(Site.id.in_(sorted(visible)))
        found = await db.execute(site_query)
        if set(found.scalars().all()) != set(sites):
            raise _not_found(SITE_NOT_FOUND_DETAIL)
    if teams:
        team_query = select(Team.id).where(Team.id.in_(teams))
        if visible is not None:
            team_query = team_query.where(Team.site_id.in_(sorted(visible)))
        found = await db.execute(team_query)
        if set(found.scalars().all()) != set(teams):
            raise _not_found(TEAM_NOT_FOUND_DETAIL)
    if people:
        found = await db.execute(
            shareable_users_statement(visible).where(User.id.in_(people)).with_only_columns(User.id)
        )
        if set(found.scalars().all()) != set(people):
            raise _not_found(PERSON_NOT_FOUND_DETAIL)
    return targets


def _apply_targets(dashboard: Dashboard, targets: _Targets) -> None:
    """Store the targets, keeping the link rows that stay (no delete + insert)."""
    kept_roles = {link.role_id: link for link in dashboard.roles}
    dashboard.roles = [
        kept_roles.get(role_id) or DashboardRole(role_id=role_id) for role_id in targets.role_ids
    ]
    kept_sites = {link.site_id: link for link in dashboard.sites}
    dashboard.sites = [
        kept_sites.get(site_id) or DashboardSite(site_id=site_id) for site_id in targets.site_ids
    ]
    kept_teams = {link.team_id: link for link in dashboard.teams}
    dashboard.teams = [
        kept_teams.get(team_id) or DashboardTeam(team_id=team_id) for team_id in targets.team_ids
    ]
    kept_users = {link.user_id: link for link in dashboard.users}
    dashboard.users = [
        kept_users.get(user_id) or DashboardUser(user_id=user_id) for user_id in targets.user_ids
    ]


def _description(text: str | None) -> str | None:
    text = (text or "").strip()
    return text or None


@router.get("", response_model=None)
async def list_dashboards(
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(require_permission(VIEW_KEY)),
) -> list[dict[str, Any]]:
    """The dashboards the caller may open, the default first, then by name."""
    scope = await load_viewer_scope(db, user)
    widget_count = (
        select(func.count(DashboardWidget.id))
        .where(DashboardWidget.dashboard_id == Dashboard.id)
        .correlate(Dashboard)
        .scalar_subquery()
    )
    result = await db.execute(
        select(
            Dashboard.id,
            Dashboard.name,
            Dashboard.description,
            Dashboard.visibility,
            Dashboard.owner_id,
            Dashboard.is_default,
            Dashboard.updated_at,
            User.first_name,
            User.last_name,
            widget_count.label("widget_count"),
        )
        .outerjoin(User, User.id == Dashboard.owner_id)
        .where(visible_dashboards_clause(scope))
        .order_by(Dashboard.is_default.desc(), func.lower(Dashboard.name), Dashboard.id)
    )
    rows = result.all()
    sharing = await _sharing(db, [row.id for row in rows])
    return [
        {
            "id": row.id,
            "name": row.name,
            "description": row.description,
            "visibility": row.visibility,
            **sharing[row.id],
            "owner_id": row.owner_id,
            "owner_name": _full_name(row.first_name, row.last_name),
            "is_default": bool(row.is_default),
            "widget_count": int(row.widget_count or 0),
            "can_edit": _can_edit_owned(user, row.owner_id),
            "updated_at": serialize_datetime_js(row.updated_at),
        }
        for row in rows
    ]


@router.get("/shareable-users", response_model=None)
async def shareable_users(
    request: Request,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(require_permission(MANAGE_KEY)),
) -> list[dict[str, Any]]:
    """
    The people the caller may share a dashboard with, by name: active members
    of the caller's visible sites and every active user whose role sees all
    sites. ``site_names`` lists each person's sites among the caller's visible
    ones (every site with ``sites.view_all``), by name.
    """
    visible = await visible_site_ids(request, db, user)
    result = await db.execute(
        shareable_users_statement(visible)
        .with_only_columns(User.id, User.first_name, User.last_name, User.job_title)
        .order_by(func.lower(User.first_name), func.lower(User.last_name), User.id)
    )
    people = result.all()
    site_names: dict[int, list[str]] = {}
    if people:
        sites_query = (
            select(UserSite.user_id, Site.name)
            .join(Site, Site.id == UserSite.site_id)
            .where(UserSite.user_id.in_([person.id for person in people]))
            .order_by(func.lower(Site.name), Site.id)
        )
        if visible is not None:
            sites_query = sites_query.where(Site.id.in_(sorted(visible)))
        for user_id, site_name in (await db.execute(sites_query)).all():
            site_names.setdefault(user_id, []).append(site_name)
    return [
        {
            "id": person.id,
            "name": _full_name(person.first_name, person.last_name),
            "job_title": person.job_title,
            "site_names": site_names.get(person.id, []),
        }
        for person in people
    ]


@router.get("/{dashboard_id}", response_model=None)
async def get_dashboard(
    dashboard_id: int,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(require_permission(VIEW_KEY)),
) -> dict[str, Any]:
    """One dashboard with its widgets."""
    dashboard = await _visible_dashboard(db, await load_viewer_scope(db, user), dashboard_id)
    return await _dashboard_out(db, user, dashboard)


@router.post("", status_code=status.HTTP_201_CREATED, response_model=None)
async def create_dashboard(
    body: DashboardIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(MANAGE_KEY)),
) -> dict[str, Any]:
    """
    Create a dashboard owned by the caller, optionally copying another one's
    widgets (only the widgets: the copy takes the body's sharing).
    """
    widgets = _widget_rows(body.widgets)
    if body.source_id is not None:
        scope = await load_viewer_scope(db, user)
        source = await _visible_dashboard(db, scope, body.source_id)
        if "widgets" not in body.model_fields_set:
            widgets = [
                DashboardWidget(
                    kind=widget.kind,
                    title=widget.title,
                    query=widget.query,
                    options=widget.options,
                    layout=widget.layout,
                    sort_order=widget.sort_order,
                )
                for widget in source.widgets
            ]
    targets = await _checked_targets(db, request, user, body, body.visibility)

    dashboard = Dashboard(
        name=body.name,
        description=_description(body.description),
        owner_id=user.id,
        visibility=body.visibility,
        is_default=False,
    )
    _apply_targets(dashboard, targets)
    dashboard.widgets = widgets
    db.add(dashboard)
    await db.commit()

    created = await _get_dashboard(db, dashboard.id)
    assert created is not None
    return await _dashboard_out(db, user, created)


@router.put("/{dashboard_id}", response_model=None)
async def update_dashboard(
    dashboard_id: int,
    body: DashboardIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Replace a dashboard's name and description, and -- when given -- its
    sharing and its widgets. The sharing changes only when the body holds one
    of ``SHARING_KEYS`` (the Share dialog sends them, the widget editor never
    does): lists without ``visibility`` keep the current visibility, a
    ``visibility`` without lists means no target. Otherwise the visibility and
    every target stay as they are, so a widget save never undoes a sharing
    change made meanwhile nor trips over a target deleted since.
    """
    dashboard = await _visible_dashboard(db, await load_viewer_scope(db, user), dashboard_id)
    if not can_edit(user, dashboard):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=CANNOT_EDIT_DETAIL)
    given = body.model_fields_set
    if given & SHARING_KEYS:
        visibility = body.visibility if "visibility" in given else dashboard.visibility
        targets = await _checked_targets(db, request, user, body, visibility, current=dashboard)
        dashboard.visibility = visibility
        _apply_targets(dashboard, targets)

    dashboard.name = body.name
    dashboard.description = _description(body.description)
    if "widgets" in body.model_fields_set:
        dashboard.widgets = _widget_rows(body.widgets)
    dashboard.updated_at = utcnow_naive()
    await db.commit()

    updated = await _get_dashboard(db, dashboard_id)
    assert updated is not None
    return await _dashboard_out(db, user, updated)


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard(
    dashboard_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Delete a dashboard (the default one: administrators only)."""
    dashboard = await _visible_dashboard(db, await load_viewer_scope(db, user), dashboard_id)
    if dashboard.is_default and not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=DEFAULT_DELETE_DETAIL)
    if not can_edit(user, dashboard):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=CANNOT_EDIT_DETAIL)
    await db.delete(dashboard)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _widest_archived(queries: list[MetricQuery]) -> str:
    """The archived mode whose facts cover every query's own mode."""
    modes = {query.filters.archived for query in queries}
    if "include" in modes or modes == {"exclude", "only"}:
        return "include"
    return "only" if modes == {"only"} else "exclude"


async def _load_for(
    db: AsyncSession,
    queries: list[MetricQuery],
    visible: frozenset[int] | None,
    today: date,
) -> Facts:
    """The facts every query needs: one load over the union of their periods."""
    archived = _widest_archived(queries)
    # ``all`` spans the projects of the query's own archived mode: one extent
    # per distinct mode among those queries (three at most).
    extents: dict[str, tuple[date, date] | None] = {}
    for mode in sorted(
        {
            query.filters.archived
            for query in queries
            if getattr(query.filters.period, "relative", None) == "all"
        }
    ):
        extents[mode] = await load_extent(db, visible_site_ids=visible, archived=mode)
    periods = [
        resolve_period(query.filters.period, today, extents.get(query.filters.archived))
        for query in queries
    ]
    return await load_facts(
        db,
        period=(min(p[0] for p in periods), max(p[1] for p in periods)),
        visible_site_ids=visible,
        archived=archived,
        today=today,
        extents=extents,
    )


@router.post("/query", response_model=None)
async def run_query(
    body: MetricQuery,
    request: Request,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(require_permission(VIEW_KEY)),
) -> dict[str, Any]:
    """Answer one metric query (the builder's preview)."""
    viewer = _viewer(user)
    needed = missing_permission(body, viewer)
    if needed is not None:
        raise HTTPException(status_code=422, detail=permission_message(needed))
    visible = await visible_site_ids(request, db, user)
    try:
        facts = await _load_for(db, [body], visible, _today())
        return aggregate(facts, body, viewer=viewer).to_dict()
    except MetricError as exc:
        raise HTTPException(status_code=422, detail=exc.message) from None


def _parse_widget_query(widget: DashboardWidget, viewer: Viewer) -> MetricQuery | str:
    """The widget's query, or the error message the widget shows instead."""
    try:
        query = MetricQuery.model_validate(json.loads(widget.query))
    except ValidationError as exc:
        return str(exc.errors()[0]["msg"])
    except ValueError:
        return UNREADABLE_QUERY_DETAIL
    needed = missing_permission(query, viewer)
    return permission_message(needed) if needed is not None else query


@router.post("/{dashboard_id}/data", response_model=None)
async def dashboard_data(
    dashboard_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(require_permission(VIEW_KEY)),
) -> dict[str, Any]:
    """Every widget's result (or its error), from one load of the facts."""
    dashboard = await _visible_dashboard(db, await load_viewer_scope(db, user), dashboard_id)
    viewer = _viewer(user)
    parsed = {widget.id: _parse_widget_query(widget, viewer) for widget in dashboard.widgets}
    queries = [query for query in parsed.values() if isinstance(query, MetricQuery)]

    results: dict[str, Any] = {}
    facts: Facts | None = None
    load_error: str | None = None
    if queries:
        visible = await visible_site_ids(request, db, user)
        try:
            facts = await _load_for(db, queries, visible, _today())
        except MetricError as exc:
            load_error = exc.message
    for widget_id, query in parsed.items():
        if not isinstance(query, MetricQuery):
            results[str(widget_id)] = {"error": query}
        elif facts is None:
            results[str(widget_id)] = {"error": load_error or UNREADABLE_QUERY_DETAIL}
        else:
            try:
                results[str(widget_id)] = aggregate(facts, query, viewer=viewer).to_dict()
            except MetricError as exc:
                results[str(widget_id)] = {"error": exc.message}
    return {"widgets": results, "loaded_at": serialize_datetime_js(utcnow_naive())}
