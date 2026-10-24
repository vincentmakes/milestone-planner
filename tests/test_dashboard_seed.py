"""
The base dashboard "Overview" (app/services/dashboard_seed.py): eight widgets
in the shape the dashboard_widgets columns hold, metric queries in the spec's
shape, layouts inside the grid of every breakpoint without overlaps, and the
demo's two field widgets only for the fields that exist. Then the demo-only
"Capacity and flows" (DEMO_DASHBOARD): one widget of each 2.1.0 chart kind,
under the same rules.
"""

import json
from itertools import combinations
from pathlib import Path

import pytest

from app.models.dashboard import DASHBOARD_VISIBILITIES, DASHBOARD_WIDGET_KINDS
from app.schemas.dashboard import MetricQuery, WidgetIn
from app.services import dashboard_seed, metrics
from app.services.dashboard_seed import (
    BASE_DASHBOARD,
    DEMO_DASHBOARD,
    DEMO_EXTRA_WIDGETS,
    GRID_COLUMNS,
    WIDGET_KEYS,
    base_dashboard_rows,
    demo_dashboard_rows,
)

FIELDS = {"Project type": 41, "Area": 42}
QUERY_KEYS = {"measure", "dimensions", "filters", "percent_of", "top_n"}


def _rows(field_ids=None):
    return base_dashboard_rows(field_ids)[1]


def _overlap(a: dict, b: dict) -> bool:
    return (
        a["x"] < b["x"] + b["w"]
        and b["x"] < a["x"] + a["w"]
        and a["y"] < b["y"] + b["h"]
        and b["y"] < a["y"] + a["h"]
    )


def test_the_base_dashboard():
    assert BASE_DASHBOARD["name"] == "Overview"
    assert BASE_DASHBOARD["visibility"] == "everyone"
    assert BASE_DASHBOARD["visibility"] in DASHBOARD_VISIBILITIES
    assert BASE_DASHBOARD["is_default"] is True
    description = BASE_DASHBOARD["description"]
    assert description.endswith(".") and description.count(". ") == 0  # one sentence
    dashboard, _ = base_dashboard_rows()
    assert dashboard == {
        "name": "Overview",
        "description": description,
        "visibility": "everyone",
        "is_default": True,
    }


def test_the_eight_widgets_in_order():
    assert [(w["kind"], w["title"]) for w in BASE_DASHBOARD["widgets"]] == [
        ("kpi", "Active projects"),
        ("kpi", "Confirmed share"),
        ("kpi", "Booked weeks this year"),
        ("kpi", "People booked"),
        ("bar", "Booked weeks per project"),
        ("bar", "Booked time per team by Confirmed"),
        ("line", "Booked weeks per month"),
        ("pie", "Projects by site"),
    ]


@pytest.mark.parametrize("field_ids", [None, FIELDS], ids=["base", "demo"])
def test_every_row_has_the_column_shape(field_ids):
    for row in _rows(field_ids):
        assert tuple(row) == WIDGET_KEYS
        assert row["kind"] in DASHBOARD_WIDGET_KINDS
        assert isinstance(row["title"], str) and 0 < len(row["title"]) <= 120
        for column in ("query", "options", "layout"):
            assert isinstance(row[column], str)
            # Compact and stable: what a re-seed would write byte for byte.
            assert row[column] == json.dumps(
                json.loads(row[column]), separators=(",", ":"), sort_keys=True
            )
        query = json.loads(row["query"])
        assert set(query) == QUERY_KEYS
        assert query["filters"]["archived"] == "exclude"
        assert set(query["filters"]["period"]) == {"relative"}
        assert len(query["dimensions"]) <= 2
        assert isinstance(json.loads(row["options"]), dict)


@pytest.mark.parametrize("field_ids", [None, FIELDS, {"Area": 42}], ids=["base", "demo", "area"])
def test_sort_order_is_contiguous(field_ids):
    rows = _rows(field_ids)
    assert [r["sort_order"] for r in rows] == list(range(len(rows)))


@pytest.mark.parametrize("field_ids", [None, FIELDS], ids=["base", "demo"])
def test_layouts_fit_the_grid_and_never_overlap(field_ids):
    layouts = [json.loads(r["layout"]) for r in _rows(field_ids)]
    for layout in layouts:
        assert set(layout) == set(GRID_COLUMNS)
    for breakpoint, cols in GRID_COLUMNS.items():
        boxes = [layout[breakpoint] for layout in layouts]
        for box in boxes:
            assert set(box) == {"x", "y", "w", "h"}
            assert box["x"] >= 0 and box["y"] >= 0 and box["w"] > 0 and box["h"] > 0
            assert box["x"] + box["w"] <= cols, (breakpoint, box)
        for a, b in combinations(boxes, 2):
            assert not _overlap(a, b), (breakpoint, a, b)


def test_the_layout_rules():
    layouts = [json.loads(r["layout"]) for r in _rows()]
    kpis, charts = layouts[:4], layouts[4:]
    # lg: four KPIs across row 0, charts two per row.
    assert [k["lg"] for k in kpis] == [{"x": x, "y": 0, "w": 3, "h": 2} for x in (0, 3, 6, 9)]
    assert [(c["lg"]["x"], c["lg"]["y"], c["lg"]["w"], c["lg"]["h"]) for c in charts] == [
        (0, 2, 6, 5),
        (6, 2, 6, 5),
        (0, 7, 6, 5),
        (6, 7, 6, 5),
    ]
    # md: KPIs two per row (two rows), charts full width.
    assert [(k["md"]["x"], k["md"]["y"], k["md"]["w"]) for k in kpis] == [
        (0, 0, 4),
        (4, 0, 4),
        (0, 2, 4),
        (4, 2, 4),
    ]
    assert all(c["md"]["w"] == 8 and c["md"]["h"] == 5 for c in charts)
    # sm: everything full width, stacked.
    assert all(layout["sm"]["w"] == 4 and layout["sm"]["x"] == 0 for layout in layouts)
    ys = [layout["sm"]["y"] for layout in layouts]
    assert ys == sorted(ys)


def test_the_queries():
    queries = {r["title"]: json.loads(r["query"]) for r in _rows()}
    this_year = {"archived": "exclude", "period": {"relative": "this_year"}}

    assert queries["Active projects"] == {
        "measure": "project_count",
        "dimensions": [],
        "filters": this_year,
        "percent_of": None,
        "top_n": None,
    }
    assert queries["Confirmed share"] == {
        "measure": "project_count",
        "dimensions": [{"kind": "confirmed"}],
        "filters": this_year,
        "percent_of": "total",
        "top_n": None,
    }
    assert queries["Booked weeks this year"]["measure"] == "booked_weeks"
    assert queries["Booked weeks this year"]["dimensions"] == []
    # people_booked without a person dimension (no views.staff needed).
    assert queries["People booked"]["measure"] == "people_booked"
    assert queries["People booked"]["dimensions"] == []
    assert queries["Booked weeks per project"] == {
        "measure": "booked_weeks",
        "dimensions": [{"kind": "project"}],
        "filters": this_year,
        "percent_of": None,
        "top_n": 10,
    }
    assert queries["Booked time per team by Confirmed"] == {
        "measure": "booked_weeks",
        "dimensions": [{"kind": "team"}, {"kind": "confirmed"}],
        "filters": this_year,
        "percent_of": "first_dimension",
        "top_n": None,
    }
    assert queries["Booked weeks per month"] == {
        "measure": "booked_weeks",
        "dimensions": [{"kind": "period", "grain": "month"}],
        "filters": {"archived": "exclude", "period": {"relative": "last_12_months"}},
        "percent_of": None,
        "top_n": None,
    }
    assert queries["Projects by site"]["measure"] == "project_count"
    assert queries["Projects by site"]["dimensions"] == [{"kind": "site"}]


def test_the_options():
    options = {r["title"]: json.loads(r["options"]) for r in _rows()}
    assert options["Confirmed share"] == {"kpi_bucket": True}
    assert options["Booked time per team by Confirmed"] == {"stacked": True, "percent": True}
    for title in ("Active projects", "Booked weeks per project", "Projects by site"):
        assert options[title] == {}


def test_without_fields_only_the_base_widgets():
    assert len(_rows()) == 8
    assert len(_rows({})) == 8
    assert len(_rows({"Budget": 7})) == 8


def test_the_demo_extras_with_their_field_ids():
    rows = _rows(FIELDS)
    assert len(rows) == 10
    share, area = rows[8], rows[9]
    assert (share["kind"], share["title"]) == ("bar", "Share of time by Project type per team")
    assert json.loads(share["query"]) == {
        "measure": "booked_weeks",
        "dimensions": [{"kind": "team"}, {"kind": "field", "field_id": 41}],
        "filters": {"archived": "exclude", "period": {"relative": "this_year"}},
        "percent_of": "first_dimension",
        "top_n": None,
    }
    assert json.loads(share["options"]) == {"stacked": True, "percent": True}
    assert (area["kind"], area["title"]) == ("bar", "Booked weeks by Area")
    assert json.loads(area["query"])["dimensions"] == [{"kind": "field", "field_id": 42}]
    # Placed after the base charts: the next chart row on lg.
    assert json.loads(share["layout"])["lg"] == {"x": 0, "y": 12, "w": 6, "h": 5}
    assert json.loads(area["layout"])["lg"] == {"x": 6, "y": 12, "w": 6, "h": 5}


def test_one_field_present_one_extra():
    rows = _rows({"Area": 42})
    assert len(rows) == 9
    assert rows[8]["title"] == "Booked weeks by Area"
    assert rows[8]["sort_order"] == 8
    assert json.loads(rows[8]["layout"])["lg"] == {"x": 0, "y": 12, "w": 6, "h": 5}


def test_the_templates_are_never_mutated():
    before = json.dumps([BASE_DASHBOARD, DEMO_EXTRA_WIDGETS], sort_keys=True)
    _rows(FIELDS)
    _rows({"Area": 1})
    assert json.dumps([BASE_DASHBOARD, DEMO_EXTRA_WIDGETS], sort_keys=True) == before
    # The field dimension keeps its placeholder id (filled per call only).
    dimensions = {title: extra["query"]["dimensions"] for title, extra in DEMO_EXTRA_WIDGETS}
    assert dimensions == {
        "Project type": [{"kind": "team"}, {"kind": "field", "field_id": None}],
        "Area": [{"kind": "field", "field_id": None}],
    }


def test_the_module_is_import_light():
    source = Path(dashboard_seed.__file__).read_text()
    assert "sqlalchemy" not in source
    assert "app.models" not in source


# ---------------------------------------------------------------------------
# The demo's second dashboard, "Capacity and flows"
# ---------------------------------------------------------------------------


def _demo_rows():
    return demo_dashboard_rows()[1]


def test_the_demo_dashboard():
    dashboard, _ = demo_dashboard_rows()
    assert dashboard == {
        "name": "Capacity and flows",
        "description": (
            "Utilisation against target, booked time per team and month, where each site's "
            "time goes and which teams work on which projects."
        ),
        "visibility": "everyone",
        "is_default": False,
    }
    assert dashboard == DEMO_DASHBOARD
    assert dashboard["visibility"] in DASHBOARD_VISIBILITIES
    assert dashboard["name"] != BASE_DASHBOARD["name"]


def test_the_four_demo_widgets_in_order():
    rows = _demo_rows()
    assert [(r["kind"], r["title"]) for r in rows] == [
        ("gauge", "Utilisation this quarter"),
        ("heatmap", "Booked weeks per team and month"),
        ("treemap", "Booked weeks by site and project"),
        ("sankey", "Project to team flows"),
    ]
    assert all(r["kind"] in DASHBOARD_WIDGET_KINDS for r in rows)
    assert [r["sort_order"] for r in rows] == [0, 1, 2, 3]


def test_every_demo_row_has_the_column_shape_and_validates():
    for row in _demo_rows():
        assert tuple(row) == WIDGET_KEYS
        for column in ("query", "options", "layout"):
            assert row[column] == json.dumps(
                json.loads(row[column]), separators=(",", ":"), sort_keys=True
            )
        assert set(json.loads(row["query"])) == QUERY_KEYS
        widget = WidgetIn.model_validate(
            {**row, **{c: json.loads(row[c]) for c in ("query", "options", "layout")}}
        )
        query = MetricQuery.model_validate(json.loads(row["query"]))
        for dimension in query.dimensions:
            assert metrics.matrix_error(query.measure, dimension.kind) is None, row["title"]
        assert widget.query == query


def test_the_demo_queries_and_options():
    rows = {r["title"]: r for r in _demo_rows()}
    queries = {title: json.loads(r["query"]) for title, r in rows.items()}
    options = {title: json.loads(r["options"]) for title, r in rows.items()}

    def query(measure, dimensions, period="this_year", top_n=None):
        return {
            "measure": measure,
            "dimensions": dimensions,
            "filters": {"archived": "exclude", "period": {"relative": period}},
            "percent_of": None,
            "top_n": top_n,
        }

    assert queries == {
        "Utilisation this quarter": query("utilisation", [], "this_quarter"),
        "Booked weeks per team and month": query(
            "booked_weeks",
            [{"kind": "team"}, {"kind": "period", "grain": "month"}],
            "last_12_months",
        ),
        "Booked weeks by site and project": query(
            "booked_weeks", [{"kind": "site"}, {"kind": "project"}]
        ),
        "Project to team flows": query(
            "booked_weeks", [{"kind": "project"}, {"kind": "team"}], top_n=8
        ),
    }
    assert options == {
        "Utilisation this quarter": {"target": 85},
        "Booked weeks per team and month": {},
        "Booked weeks by site and project": {},
        "Project to team flows": {},
    }


def test_the_demo_layouts():
    layouts = [json.loads(r["layout"]) for r in _demo_rows()]
    assert layouts == [
        {
            "lg": {"x": 0, "y": 0, "w": 3, "h": 4},
            "md": {"x": 0, "y": 0, "w": 4, "h": 4},
            "sm": {"x": 0, "y": 0, "w": 4, "h": 4},
        },
        {
            "lg": {"x": 3, "y": 0, "w": 9, "h": 4},
            "md": {"x": 4, "y": 0, "w": 4, "h": 4},
            "sm": {"x": 0, "y": 4, "w": 4, "h": 5},
        },
        {
            "lg": {"x": 0, "y": 4, "w": 6, "h": 5},
            "md": {"x": 0, "y": 4, "w": 8, "h": 5},
            "sm": {"x": 0, "y": 9, "w": 4, "h": 5},
        },
        {
            "lg": {"x": 6, "y": 4, "w": 6, "h": 5},
            "md": {"x": 0, "y": 9, "w": 8, "h": 5},
            "sm": {"x": 0, "y": 14, "w": 4, "h": 5},
        },
    ]
    for breakpoint, cols in GRID_COLUMNS.items():
        boxes = [layout[breakpoint] for layout in layouts]
        for box in boxes:
            assert box["x"] >= 0 and box["y"] >= 0 and box["w"] > 0 and box["h"] > 0
            assert box["x"] + box["w"] <= cols, (breakpoint, box)
        for a, b in combinations(boxes, 2):
            assert not _overlap(a, b), (breakpoint, a, b)


def test_the_demo_rows_never_touch_the_overview():
    before = json.dumps([BASE_DASHBOARD, DEMO_DASHBOARD], sort_keys=True)
    demo_dashboard_rows()
    demo_dashboard_rows()[1][0]["kind"] = "kpi"  # a caller's change stays its own
    assert json.dumps([BASE_DASHBOARD, DEMO_DASHBOARD], sort_keys=True) == before
    assert demo_dashboard_rows()[1][0]["kind"] == "gauge"
    assert all(r["kind"] in ("kpi", "bar", "line", "pie") for r in _rows({"Area": 1}))
