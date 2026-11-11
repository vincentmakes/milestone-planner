"""
The two base dashboards, "Overview" and "Capacity and flows" (2.3.0), as
plain Python.

Seeded once, in the step that creates the dashboards tables, by four paths:
the provisioner (``tenant_provisioner.run_seed_data`` through
``seed_base_dashboard``, new tenants), the tenant auto-migration
(``tenant_manager._run_auto_migrations``, existing tenants), ``init_db`` when
it creates the tables (``run_seed_data(seed_dashboards=True)``), and the demo
seed (``demo_seed.insert_demo_dashboards``). A tenant whose dashboards tables
already exist gets nothing; an admin may delete or edit either dashboard
afterwards and nothing brings it back.

"Capacity and flows" opens with the absorption gauge (2.6.0,
``ABSORPTION_WIDGET``): a calculated widget, customer weeks over 70 % of the
capacity weeks this year. Its capacity term needs the Staff & Calendar view
key, so a viewer without it sees the permission note on that tile only; the
heatmap, treemap and sankey need nothing beyond ``views.dashboards``.
Instances whose dashboards predate it get it once, at the bottom of the
built-in "Capacity and flows", from the data migration
(``tenant_data_migrations``, ``absorption_widget_row``).

The demo adds its extras to the same definitions: the two Overview widgets
over its "Project type" and "Area" fields (``DEMO_EXTRA_WIDGETS``, through
``base_dashboard_rows(field_ids)``) and, first on "Capacity and flows", a
utilisation gauge beside the absorption gauge
(``capacity_dashboard_rows(with_gauge=True)``).

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
# field id is filled in by overview_rows). Added after the base charts.
DEMO_EXTRA_WIDGETS: tuple[tuple[str, dict[str, Any]], ...] = (
    (
        "Project type",
        {
            "kind": "bar",
            "title": "Share of time by Project type per team",
            "query": _query(
                "booked_weeks",
                [{"kind": "team"}, {"kind": "field", "field_id": None}],
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


# The second base dashboard: the absorption gauge (Staff & Calendar), then a
# heatmap, a treemap and a sankey over the booking data (no project field, no
# view key beyond views.dashboards). Explicit layouts per breakpoint. The
# demo puts the utilisation gauge first (_CAPACITY_GAUGE, demo-only) and
# shifts the others (_DEMO_CAPACITY_LAYOUTS): one definition of each widget,
# two layouts.
CAPACITY_DASHBOARD_NAME = "Capacity and flows"

# (kind, title, query, options)
_CapacityWidget = tuple[str, str, dict[str, Any], dict[str, Any] | None]

_CAPACITY_GAUGE: _CapacityWidget = (
    "gauge",
    "Utilisation this quarter",
    _query("utilisation", period="this_quarter"),
    {"target": 85},
)

# The absorption example (2.6.0): customer weeks over 70 % of the capacity
# weeks this year; 100 % on the dial means the 70 % goal is met.
ABSORPTION_WIDGET_TITLE = "Customer absorption this year"
ABSORPTION_QUERY: dict[str, Any] = {
    **_query("booked_weeks"),
    "formula": {
        "expression": "customer_weeks / (capacity_weeks * 70%)",
        "terms": [
            {
                "name": "customer_weeks",
                "measure": "booked_weeks",
                "filters": {"has_customer": True},
            },
            {"name": "capacity_weeks", "measure": "capacity_weeks", "filters": {}},
        ],
        "result": "percent",
    },
}
_ABSORPTION_GAUGE: _CapacityWidget = (
    "gauge",
    ABSORPTION_WIDGET_TITLE,
    ABSORPTION_QUERY,
    {"target": 100, "target_is_goal": True},
)

_CAPACITY_CHARTS: tuple[_CapacityWidget, ...] = (
    _ABSORPTION_GAUGE,
    (
        "heatmap",
        "Booked weeks per team and month",
        _query(
            "booked_weeks",
            [{"kind": "team"}, {"kind": "period", "grain": "month"}],
            period="last_12_months",
        ),
        None,
    ),
    (
        "treemap",
        "Booked weeks by site and project",
        _query("booked_weeks", [{"kind": "site"}, {"kind": "project"}]),
        None,
    ),
    (
        "sankey",
        "Project to team flows",
        # top_n ranks the first dimension: the eight busiest projects (and
        # Other) flow to the teams.
        _query("booked_weeks", [{"kind": "project"}, {"kind": "team"}], top_n=8),
        None,
    ),
)


def _box(x: int, y: int, w: int, h: int) -> dict[str, int]:
    return {"x": x, "y": y, "w": w, "h": h}


# Absorption gauge, heatmap, treemap, sankey: the gauge, the heatmap beside
# it, the two others side by side below on lg, stacked on md and sm.
_CAPACITY_LAYOUTS: tuple[dict[str, dict[str, int]], ...] = (
    {"lg": _box(0, 0, 3, 4), "md": _box(0, 0, 4, 4), "sm": _box(0, 0, 4, 4)},
    {"lg": _box(3, 0, 9, 4), "md": _box(4, 0, 4, 4), "sm": _box(0, 4, 4, 5)},
    {"lg": _box(0, 4, 6, 5), "md": _box(0, 4, 8, 5), "sm": _box(0, 9, 4, 5)},
    {"lg": _box(6, 4, 6, 5), "md": _box(0, 9, 8, 5), "sm": _box(0, 14, 4, 5)},
)

# The demo's: the utilisation gauge above the absorption gauge on lg, the
# heatmap beside them, the treemap and the sankey below.
_DEMO_CAPACITY_LAYOUTS: tuple[dict[str, dict[str, int]], ...] = (
    {"lg": _box(0, 0, 3, 4), "md": _box(0, 0, 4, 4), "sm": _box(0, 0, 4, 4)},
    {"lg": _box(0, 4, 3, 5), "md": _box(4, 0, 4, 4), "sm": _box(0, 4, 4, 4)},
    {"lg": _box(3, 0, 9, 4), "md": _box(0, 4, 8, 4), "sm": _box(0, 8, 4, 5)},
    {"lg": _box(3, 4, 4, 5), "md": _box(0, 8, 8, 5), "sm": _box(0, 13, 4, 5)},
    {"lg": _box(7, 4, 5, 5), "md": _box(0, 13, 8, 5), "sm": _box(0, 18, 4, 5)},
)

# The absorption gauge appended to an existing "Capacity and flows" (the
# data migration): this size, at the left, under every other widget.
ABSORPTION_APPEND_SIZE: dict[str, tuple[int, int]] = {"lg": (3, 4), "md": (4, 4), "sm": (4, 4)}


def _capacity_widgets(with_gauge: bool) -> list[dict[str, Any]]:
    content = (_CAPACITY_GAUGE, *_CAPACITY_CHARTS) if with_gauge else _CAPACITY_CHARTS
    layouts = _DEMO_CAPACITY_LAYOUTS if with_gauge else _CAPACITY_LAYOUTS
    return [
        _widget(kind, title, copy.deepcopy(query), copy.deepcopy(layout), i, copy.deepcopy(opts))
        for i, ((kind, title, query, opts), layout) in enumerate(zip(content, layouts, strict=True))
    ]


CAPACITY_DASHBOARD: dict[str, Any] = {
    "name": CAPACITY_DASHBOARD_NAME,
    "description": (
        "Customer absorption against its goal, booked time per team and month, where each "
        "site's time goes and which teams work on which projects."
    ),
    "visibility": "everyone",
    "is_default": False,
    "widgets": _capacity_widgets(with_gauge=False),
}

# The base dashboards, in seeding order: the default first.
BASE_DASHBOARDS: tuple[dict[str, Any], ...] = (BASE_DASHBOARD, CAPACITY_DASHBOARD)

DASHBOARD_KEYS: tuple[str, ...] = ("name", "description", "visibility", "is_default")


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _widget_row(widget: dict[str, Any]) -> dict[str, Any]:
    """One widget as the ``dashboard_widgets`` columns hold it (JSON as text)."""
    return {
        "kind": widget["kind"],
        "title": widget["title"],
        "query": _json(widget["query"]),
        "options": _json(widget["options"]),
        "layout": _json(widget["layout"]),
        "sort_order": widget["sort_order"],
    }


def _with_field(query: dict[str, Any], field_id: int) -> dict[str, Any]:
    filled = copy.deepcopy(query)
    for dimension in filled["dimensions"]:
        if dimension["kind"] == "field":
            dimension["field_id"] = field_id
    return filled


def _dashboard_row(definition: dict[str, Any]) -> dict[str, Any]:
    return {key: definition[key] for key in DASHBOARD_KEYS}


def overview_rows(
    field_ids: dict[str, int] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    The insert parameters of the Overview and of its widgets.

    Returns ``(dashboard, widgets)``: ``dashboard`` = ``{name, description,
    visibility, is_default}``, each widget = ``{kind, title, query, options,
    layout, sort_order}`` with ``query`` / ``options`` / ``layout`` as compact
    JSON text. ``field_ids`` (project field name -> id) adds the demo extras
    whose field is present, after the base widgets.
    """
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

    return _dashboard_row(BASE_DASHBOARD), [_widget_row(w) for w in widgets]


def capacity_dashboard_rows(
    with_gauge: bool = False,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    The insert parameters of "Capacity and flows" and of its widgets, in the
    shapes ``overview_rows`` returns: the heatmap, the treemap and the sankey,
    or -- ``with_gauge``, the demo -- the utilisation gauge first, then those.
    """
    return _dashboard_row(CAPACITY_DASHBOARD), [
        _widget_row(w) for w in _capacity_widgets(with_gauge)
    ]


def base_dashboard_rows(
    field_ids: dict[str, int] | None = None,
) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    """
    The insert parameters of both base dashboards, in ``BASE_DASHBOARDS``
    order: ``[(overview, widgets), (capacity, widgets)]``, each pair as
    ``overview_rows`` returns it. ``field_ids`` adds the demo's field widgets
    to the Overview; "Capacity and flows" is always the gauge-less base one.
    """
    return [overview_rows(field_ids), capacity_dashboard_rows()]


def absorption_widget_row(layouts: list[dict[str, Any]], sort_order: int) -> dict[str, Any]:
    """
    The absorption gauge as a ``dashboard_widgets`` row appended to an
    existing "Capacity and flows" whose widgets have ``layouts``: at the left,
    below the lowest widget of each breakpoint (worked out here, never left
    to the client's compaction), with ``sort_order``.
    """
    layout: dict[str, dict[str, int]] = {}
    for breakpoint, (w, h) in ABSORPTION_APPEND_SIZE.items():
        bottom = 0
        for existing in layouts:
            box = existing.get(breakpoint) if isinstance(existing, dict) else None
            if isinstance(box, dict):
                try:
                    bottom = max(bottom, int(box.get("y", 0)) + int(box.get("h", 0)))
                except (TypeError, ValueError):
                    continue
        layout[breakpoint] = _box(0, bottom, w, h)
    kind, title, query, options = _ABSORPTION_GAUGE
    return _widget_row(
        _widget(kind, title, copy.deepcopy(query), layout, sort_order, copy.deepcopy(options))
    )
