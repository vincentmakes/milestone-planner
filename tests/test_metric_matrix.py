"""
The validity matrix (``metrics.MATRIX``) and its frontend mirror.

``shared/metric-matrix.json`` is generated from ``metrics.metric_matrix_json()``;
the frontend's hand-written matrix is checked against the file.
"""

import json
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from app.schemas.dashboard import Measure, MetricFilters, MetricQuery, PlainKind, RelativeName
from app.services.metrics import (
    ARCHIVED_NEEDS,
    COMPOSITES,
    DIMENSION_KINDS,
    FAMILIES,
    FAMILY,
    FILTER_KEYS,
    FILTER_LABELS,
    FILTER_NEEDS,
    INTERNAL_MEASURES,
    MATRIX,
    MEASURE_FILTERS,
    MEASURE_LABELS,
    MEASURE_NEEDS,
    MEASURES,
    NEEDS,
    NO_PERCENT_MEASURES,
    PERIOD_LABELS,
    PERMISSION_NAMES,
    PLAIN_DIMENSION_KINDS,
    RELATIVE_PERIODS,
    UNITS,
    VIEWER_KEYS,
    matrix_error,
    metric_matrix_json,
)
from app.services.permissions import PERMISSION_KEYS

ROOT = Path(__file__).resolve().parents[1]
MATRIX_FILE = ROOT / "shared" / "metric-matrix.json"

BOOKING = ("booked_days", "booked_weeks", "booking_count", "people_booked")
PROJECT = ("project_count", "project_weeks", "project_volume")
PHASE = ("phase_count", "phase_weeks")
PROJECT_KINDS = {
    "site",
    "project_team",
    "project",
    "project_manager",
    "customer",
    "confirmed",
    "tag",
    "field",
    "period",
}


def test_committed_metric_matrix_file_is_up_to_date():
    if not MATRIX_FILE.parent.exists():
        pytest.skip("shared/ is not part of this checkout")
    assert MATRIX_FILE.read_text() == metric_matrix_json(), (
        "shared/metric-matrix.json is stale; regenerate it with: python -c "
        '"from app.services.metrics import metric_matrix_json; '
        "open('shared/metric-matrix.json', 'w').write(metric_matrix_json())\""
    )


def test_the_matrix_covers_every_measure():
    assert set(MATRIX) == set(MEASURES) == set(UNITS) == set(MEASURE_LABELS)
    assert set(BOOKING + PROJECT + PHASE) == set(MEASURES)


def test_every_measure_has_a_family_in_family_order():
    assert set(FAMILY) == set(MEASURES) | INTERNAL_MEASURES
    assert set(FAMILY.values()) <= set(FAMILIES)
    assert not INTERNAL_MEASURES & set(MEASURES)
    order = [FAMILIES.index(FAMILY[measure]) for measure in MEASURES]
    assert order == sorted(order)
    assert {FAMILY[m] for m in BOOKING} == {"booking"}
    assert {FAMILY[m] for m in PROJECT} == {"project"}
    assert {FAMILY[m] for m in PHASE} == {"phase"}
    for measure, bases in COMPOSITES.items():
        assert measure in MEASURES and all(base in FAMILY for base in bases)


def test_the_schema_literals_spell_the_engine_tuples():
    assert get_args(Measure) == MEASURES
    assert get_args(PlainKind) == PLAIN_DIMENSION_KINDS
    assert get_args(RelativeName) == RELATIVE_PERIODS
    assert set(PERIOD_LABELS) == set(RELATIVE_PERIODS)


def test_filters_per_family():
    assert set(FILTER_KEYS) == set(MetricFilters.model_fields) == set(FILTER_LABELS)
    project = {
        "site_ids",
        "project_team_ids",
        "project_ids",
        "project_manager_ids",
        "tag_ids",
        "confirmed",
        "field_options",
        "archived",
        "period",
    }
    for measure in BOOKING:
        assert MEASURE_FILTERS[measure] == project | {"team_ids", "person_ids"}
    for measure in PROJECT:
        assert MEASURE_FILTERS[measure] == project
    for measure in PHASE:
        assert MEASURE_FILTERS[measure] == project | {"milestones"}
    for measure in MEASURES:
        assert {"archived", "period"} <= MEASURE_FILTERS[measure] <= set(FILTER_KEYS)


@pytest.mark.parametrize("measure", BOOKING)
def test_booking_measures_accept_every_kind_but_people_by_period(measure):
    expected = set(DIMENSION_KINDS) - ({"period"} if measure == "people_booked" else set())
    assert MATRIX[measure] == expected


@pytest.mark.parametrize("measure", PROJECT)
def test_project_measures(measure):
    expected = PROJECT_KINDS - ({"period"} if measure == "project_volume" else set())
    assert MATRIX[measure] == expected


@pytest.mark.parametrize("measure", PHASE)
def test_phase_measures(measure):
    assert MATRIX[measure] == PROJECT_KINDS | {"phase_type"}


def test_needs_name_catalogue_keys():
    assert NEEDS == {"person": "views.staff"}
    assert MEASURE_NEEDS == {"capacity": "views.staff", "equipment": "views.equipment"}
    assert FILTER_NEEDS == {
        "person_ids": "views.staff",
        "equipment_ids": "views.equipment",
        "equipment_types": "views.equipment",
    }
    keys = {*NEEDS.values(), *MEASURE_NEEDS.values(), *FILTER_NEEDS.values(), ARCHIVED_NEEDS}
    assert keys <= PERMISSION_KEYS
    assert keys == set(VIEWER_KEYS) == set(PERMISSION_NAMES)
    assert set(MEASURE_NEEDS) <= set(FAMILIES)
    assert set(NEEDS) <= set(DIMENSION_KINDS)
    assert set(FILTER_NEEDS) <= set(FILTER_KEYS)


def test_the_json_carries_needs_filters_and_periods():
    data = json.loads(metric_matrix_json())
    assert list(data["measures"]) == list(MEASURES)
    for measure, entry in data["measures"].items():
        assert entry["needs"] == MEASURE_NEEDS.get(FAMILY[measure])
        assert entry["filters"] == sorted(MEASURE_FILTERS[measure])
        assert entry["unit"] == UNITS[measure]
    assert data["needs"] == {**NEEDS, **FILTER_NEEDS, "archived": ARCHIVED_NEEDS}
    assert data["no_percent"] == sorted(NO_PERCENT_MEASURES)
    assert data["relative_periods"] == list(RELATIVE_PERIODS)
    assert not INTERNAL_MEASURES & set(data["measures"])


@pytest.mark.parametrize("measure", MEASURES)
@pytest.mark.parametrize("kind", [k for k in DIMENSION_KINDS if k not in ("field", "period")])
def test_the_schema_enforces_the_matrix(measure, kind):
    body = {"measure": measure, "dimensions": [{"kind": kind}]}
    if kind in MATRIX[measure]:
        MetricQuery.model_validate(body)
        assert matrix_error(measure, kind) is None
    else:
        with pytest.raises(ValidationError) as caught:
            MetricQuery.model_validate(body)
        assert caught.value.errors()[0]["msg"] == matrix_error(measure, kind)


def test_matrix_message_in_plain_words():
    assert (
        matrix_error("people_booked", "period") == "People booked cannot be broken down by period"
    )
    assert matrix_error("project_count", "person") == "Projects cannot be broken down by person"
