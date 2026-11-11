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
    DIMENSION_LABELS,
    FAMILIES,
    FAMILY,
    FAMILY_DIMENSION_NEEDS,
    FAMILY_FILTER_NEEDS,
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
PHASE = ("phase_count", "phase_weeks", "phases_due", "phases_overdue")
CAPACITY = (
    "capacity_days",
    "capacity_weeks",
    "available_days",
    "utilisation",
    "people_over_capacity",
)
EQUIPMENT = (
    "equipment_booked_days",
    "equipment_booking_count",
    "equipment_booked",
    "equipment_utilisation",
)
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
    assert set(BOOKING + PROJECT + PHASE + CAPACITY + EQUIPMENT) == set(MEASURES)
    assert not INTERNAL_MEASURES & (set(UNITS) | set(MATRIX) | set(MEASURE_LABELS))


def test_every_measure_has_a_family_in_family_order():
    assert set(FAMILY) == set(MEASURES) | INTERNAL_MEASURES
    assert set(FAMILY.values()) <= set(FAMILIES)
    assert not INTERNAL_MEASURES & set(MEASURES)
    order = [FAMILIES.index(FAMILY[measure]) for measure in MEASURES]
    assert order == sorted(order)
    assert {FAMILY[m] for m in BOOKING} == {"booking"}
    assert {FAMILY[m] for m in PROJECT} == {"project"}
    assert {FAMILY[m] for m in PHASE} == {"phase"}
    assert {FAMILY[m] for m in CAPACITY} == {"capacity"}
    assert {FAMILY[m] for m in EQUIPMENT} == {"equipment"}
    assert MEASURES[11:16] == CAPACITY  # after the phase measures
    assert MEASURES[16:] == EQUIPMENT  # last
    assert INTERNAL_MEASURES == {"equipment_available_days"}
    assert FAMILY["equipment_available_days"] == "equipment"
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
        "has_customer",
    }
    for measure in BOOKING:
        assert MEASURE_FILTERS[measure] == project | {"team_ids", "person_ids"}
    for measure in PROJECT:
        assert MEASURE_FILTERS[measure] == project
    for measure in PHASE:
        assert MEASURE_FILTERS[measure] == project | {"milestones"}
    capacity = {"site_ids", "team_ids", "person_ids", "archived", "period"}
    for measure in ("capacity_days", "available_days", "people_over_capacity"):
        assert MEASURE_FILTERS[measure] == capacity
    # Utilisation's project filters narrow its booked side (the site stays the person's).
    assert MEASURE_FILTERS["utilisation"] == capacity | (project - {"site_ids"})
    for measure in EQUIPMENT[:3]:
        assert MEASURE_FILTERS[measure] == project | {"equipment_ids", "equipment_types"}
    # Utilisation is the equipment's: its sites, the equipment, its type.
    assert MEASURE_FILTERS["equipment_utilisation"] == {
        "site_ids",
        "equipment_ids",
        "equipment_types",
        "archived",
        "period",
    }
    assert set(MEASURE_FILTERS) == set(MEASURES)
    for measure in MEASURES:
        assert {"archived", "period"} <= MEASURE_FILTERS[measure] <= set(FILTER_KEYS)


@pytest.mark.parametrize("measure", BOOKING)
def test_booking_measures_accept_every_kind_but_people_by_period(measure):
    # Every kind but the phase status and the equipment's (people_booked:
    # nor the period).
    expected = set(DIMENSION_KINDS) - {"status", "equipment", "equipment_type"}
    expected -= {"period"} if measure == "people_booked" else set()
    assert MATRIX[measure] == expected


@pytest.mark.parametrize("measure", PROJECT)
def test_project_measures(measure):
    expected = PROJECT_KINDS - ({"period"} if measure == "project_volume" else set())
    assert MATRIX[measure] == expected


@pytest.mark.parametrize("measure", PHASE)
def test_phase_measures(measure):
    assert MATRIX[measure] == PROJECT_KINDS | {"phase_type", "status"}


@pytest.mark.parametrize("measure", CAPACITY)
def test_capacity_measures(measure):
    # The person's breakdowns, per period bucket too.
    assert MATRIX[measure] == {"person", "team", "site", "period"}


@pytest.mark.parametrize("measure", EQUIPMENT[:3])
def test_equipment_booking_measures(measure):
    # The project's breakdowns and the equipment's (equipment_booked: no period).
    expected = PROJECT_KINDS | {"equipment", "equipment_type"}
    expected -= {"period"} if measure == "equipment_booked" else set()
    assert MATRIX[measure] == expected


def test_equipment_utilisation_matrix():
    assert MATRIX["equipment_utilisation"] == {"equipment", "equipment_type", "site", "period"}


def test_equipment_measure_kinds():
    from app.services.metrics import (
        ADDITIVE_MEASURES,
        COMPOSITE_RULES,
        COUNT_MEASURES,
        DIMENSION_LABELS,
        EMPTY_LABELS,
        EQUIPMENT_SIDE_MEASURES,
        FLOAT_MEASURES,
        percent_error,
    )

    assert {"equipment_booked_days", "equipment_available_days"} <= ADDITIVE_MEASURES
    assert {"equipment_booking_count", "equipment_booked"} <= COUNT_MEASURES
    assert COMPOSITES["equipment_utilisation"] == (
        "equipment_booked_days",
        "equipment_available_days",
    )
    assert "equipment_utilisation" in COMPOSITE_RULES
    assert EQUIPMENT_SIDE_MEASURES == {"equipment_utilisation"}
    assert "equipment_utilisation" in NO_PERCENT_MEASURES & FLOAT_MEASURES
    assert NO_PERCENT_MEASURES == {
        "utilisation",
        "equipment_utilisation",
        "available_days",
        "people_over_capacity",
    }
    assert percent_error("equipment_utilisation") == "Equipment utilisation is already a percentage"
    assert percent_error("equipment_booked_days") is None
    assert [UNITS[m] for m in EQUIPMENT] == ["days", "count", "equipment", "percent"]
    assert [MEASURE_LABELS[m] for m in EQUIPMENT] == [
        "Equipment booked days",
        "Equipment bookings",
        "Equipment booked",
        "Equipment utilisation",
    ]
    assert PLAIN_DIMENSION_KINDS[-2:] == ("equipment", "equipment_type")
    assert (DIMENSION_LABELS["equipment"], DIMENSION_LABELS["equipment_type"]) == (
        "Equipment",
        "Equipment type",
    )
    assert EMPTY_LABELS["equipment_type"] == "No type"


def test_capacity_measure_kinds():
    from app.services.metrics import (
        ADDITIVE_MEASURES,
        COMPOSITE_RULES,
        FLOAT_MEASURES,
        NO_PERCENT_MESSAGES,
        percent_error,
    )

    assert "capacity_days" in ADDITIVE_MEASURES
    for measure in ("available_days", "utilisation", "people_over_capacity"):
        assert COMPOSITES[measure] == ("booked_days", "capacity_days")
        assert measure in COMPOSITE_RULES
    assert {"utilisation", "available_days"} <= NO_PERCENT_MEASURES
    assert {"utilisation", "available_days"} <= FLOAT_MEASURES
    # A count, so no decimals; counted per bucket, so no percentage.
    assert "people_over_capacity" not in FLOAT_MEASURES
    assert "people_over_capacity" in NO_PERCENT_MEASURES
    assert percent_error("utilisation") == "Utilisation is already a percentage"
    assert percent_error("available_days") == NO_PERCENT_MESSAGES["available_days"]
    assert percent_error("capacity_days") is None
    assert (UNITS["capacity_days"], UNITS["utilisation"], UNITS["people_over_capacity"]) == (
        "days",
        "percent",
        "people",
    )
    assert MEASURE_LABELS["capacity_days"] == "Capacity (days)"


def test_needs_name_catalogue_keys():
    assert NEEDS == {
        "person": "views.staff",
        "equipment": "views.equipment",
        "equipment_type": "views.equipment",
    }
    assert MEASURE_NEEDS == {"capacity": "views.staff", "equipment": "views.equipment"}
    assert FILTER_NEEDS == {
        "person_ids": "views.staff",
        "equipment_ids": "views.equipment",
        "equipment_types": "views.equipment",
    }
    # A capacity per person shows the person's absence days.
    assert FAMILY_DIMENSION_NEEDS == {("capacity", "person"): "absences.view_others"}
    assert FAMILY_FILTER_NEEDS == {("capacity", "person_ids"): "absences.view_others"}
    keys = {
        *NEEDS.values(),
        *MEASURE_NEEDS.values(),
        *FILTER_NEEDS.values(),
        *FAMILY_DIMENSION_NEEDS.values(),
        *FAMILY_FILTER_NEEDS.values(),
        ARCHIVED_NEEDS,
    }
    assert keys <= PERMISSION_KEYS
    assert keys == set(VIEWER_KEYS) == set(PERMISSION_NAMES)
    assert set(MEASURE_NEEDS) <= set(FAMILIES)
    assert set(NEEDS) <= set(DIMENSION_KINDS)
    assert set(FILTER_NEEDS) <= set(FILTER_KEYS)
    for family, kind in FAMILY_DIMENSION_NEEDS:
        assert family in FAMILIES and kind in DIMENSION_KINDS
        # The common need of the kind is the family's own measure need (the
        # client asks the family-specific key in place of the common one).
        assert NEEDS.get(kind) in (None, MEASURE_NEEDS.get(family))
    for family, key in FAMILY_FILTER_NEEDS:
        assert family in FAMILIES and key in FILTER_KEYS
        assert FILTER_NEEDS.get(key) in (None, MEASURE_NEEDS.get(family))


def test_the_json_carries_needs_filters_and_periods():
    data = json.loads(metric_matrix_json())
    assert list(data["measures"]) == list(MEASURES)
    for measure, entry in data["measures"].items():
        assert entry["needs"] == MEASURE_NEEDS.get(FAMILY[measure])
        assert entry["filters"] == sorted(MEASURE_FILTERS[measure])
        assert entry["unit"] == UNITS[measure]
        family = FAMILY[measure]
        expected_dimensions = {
            kind: key for (fam, kind), key in FAMILY_DIMENSION_NEEDS.items() if fam == family
        }
        expected_filters = {
            name: key for (fam, name), key in FAMILY_FILTER_NEEDS.items() if fam == family
        }
        assert entry["dimension_needs"] == expected_dimensions
        assert entry["filter_needs"] == expected_filters
    assert data["measures"]["utilisation"]["dimension_needs"] == {"person": "absences.view_others"}
    assert data["measures"]["utilisation"]["filter_needs"] == {"person_ids": "absences.view_others"}
    assert data["measures"]["booked_days"]["dimension_needs"] == {}
    # The names the frontend's lists must spell, in the server's order.
    assert data["measure_labels"] == {m: MEASURE_LABELS[m] for m in MEASURES}
    assert list(data["measure_labels"]) == list(MEASURES)
    assert data["dimension_labels"] == {k: DIMENSION_LABELS[k] for k in DIMENSION_KINDS}
    assert data["filter_labels"] == {k: FILTER_LABELS[k] for k in FILTER_KEYS}
    assert data["period_labels"] == {p: PERIOD_LABELS[p] for p in RELATIVE_PERIODS}
    assert list(data["period_labels"]) == list(RELATIVE_PERIODS)
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


def test_phase_statuses_follow_the_kanban_columns():
    from app.services.card_status import CARD_STATUSES
    from app.services.metrics import PHASE_STATUS_LABELS, PHASE_STATUSES

    assert PHASE_STATUSES == CARD_STATUSES == tuple(PHASE_STATUS_LABELS)
    assert MEASURE_LABELS["phases_due"] == "Phases due"
    assert MEASURE_LABELS["phases_overdue"] == "Phases overdue"


def test_matrix_message_in_plain_words():
    assert (
        matrix_error("people_booked", "period") == "People booked cannot be broken down by period"
    )
    assert matrix_error("project_count", "person") == "Projects cannot be broken down by person"


def test_term_measures_are_the_summed_and_counted_ones():
    from app.services.metrics import MAX_FORMULA_TERMS, TERM_MEASURES, term_error

    assert TERM_MEASURES == set(MEASURES) - set(COMPOSITES)
    assert "capacity_weeks" in TERM_MEASURES
    assert not TERM_MEASURES & INTERNAL_MEASURES
    assert term_error("booked_days") is None
    assert term_error("utilisation") == (
        "Utilisation cannot be a term of a calculation: choose a summed or counted measure"
    )
    data = json.loads(metric_matrix_json())
    assert data["term_measures"] == sorted(TERM_MEASURES)
    assert data["formula"] == {
        "max_terms": MAX_FORMULA_TERMS,
        "max_length": 200,
        "results": ["percent", "number"],
    }


def test_capacity_weeks_is_a_capacity_measure_in_weeks():
    assert FAMILY["capacity_weeks"] == "capacity"
    assert UNITS["capacity_weeks"] == "weeks"
    assert MEASURE_LABELS["capacity_weeks"] == "Capacity (weeks)"
    assert MATRIX["capacity_weeks"] == MATRIX["capacity_days"]
    assert MEASURE_FILTERS["capacity_weeks"] == MEASURE_FILTERS["capacity_days"]


def test_has_customer_filter_is_labelled_and_needs_nothing():
    assert FILTER_LABELS["has_customer"] == "Has a customer"
    assert FILTER_KEYS[-1] == "has_customer"
    assert "has_customer" not in FILTER_NEEDS
    assert all(key != "has_customer" for _, key in FAMILY_FILTER_NEEDS)
