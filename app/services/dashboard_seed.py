"""
The base dashboard "Overview" (2.1.0), as plain Python.

Seeded once, in the step that creates the dashboards tables: the provisioner
(``tenant_provisioner.run_seed_data``, new tenants), the tenant auto-migration
(``tenant_manager._run_auto_migrations``, existing tenants), ``init_db`` when
it creates the tables, and the demo seed (``demo_seed.insert_demo_data``,
which adds the two widgets over the demo's "Project type" and "Area" fields).
An admin may delete or edit it afterwards; nothing brings it back.

Each widget is ``{kind, title, query, options, layout, sort_order}``: the
metric ``query`` follows the metric-query spec (measure, dimensions, filters,
percent_of, top_n), ``options`` the display options, ``layout`` the grid
position per breakpoint (``lg`` 12 columns, ``md`` 8, ``sm`` 4).
``base_dashboard_rows`` serialises them to the JSON texts the
``dashboard_widgets`` columns hold; every caller inserts the rows with bound
parameters (never JSON inside SQL text: ``:0`` would read as a bind).

Import-light: no models, no SQLAlchemy.
"""

import copy
import json
from typing import Any

# Grid columns per breakpoint (the frontend grid uses the same counts).
GRID_COLUMNS: dict[str, int] = {"lg": 12, "md": 8, "sm": 4}

KPI_HEIGHT = 2
CHART_HEIGHT = 5
_KPI_COUNT = 4

WIDGET_KEYS: tuple[str, ...] = ("kind", "title", "query", "options", "layout", "sort_order")


def _query(
    measure: str,
    dimensions: list[dict[str, Any]] | None = None,
    *,
    period: str = "this_year",
    percent_of: str | None = None,
    top_n: int | None = None,
) -> dict[str, Any]:
    return {
        "measure": measure,
        "dimensions": dimensions or [],
        "filters": {"archived": "exclude", "period": {"relative": period}},
        "percent_of": percent_of,
        "top_n": top_n,
    }


def _kpi_layout(index: int) -> dict[str, dict[str, int]]:
    """The four KPIs: one row on lg, two rows of two on md, stacked on sm."""
    return {
        "lg": {"x": index * 3, "y": 0, "w": 3, "h": KPI_HEIGHT},
        "md": {"x": (index % 2) * 4, "y": (index // 2) * KPI_HEIGHT, "w": 4, "h": KPI_HEIGHT},
        "sm": {"x": 0, "y": index * KPI_HEIGHT, "w": 4, "h": KPI_HEIGHT},
    }


def chart_layout(index: int) -> dict[str, dict[str, int]]:
    """The ``index``-th chart below the KPIs: two per row on lg, stacked below."""
    lg_top = KPI_HEIGHT
    md_top = (_KPI_COUNT // 2) * KPI_HEIGHT
    sm_top = _KPI_COUNT * KPI_HEIGHT
    return {
        "lg": {
            "x": (index % 2) * 6,
            "y": lg_top + (index // 2) * CHART_HEIGHT,
            "w": 6,
            "h": CHART_HEIGHT,
        },
        "md": {"x": 0, "y": md_top + index * CHART_HEIGHT, "w": 8, "h": CHART_HEIGHT},
        "sm": {"x": 0, "y": sm_top + index * CHART_HEIGHT, "w": 4, "h": CHART_HEIGHT},
    }


def _widget(
    kind: str,
    title: str,
    query: dict[str, Any],
    layout: dict[str, dict[str, int]],
    sort_order: int,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "title": title,
        "query": query,
        "options": options or {},
        "layout": layout,
        "sort_order": sort_order,
    }


_KPIS: tuple[tuple[str, dict[str, Any], dict[str, Any] | None], ...] = (
    ("Active projects", _query("project_count"), None),
    (
        "Confirmed share",
        _query("project_count", [{"kind": "confirmed"}], percent_of="total"),
        {"kpi_bucket": True},
    ),
    ("Booked weeks this year", _query("booked_weeks"), None),
    ("People booked", _query("people_booked"), None),
)

_CHARTS: tuple[tuple[str, str, dict[str, Any], dict[str, Any] | None], ...] = (
    (
        "bar",
        "Booked weeks per project",
        _query("booked_weeks", [{"kind": "project"}], top_n=10),
        None,
    ),
    (
        "bar",
        "Booked time per team by Confirmed",
        _query(
            "booked_weeks",
            [{"kind": "team"}, {"kind": "confirmed"}],
            percent_of="first_dimension",
        ),
        {"stacked": True, "percent": True},
    ),
    (
        "line",
        "Booked weeks per month",
        _query("booked_weeks", [{"kind": "period", "grain": "month"}], period="last_12_months"),
        None,
    ),
    ("pie", "Projects by site", _query("project_count", [{"kind": "site"}]), None),
)

BASE_DASHBOARD: dict[str, Any] = {
    "name": "Overview",
    "description": (
        "The planning at a glance: active and confirmed projects, booked time per project, "
        "team and month, and projects per site."
    ),
    "visibility": "everyone",
    "is_default": True,
    "widgets": [
        *(
            _widget("kpi", title, query, _kpi_layout(i), i, options)
            for i, (title, query, options) in enumerate(_KPIS)
        ),
        *(
            _widget(kind, title, query, chart_layout(i), _KPI_COUNT + i, options)
            for i, (kind, title, query, options) in enumerate(_CHARTS)
        ),
    ],
}

# The demo's extra widgets, over its project fields (keyed by field name; the
# field id is filled in by base_dashboard_rows). Added after the base charts.
DEMO_EXTRA_WIDGETS: tuple[tuple[str, dict[str, Any]], ...] = (
    (
        "Project type",
        {
            "kind": "bar",
            "title": "Share of time by Project type per team",
            "query": _query(
                "booked_weeks",
                [{"kind": "field", "field_id": None}, {"kind": "team"}],
                percent_of="first_dimension",
            ),
            "options": {"stacked": True, "percent": True},
        },
    ),
    (
        "Area",
        {
            "kind": "bar",
            "title": "Booked weeks by Area",
            "query": _query("booked_weeks", [{"kind": "field", "field_id": None}]),
            "options": {},
        },
    ),
)


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _with_field(query: dict[str, Any], field_id: int) -> dict[str, Any]:
    filled = copy.deepcopy(query)
    for dimension in filled["dimensions"]:
        if dimension["kind"] == "field":
            dimension["field_id"] = field_id
    return filled


def base_dashboard_rows(
    field_ids: dict[str, int] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    The insert parameters of the base dashboard and of its widgets.

    Returns ``(dashboard, widgets)``: ``dashboard`` = ``{name, description,
    visibility, is_default}``, each widget = ``{kind, title, query, options,
    layout, sort_order}`` with ``query`` / ``options`` / ``layout`` as compact
    JSON text. ``field_ids`` (project field name -> id) adds the demo extras
    whose field is present, after the base widgets.
    """
    dashboard = {key: BASE_DASHBOARD[key] for key in ("name", "description", "visibility")}
    dashboard["is_default"] = BASE_DASHBOARD["is_default"]
    widgets = [copy.deepcopy(w) for w in BASE_DASHBOARD["widgets"]]

    charts = len(_CHARTS)
    for field_name, extra in DEMO_EXTRA_WIDGETS:
        if not field_ids or field_name not in field_ids:
            continue
        widgets.append(
            _widget(
                extra["kind"],
                extra["title"],
                _with_field(extra["query"], field_ids[field_name]),
                chart_layout(charts),
                len(widgets),
                extra["options"],
            )
        )
        charts += 1

    rows = [
        {
            "kind": w["kind"],
            "title": w["title"],
            "query": _json(w["query"]),
            "options": _json(w["options"]),
            "layout": _json(w["layout"]),
            "sort_order": w["sort_order"],
        }
        for w in widgets
    ]
    return dashboard, rows
