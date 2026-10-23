"""
Dashboards API (2.1.0): KPI and chart dashboards over the planning data.

- ``GET /dashboards`` (``views.dashboards``) -- the dashboards the caller may
  open (own, ``everyone``, ``roles`` holding the caller's role; admins: all),
  default first, then by name, with ``widget_count``, ``owner_name`` and
  ``can_edit``.
- ``GET /dashboards/{id}`` -- one dashboard with its widgets (404 unless the
  caller may open it).
- ``POST /dashboards`` (``dashboards.manage``) -- create; ``source_id`` copies
  a dashboard the caller may open (``widgets`` in the body win); ``roles``
  needs at least one role (400), an unknown role is a 404; ``is_default`` is
  never set here; the caller owns it. 201 with the dashboard.
- ``PUT /dashboards/{id}`` -- the owner holding ``dashboards.manage``, or an
  admin (404 for those who may not open it, 403 for viewers): replaces the
  name, description, visibility, roles and -- when given -- the widgets (new
  ids). ``is_default`` and the owner never change.
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
from datetime import UTC, date, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db, get_db_readonly
from app.middleware.auth import get_current_user, require_permission
from app.models.dashboard import Dashboard, DashboardRole, DashboardWidget
from app.models.rbac import Role
from app.models.user import User
from app.schemas.base import serialize_datetime_js
from app.schemas.dashboard import DashboardIn, MetricQuery, WidgetIn
from app.services.dashboard_access import (
    MANAGE_KEY,
    VIEW_KEY,
    can_edit,
    can_view,
    role_id_for_key,
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
from app.services.site_access import visible_site_ids
from app.utils import utcnow_naive

router = APIRouter(prefix="/dashboards", tags=["dashboards"])

DASHBOARD_NOT_FOUND_DETAIL = "Dashboard not found"
CANNOT_EDIT_DETAIL = "You cannot edit this dashboard"
DEFAULT_DELETE_DETAIL = "Only an administrator can delete the default dashboard"
ROLES_REQUIRED_DETAIL = "Choose at least one role"
ROLE_NOT_FOUND_DETAIL = "Role not found"
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


async def _visible_dashboard(db: AsyncSession, user: User, dashboard_id: int) -> Dashboard:
    """The dashboard if the caller may open it, else 404 (its existence stays hidden)."""
    dashboard = await _get_dashboard(db, dashboard_id)
    if dashboard is None or not can_view(user, dashboard, await role_id_for_key(db, user.role)):
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


async def _dashboard_out(db: AsyncSession, user: User, dashboard: Dashboard) -> dict[str, Any]:
    widgets = [_widget_out(widget) for widget in dashboard.widgets]
    return {
        "id": dashboard.id,
        "name": dashboard.name,
        "description": dashboard.description,
        "visibility": dashboard.visibility,
        "role_ids": dashboard.role_ids,
        "owner_id": dashboard.owner_id,
        "owner_name": await _owner_name(db, dashboard.owner_id),
        "is_default": dashboard.is_default,
        "widget_count": len(widgets),
        "can_edit": can_edit(user, dashboard),
        "updated_at": serialize_datetime_js(dashboard.updated_at),
        "widgets": widgets,
    }


async def _checked_role_ids(db: AsyncSession, body: DashboardIn) -> list[int]:
    """The roles a ``roles`` dashboard is shared with: at least one (400), all known (404)."""
    if body.visibility != "roles":
        return []
    role_ids = sorted(set(body.role_ids))
    if not role_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=ROLES_REQUIRED_DETAIL)
    result = await db.execute(select(Role.id).where(Role.id.in_(role_ids)))
    if set(result.scalars().all()) != set(role_ids):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ROLE_NOT_FOUND_DETAIL)
    return role_ids


def _description(text: str | None) -> str | None:
    text = (text or "").strip()
    return text or None


@router.get("", response_model=None)
async def list_dashboards(
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(require_permission(VIEW_KEY)),
) -> list[dict[str, Any]]:
    """The dashboards the caller may open, the default first, then by name."""
    role_id = await role_id_for_key(db, user.role)
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
        .where(visible_dashboards_clause(user.id, role_id, user.is_admin))
        .order_by(Dashboard.is_default.desc(), func.lower(Dashboard.name), Dashboard.id)
    )
    rows = result.all()
    roles: dict[int, list[int]] = {}
    if rows:
        links = await db.execute(
            select(DashboardRole.dashboard_id, DashboardRole.role_id)
            .where(DashboardRole.dashboard_id.in_([row.id for row in rows]))
            .order_by(DashboardRole.dashboard_id, DashboardRole.role_id)
        )
        for dashboard_id, linked_role in links.all():
            roles.setdefault(dashboard_id, []).append(linked_role)
    return [
        {
            "id": row.id,
            "name": row.name,
            "description": row.description,
            "visibility": row.visibility,
            "role_ids": roles.get(row.id, []),
            "owner_id": row.owner_id,
            "owner_name": _full_name(row.first_name, row.last_name),
            "is_default": bool(row.is_default),
            "widget_count": int(row.widget_count or 0),
            "can_edit": _can_edit_owned(user, row.owner_id),
            "updated_at": serialize_datetime_js(row.updated_at),
        }
        for row in rows
    ]


@router.get("/{dashboard_id}", response_model=None)
async def get_dashboard(
    dashboard_id: int,
    db: AsyncSession = Depends(get_db_readonly),
    user: User = Depends(require_permission(VIEW_KEY)),
) -> dict[str, Any]:
    """One dashboard with its widgets."""
    dashboard = await _visible_dashboard(db, user, dashboard_id)
    return await _dashboard_out(db, user, dashboard)


@router.post("", status_code=status.HTTP_201_CREATED, response_model=None)
async def create_dashboard(
    body: DashboardIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission(MANAGE_KEY)),
) -> dict[str, Any]:
    """Create a dashboard owned by the caller, optionally copying another one's widgets."""
    widgets = _widget_rows(body.widgets)
    if body.source_id is not None:
        source = await _visible_dashboard(db, user, body.source_id)
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
    role_ids = await _checked_role_ids(db, body)

    dashboard = Dashboard(
        name=body.name,
        description=_description(body.description),
        owner_id=user.id,
        visibility=body.visibility,
        is_default=False,
    )
    dashboard.roles = [DashboardRole(role_id=role_id) for role_id in role_ids]
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
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Replace a dashboard's fields, sharing and (when given) widgets."""
    dashboard = await _visible_dashboard(db, user, dashboard_id)
    if not can_edit(user, dashboard):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=CANNOT_EDIT_DETAIL)
    role_ids = await _checked_role_ids(db, body)

    dashboard.name = body.name
    dashboard.description = _description(body.description)
    dashboard.visibility = body.visibility
    kept = {link.role_id: link for link in dashboard.roles}
    dashboard.roles = [kept.get(role_id) or DashboardRole(role_id=role_id) for role_id in role_ids]
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
    dashboard = await _visible_dashboard(db, user, dashboard_id)
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
    extent = None
    if any(getattr(query.filters.period, "relative", None) == "all" for query in queries):
        extent = await load_extent(db, visible_site_ids=visible, archived=archived)
    periods = [resolve_period(query.filters.period, today, extent) for query in queries]
    return await load_facts(
        db,
        period=(min(p[0] for p in periods), max(p[1] for p in periods)),
        visible_site_ids=visible,
        archived=archived,
        today=today,
        extent=extent,
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
    dashboard = await _visible_dashboard(db, user, dashboard_id)
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
