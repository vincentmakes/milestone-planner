"""
The base dashboard "Overview" (app/services/dashboard_seed.py): eight widgets
in the shape the dashboard_widgets columns hold, metric queries in the spec's
shape, layouts inside the grid of every breakpoint without overlaps, and the
demo's two field widgets only for the fields that exist.
"""

import json
from itertools import combinations

import pytest

from app.models.dashboard import DASHBOARD_VISIBILITIES, DASHBOARD_WIDGET_KINDS
from app.services import dashboard_seed
from app.services.dashboard_seed import (
    BASE_DASHBOARD,
    DEMO_EXTRA_WIDGETS,
    GRID_COLUMNS,
    WIDGET_KEYS,
    base_dashboard_rows,
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
        "dimensions": [{"kind": "field", "field_id": 41}, {"kind": "team"}],
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
    for _, extra in DEMO_EXTRA_WIDGETS:
        fields = [d for d in extra["query"]["dimensions"] if d["kind"] == "field"]
        assert fields == [{"kind": "field", "field_id": None}]


def test_the_module_is_import_light():
    source = open(dashboard_seed.__file__).read()
    assert "sqlalchemy" not in source
    assert "app.models" not in source
