"""
The validity matrix (``metrics.MATRIX``) and its frontend mirror.

``shared/metric-matrix.json`` is generated from ``metrics.metric_matrix_json()``;
the frontend's hand-written matrix is checked against the file.
"""

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas.dashboard import MetricQuery
from app.services.metrics import (
    ARCHIVED_NEEDS,
    DIMENSION_KINDS,
    MATRIX,
    MEASURES,
    NEEDS,
    UNITS,
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
    assert set(MATRIX) == set(MEASURES) == set(UNITS)
    assert set(BOOKING + PROJECT + PHASE) == set(MEASURES)


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
    assert {*NEEDS.values(), ARCHIVED_NEEDS} <= PERMISSION_KEYS


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
