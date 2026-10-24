"""
The dashboards' metric engine (2.1.0): facts, working days, aggregation.

A dashboard widget asks one *metric query* (``app/schemas/dashboard.py``
``MetricQuery``): a measure, up to two dimensions, filters, a period, and
optionally a percentage and a top N. The engine answers it in Python over one
bulk load of *facts* per request:

- ``load_facts`` reads the projects, phases and approved staff bookings at the
  caller's visible sites for one period, with the bank holidays of the sites
  involved, the teams of the booked people and the reference data (sites,
  teams, people, tags, project fields and their items) used for labels,
  colours and stale-id warnings. A booking's dates are its effective dates
  (``booking_segments.effective_dates``) **clipped to its card**; pending
  bookings are left out; absences and closures do not subtract from booked
  time (they reduce a person's capacity, see below).
- ``aggregate`` is pure: it applies the query's own period and filters to the
  facts, splits them into the dimension values, and computes the measure.
  ``/dashboards/{id}/data`` loads the facts once for the union of its widgets'
  periods and aggregates every widget from them.

Every measure belongs to a **family** (``FAMILY``: ``booking``, ``project``,
``phase``, then ``capacity`` and ``equipment``) that decides the facts it
reads, the permission it needs (``MEASURE_NEEDS``) and the filters it accepts
(``MEASURE_FILTERS``; another given filter is a 422). A **composite** measure
(``COMPOSITES``) is a numerator and a denominator base measure: the item loop
runs once per side and ``_combine_composite`` folds the two sums.

Rules (see ``tests/test_metrics.py`` ``FACT_CASES``):

- **Working day** = Monday to Friday, not a bank holiday of the *project's*
  site (multi-day holidays count every weekday they cover); a site-less
  project only skips weekends. Counted arithmetically, never by expanding days.
- ``booked_days`` = sum of allocation / 100 x working days of (booking span x
  period x bucket); ``booked_weeks`` = that / 5. ``project_weeks`` /
  ``phase_weeks`` prorate the project's / phase's span the same way (no
  allocation). ``project_count`` counts a project in every period bucket its
  span touches; ``project_volume`` adds each project's volume once.
- ``phases_due`` counts each phase (a milestone: its date) once, in the bucket
  of its end date inside the period; ``phases_overdue`` the same, restricted
  to phases due before today and not ``done``. The ``milestones`` filter
  (``include`` / ``only`` / ``exclude``) applies to every phase measure.
- The **capacity** family (``views.staff``): ``capacity_days`` = sum over the
  bookable people (active, *Bookable as a resource*, members of a visible
  site) of max_capacity / 100 x (weekdays - their off days) of (period x
  bucket); off days are bank holidays at any of their sites, unavailable
  absences (``[R:...]`` ones on their pattern days only) and the site
  closures that apply to them. ``utilisation`` = booked days / capacity days x
  100 (None when booked time meets no capacity), ``available_days`` =
  capacity - booked, ``people_over_capacity`` = the people whose own booked
  days exceed their capacity in the group. The booked side counts only the
  bookings of people with a capacity, keeps the project-site calendar and the
  ``archived`` filter, and reads ``site`` / ``team`` / ``person`` (dimensions
  and filters) from the person, like the capacity side.
- The **equipment** family (``views.equipment``): ``equipment_booked_days``
  = working days of the *project's* site of each equipment booking (whole
  days, no allocation); ``equipment_booking_count`` / ``equipment_booked``
  count bookings / distinct equipment; ``equipment_utilisation`` = booked
  days / available days x 100, where an active equipment of a visible site
  (any active equipment when every site is visible) is available on the
  weekdays that are not a bank holiday at one of its sites nor inside one of
  its blocks. Overlapping bookings add up, so a double-booked instrument
  reads over 100 %. Utilisation counts only the bookings of equipment with
  an availability and reads ``site`` (dimension and filter) from the
  equipment on both sides; the booking measures keep the project's site.
- The **distinct** measures (``booking_count``, ``people_booked``,
  ``project_count``, ``project_volume``, ``phase_count``, ``phases_due``,
  ``phases_overdue``, ``equipment_booking_count``, ``equipment_booked``)
  recompute the total,
  the "Other" bucket and the percentage denominators over distinct facts: a
  project with two tags counts in both tag rows but once in the total.
  Additive measures do the same with the fact's amount (a booking in two teams
  adds its days to both team rows, once to the total).
- Multi-valued dimensions (``tag``, ``team``, ``project_team``, a
  multiselect ``field``) count a fact in each value and set ``note``.
- Stale ids in a stored query's filters are dropped with a warning; a deleted
  project field used as a dimension is an error (``MetricError``).

The **validity matrix** (``MATRIX``: which dimensions each measure accepts,
with ``MEASURE_FILTERS``, the needs and ``NO_PERCENT_MEASURES``) lives here
and is the one source: the pydantic spec enforces it and
``metric_matrix_json()`` writes ``shared/metric-matrix.json`` for the frontend
(``tests/test_metric_matrix.py`` fails when the file is stale).

Import-light: no routers, no request objects; the models are imported inside
the loader only, so the schemas can import the constants cheaply.
"""

from __future__ import annotations

import json
from bisect import bisect_left, bisect_right
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from itertools import product
from typing import TYPE_CHECKING, Any, NamedTuple

from app.services.absence_patterns import absence_weekdays, parse_recurring_days
from app.services.booking_segments import effective_dates
from app.services.card_status import CARD_STATUSES

if TYPE_CHECKING:
    from sqlalchemy import ColumnElement
    from sqlalchemy.ext.asyncio import AsyncSession

# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

# Measure families: which facts a measure counts. ``booking`` = approved
# staff bookings, ``project`` = projects, ``phase`` = top-level phases,
# ``capacity`` = bookable people's capacity (round 3, Task 2), ``equipment`` =
# equipment bookings and availability (round 3, Task 3).
FAMILIES: tuple[str, ...] = ("booking", "project", "phase", "capacity", "equipment")

# The public measures, in family order (the builder lists them grouped).
MEASURES: tuple[str, ...] = (
    # booking
    "booked_days",
    "booked_weeks",
    "booking_count",
    "people_booked",
    # project
    "project_count",
    "project_weeks",
    "project_volume",
    # phase (delivery: phases due / overdue by their end date)
    "phase_count",
    "phase_weeks",
    "phases_due",
    "phases_overdue",
    # capacity (bookable people's working days against their bookings)
    "capacity_days",
    "available_days",
    "utilisation",
    "people_over_capacity",
    # equipment (equipment bookings against the equipment's working days)
    "equipment_booked_days",
    "equipment_booking_count",
    "equipment_booked",
    "equipment_utilisation",
)
# Base measures a composite is built from that are never offered on their
# own: not in ``MEASURES``, ``UNITS``, ``MATRIX``, the schema Literal or the
# JSON mirror. They still need a ``FAMILY`` entry and an ``_amount`` branch.
INTERNAL_MEASURES: frozenset[str] = frozenset({"equipment_available_days"})

# measure -> family, for every public and internal measure.
FAMILY: dict[str, str] = {
    "booked_days": "booking",
    "booked_weeks": "booking",
    "booking_count": "booking",
    "people_booked": "booking",
    "project_count": "project",
    "project_weeks": "project",
    "project_volume": "project",
    "phase_count": "phase",
    "phase_weeks": "phase",
    "phases_due": "phase",
    "phases_overdue": "phase",
    "capacity_days": "capacity",
    "available_days": "capacity",
    "utilisation": "capacity",
    "people_over_capacity": "capacity",
    "equipment_booked_days": "equipment",
    "equipment_booking_count": "equipment",
    "equipment_booked": "equipment",
    "equipment_utilisation": "equipment",
    "equipment_available_days": "equipment",
}

PLAIN_DIMENSION_KINDS: tuple[str, ...] = (
    "site",
    "team",
    "project_team",
    "person",
    "project",
    "project_manager",
    "customer",
    "confirmed",
    "tag",
    "phase_type",
    "status",
    "equipment",
    "equipment_type",
)
DIMENSION_KINDS: tuple[str, ...] = (*PLAIN_DIMENSION_KINDS, "field", "period")
RELATIVE_PERIODS: tuple[str, ...] = (
    "this_year",
    "last_year",
    "next_year",
    "this_quarter",
    "last_quarter",
    "next_quarter",
    "this_month",
    "last_month",
    "next_month",
    "last_12_months",
    "next_12_months",
    "all",
)
PERIOD_LABELS: dict[str, str] = {
    "this_year": "This year",
    "last_year": "Last year",
    "next_year": "Next year",
    "this_quarter": "This quarter",
    "last_quarter": "Last quarter",
    "next_quarter": "Next quarter",
    "this_month": "This month",
    "last_month": "Last month",
    "next_month": "Next month",
    "last_12_months": "Last 12 months",
    "next_12_months": "Next 12 months",
    "all": "All time",
}
GRAINS: tuple[str, ...] = ("year", "quarter", "month", "week")
ARCHIVED_MODES: tuple[str, ...] = ("exclude", "include", "only")
MILESTONE_MODES: tuple[str, ...] = ("include", "only", "exclude")

# A period covers at most five years (inclusive days).
MAX_PERIOD_DAYS = 1826
PERIOD_TOO_LONG_DETAIL = "A period can cover at most five years"
# Soft cap on the booking rows one request loads.
MAX_FACT_ROWS = 200_000
TOO_MANY_FACTS_DETAIL = "Narrow the filters: this query covers too many bookings"

# Summed amounts, deduplicated per fact and bucket.
ADDITIVE_MEASURES: frozenset[str] = frozenset(
    {
        "booked_days",
        "booked_weeks",
        "project_weeks",
        "phase_weeks",
        "capacity_days",
        "equipment_booked_days",
        "equipment_available_days",
    }
)
# Counts of distinct things (``_ident``); ``project_volume`` sums one amount
# per distinct project.
COUNT_MEASURES: frozenset[str] = frozenset(
    {
        "booking_count",
        "people_booked",
        "project_count",
        "phase_count",
        "phases_due",
        "phases_overdue",
        "equipment_booking_count",
        "equipment_booked",
    }
)
# Composite measures: ``measure -> (numerator base, denominator base)``. The
# engine runs the item loop once per side with that side's base measure and
# ``_combine_composite`` folds the two sums with ``COMPOSITE_RULES[measure]``.
COMPOSITES: dict[str, tuple[str, str]] = {
    "available_days": ("booked_days", "capacity_days"),
    "utilisation": ("booked_days", "capacity_days"),
    "people_over_capacity": ("booked_days", "capacity_days"),
    "equipment_utilisation": ("equipment_booked_days", "equipment_available_days"),
}
# The composites whose two sides read sites and filters from the equipment
# (a booking's equipment on the numerator side), not from the project.
EQUIPMENT_SIDE_MEASURES: frozenset[str] = frozenset({"equipment_utilisation"})
# Measures that are already a percentage (or cannot be one): ``percent_of``
# on them is refused (``percent_error``).
NO_PERCENT_MEASURES: frozenset[str] = frozenset(
    {"utilisation", "equipment_utilisation", "available_days"}
)
# The refusal of ``percent_of`` per measure when the default wording does not fit.
NO_PERCENT_MESSAGES: dict[str, str] = {
    "available_days": "Available days can be negative and cannot be a percentage",
}
# Non-additive measures that keep two decimals (ratios) instead of an int.
FLOAT_MEASURES: frozenset[str] = frozenset(
    {"utilisation", "equipment_utilisation", "available_days"}
)

UNITS: dict[str, str] = {
    "booked_days": "days",
    "booked_weeks": "weeks",
    "booking_count": "count",
    "people_booked": "people",
    "project_count": "projects",
    "project_weeks": "weeks",
    "project_volume": "volume",
    "phase_count": "phases",
    "phase_weeks": "weeks",
    "phases_due": "phases",
    "phases_overdue": "phases",
    "capacity_days": "days",
    "available_days": "days",
    "utilisation": "percent",
    "people_over_capacity": "people",
    "equipment_booked_days": "days",
    "equipment_booking_count": "count",
    "equipment_booked": "equipment",
    "equipment_utilisation": "percent",
}
PERCENT_UNIT = "percent"

MEASURE_LABELS: dict[str, str] = {
    "booked_days": "Booked days",
    "booked_weeks": "Booked weeks",
    "booking_count": "Bookings",
    "people_booked": "People booked",
    "project_count": "Projects",
    "project_weeks": "Project weeks",
    "project_volume": "Project volume",
    "phase_count": "Phases",
    "phase_weeks": "Phase weeks",
    "phases_due": "Phases due",
    "phases_overdue": "Phases overdue",
    "capacity_days": "Capacity (days)",
    "available_days": "Available days",
    "utilisation": "Utilisation",
    "people_over_capacity": "People over capacity",
    "equipment_booked_days": "Equipment booked days",
    "equipment_booking_count": "Equipment bookings",
    "equipment_booked": "Equipment booked",
    "equipment_utilisation": "Equipment utilisation",
}
DIMENSION_LABELS: dict[str, str] = {
    "site": "Site",
    "team": "Team",
    "project_team": "Project team",
    "person": "Person",
    "project": "Project",
    "project_manager": "Project manager",
    "customer": "Customer",
    "confirmed": "Confirmed",
    "tag": "Tag",
    "phase_type": "Phase",
    "status": "Status",
    "equipment": "Equipment",
    "equipment_type": "Equipment type",
    "field": "Project field",
    "period": "Period",
}
# A phase's Kanban column (``project_phases.status``), in board order.
PHASE_STATUSES: tuple[str, ...] = CARD_STATUSES
PHASE_STATUS_LABELS: dict[str, str] = {
    "todo": "To do",
    "in_progress": "In progress",
    "blocked": "Blocked",
    "done": "Done",
}
GRAIN_LABELS: dict[str, str] = {
    "year": "Year",
    "quarter": "Quarter",
    "month": "Month",
    "week": "Week",
}

# --- Filters per measure ---------------------------------------------------

# Every filter key of ``MetricFilters``, in the order refusals check them.
FILTER_KEYS: tuple[str, ...] = (
    "site_ids",
    "team_ids",
    "project_team_ids",
    "person_ids",
    "project_ids",
    "project_manager_ids",
    "tag_ids",
    "confirmed",
    "field_options",
    "archived",
    "period",
    "equipment_ids",
    "equipment_types",
    "milestones",
)
FILTER_LABELS: dict[str, str] = {
    "site_ids": "Sites",
    "team_ids": "Teams",
    "project_team_ids": "Project teams",
    "person_ids": "People",
    "project_ids": "Projects",
    "project_manager_ids": "Project managers",
    "tag_ids": "Tags",
    "confirmed": "Confirmed",
    "field_options": "Project fields",
    "archived": "Archived",
    "period": "Period",
    "equipment_ids": "Equipment",
    "equipment_types": "Equipment types",
    "milestones": "Milestones",
}
# The value of a filter that is no filter (lists and ``confirmed``: None or
# empty). ``period`` always applies and is never refused.
FILTER_DEFAULTS: dict[str, Any] = {"archived": "exclude", "milestones": "include"}

_PROJECT_FILTERS: frozenset[str] = frozenset(
    {
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
)
FAMILY_FILTERS: dict[str, frozenset[str]] = {
    # The person's teams and the person exist only on a booking.
    "booking": _PROJECT_FILTERS | {"team_ids", "person_ids"},
    "project": _PROJECT_FILTERS,
    "phase": _PROJECT_FILTERS | {"milestones"},
    "capacity": frozenset({"site_ids", "team_ids", "person_ids", "archived", "period"}),
    "equipment": _PROJECT_FILTERS | {"equipment_ids", "equipment_types"},
}
# A measure whose filters differ from its family's: equipment utilisation is
# the equipment's (its sites, the equipment, its type), with the archived
# test on the booked side.
MEASURE_FILTER_OVERRIDES: dict[str, frozenset[str]] = {
    "equipment_utilisation": frozenset(
        {"site_ids", "equipment_ids", "equipment_types", "archived", "period"}
    ),
}
# measure -> the filters it accepts (a given filter outside it is a 422).
MEASURE_FILTERS: dict[str, frozenset[str]] = {
    measure: MEASURE_FILTER_OVERRIDES.get(measure, FAMILY_FILTERS[FAMILY[measure]])
    for measure in MEASURES
}


def filter_given(filters: Any, key: str) -> bool:
    """Whether ``filters`` (a ``MetricFilters``) sets ``key`` to a non-default value."""
    if key == "period":
        return True
    value = getattr(filters, key, None)
    if key in FILTER_DEFAULTS:
        return bool(value != FILTER_DEFAULTS[key])
    return value is not None and value != [] and value != {}


def filter_error(measure: str, key: str) -> str | None:
    """The refusal of filter ``key`` on ``measure``, or None when it applies."""
    if key == "period" or key in MEASURE_FILTERS[measure]:
        return None
    return f"The {FILTER_LABELS[key]} filter does not apply to {MEASURE_LABELS[measure].lower()}"


def percent_error(measure: str) -> str | None:
    """The refusal of ``percent_of`` on ``measure``, or None when it may be a percentage."""
    if measure not in NO_PERCENT_MEASURES:
        return None
    return NO_PERCENT_MESSAGES.get(measure, f"{MEASURE_LABELS[measure]} is already a percentage")


def measure_families(measure: str) -> tuple[str, ...]:
    """The families whose facts ``measure`` reads: its own, then a composite's bases'."""
    families = [FAMILY[measure]]
    for base in COMPOSITES.get(measure, ()):
        if FAMILY[base] not in families:
            families.append(FAMILY[base])
    return tuple(families)


# --- The validity matrix ---------------------------------------------------

_PROJECT_DIMENSIONS: frozenset[str] = frozenset(
    {
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
)
_BOOKING_DIMENSIONS: frozenset[str] = _PROJECT_DIMENSIONS | {"team", "person", "phase_type"}
_PHASE_DIMENSIONS: frozenset[str] = _PROJECT_DIMENSIONS | {"phase_type", "status"}
# A capacity is a person's: no project dimension applies (``site`` and
# ``team`` are the person's, on both sides of a composite).
_CAPACITY_DIMENSIONS: frozenset[str] = frozenset({"person", "team", "site", "period"})
# An equipment booking: its project's breakdowns (``site`` = the project's)
# and its equipment's.
_EQUIPMENT_BOOKING_DIMENSIONS: frozenset[str] = _PROJECT_DIMENSIONS | {
    "equipment",
    "equipment_type",
}

MATRIX: dict[str, frozenset[str]] = {
    "booked_days": _BOOKING_DIMENSIONS,
    "booked_weeks": _BOOKING_DIMENSIONS,
    "booking_count": _BOOKING_DIMENSIONS,
    # Distinct people are not additive over time.
    "people_booked": _BOOKING_DIMENSIONS - {"period"},
    "project_count": _PROJECT_DIMENSIONS,
    "project_weeks": _PROJECT_DIMENSIONS,
    # A volume is not spread over time.
    "project_volume": _PROJECT_DIMENSIONS - {"period"},
    "phase_count": _PHASE_DIMENSIONS,
    "phase_weeks": _PHASE_DIMENSIONS,
    "phases_due": _PHASE_DIMENSIONS,
    "phases_overdue": _PHASE_DIMENSIONS,
    # Per bucket: utilisation and people over capacity are computed in each.
    "capacity_days": _CAPACITY_DIMENSIONS,
    "available_days": _CAPACITY_DIMENSIONS,
    "utilisation": _CAPACITY_DIMENSIONS,
    "people_over_capacity": _CAPACITY_DIMENSIONS,
    "equipment_booked_days": _EQUIPMENT_BOOKING_DIMENSIONS,
    "equipment_booking_count": _EQUIPMENT_BOOKING_DIMENSIONS,
    # Distinct equipment is not additive over time.
    "equipment_booked": _EQUIPMENT_BOOKING_DIMENSIONS - {"period"},
    # The equipment's breakdowns only (``site`` = the equipment's sites).
    "equipment_utilisation": frozenset({"equipment", "equipment_type", "site", "period"}),
}
# The permission a dimension needs (the per-person load is gated by it).
NEEDS: dict[str, str] = {
    "person": "views.staff",
    "equipment": "views.equipment",
    "equipment_type": "views.equipment",
}
# The permission a measure family needs (keyed by family).
MEASURE_NEEDS: dict[str, str] = {"capacity": "views.staff", "equipment": "views.equipment"}
# The permission a given filter needs (a People filter rebuilds the
# per-person breakdown one id at a time).
FILTER_NEEDS: dict[str, str] = {
    "person_ids": "views.staff",
    "equipment_ids": "views.equipment",
    "equipment_types": "views.equipment",
}
# ``archived: include | only`` needs this key.
ARCHIVED_NEEDS = "views.archived"
PERMISSION_NAMES: dict[str, str] = {
    "views.staff": "Staff",
    "views.equipment": "Equipment",
    "views.archived": "Archived",
}
# The keys ``missing_permission`` may ask for (the router builds ``Viewer`` from them).
VIEWER_KEYS: tuple[str, ...] = ("views.staff", "views.equipment", "views.archived")


def matrix_error(measure: str, kind: str) -> str | None:
    """The plain-words refusal of ``measure`` x ``kind``, or None when valid."""
    if kind in MATRIX[measure]:
        return None
    return f"{MEASURE_LABELS[measure]} cannot be broken down by {DIMENSION_LABELS[kind].lower()}"


def metric_matrix_json() -> str:
    """
    The content of the committed ``shared/metric-matrix.json`` (frontend mirror).

    Per measure: its unit, the dimensions it accepts, the key its family needs
    (``null`` when none) and the filters it accepts. ``needs`` merges the keys
    dimensions need (``NEEDS``) and given filters need (``FILTER_NEEDS``, plus
    ``archived`` for ``include`` / ``only``) in one map, kind or filter key ->
    permission key: the two vocabularies share no name. ``no_percent`` lists
    the measures ``percent_of`` is refused on.
    """
    data: dict[str, Any] = {
        "measures": {
            measure: {
                "unit": UNITS[measure],
                "dimensions": sorted(MATRIX[measure]),
                "needs": MEASURE_NEEDS.get(FAMILY[measure]),
                "filters": sorted(MEASURE_FILTERS[measure]),
            }
            for measure in MEASURES
        },
        "needs": {**NEEDS, **FILTER_NEEDS, "archived": ARCHIVED_NEEDS},
        "no_percent": sorted(NO_PERCENT_MEASURES),
        "relative_periods": list(RELATIVE_PERIODS),
        "grains": list(GRAINS),
    }
    return json.dumps(data, indent=2) + "\n"


class MetricError(Exception):
    """A query that cannot be answered (422 on ``/query``, a widget ``error`` on ``/data``)."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class TooManyFacts(MetricError):
    """More than ``MAX_FACT_ROWS`` booking rows for one request."""

    def __init__(self) -> None:
        super().__init__(TOO_MANY_FACTS_DETAIL)


@dataclass(frozen=True)
class Viewer:
    """The view keys the caller holds beyond the visible sites (per-widget errors)."""

    keys: frozenset[str]

    def has(self, key: str) -> bool:
        return key in self.keys


def permission_message(key: str) -> str:
    return f"This widget needs the {PERMISSION_NAMES[key]} view permission"


def missing_permission(query: Any, viewer: Viewer) -> str | None:
    """
    The key ``query`` needs and ``viewer`` lacks, or None.

    Checked in order: the measure's families (``MEASURE_NEEDS``), each
    dimension (``NEEDS``), each given filter (``FILTER_NEEDS``), then the
    archived mode.
    """
    for family in measure_families(query.measure):
        needed = MEASURE_NEEDS.get(family)
        if needed is not None and not viewer.has(needed):
            return needed
    for dimension in query.dimensions:
        needed = NEEDS.get(dimension.kind)
        if needed is not None and not viewer.has(needed):
            return needed
    for key, needed in FILTER_NEEDS.items():
        if filter_given(query.filters, key) and not viewer.has(needed):
            return needed
    if query.filters.archived != "exclude" and not viewer.has(ARCHIVED_NEEDS):
        return ARCHIVED_NEEDS
    return None


# ---------------------------------------------------------------------------
# Facts
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProjectFact:
    id: int
    name: str
    site_id: int | None
    site_name: str | None
    archived: bool
    start: date
    end: date
    customer: str | None
    pm_id: int | None
    pm_name: str | None
    confirmed: bool
    volume: float | None
    team_ids: tuple[int, ...] = ()
    tag_ids: tuple[int, ...] = ()
    field_values: dict[int, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PhaseFact:
    id: int
    project_id: int
    type: str
    start: date
    end: date
    is_milestone: bool = False
    # The Kanban column (``todo`` / ``in_progress`` / ``blocked`` / ``done``).
    status: str = "todo"


@dataclass(frozen=True)
class BookingFact:
    """An approved staff booking, its dates clipped to its card."""

    id: int
    level: str  # "project" / "phase" / "subphase"
    project_id: int
    person_id: int
    person_name: str
    team_ids: tuple[int, ...]  # the person's teams at the project's site
    allocation: int
    start: date
    end: date
    # The type of the phase the booking sits in (a subphase's top phase);
    # None for project-level bookings.
    phase_type: str | None = None


@dataclass(frozen=True)
class CapacityFact:
    """
    A bookable person's capacity (the capacity family): an active user flagged
    *Bookable as a resource*, at their ``max_capacity`` %.

    ``site_ids`` are their live ``user_sites`` (not cut to the visible sites:
    the visible sites only decide who is loaded), ``team_ids`` every team they
    are in. ``off_days`` are the sorted weekdays of the loaded period they
    cannot work: a bank holiday at any of their sites, an unavailable absence
    (recurring ones on their pattern days only) or a site closure that
    applies to them (``closure_applies``).
    """

    person_id: int
    person_name: str
    site_ids: tuple[int, ...]
    team_ids: tuple[int, ...]
    max_capacity: int
    off_days: tuple[date, ...]


@dataclass(frozen=True)
class EquipmentInfo:
    """An equipment row (reference data: labels, types, stale-id warnings)."""

    id: int
    name: str
    type: str | None
    site_ids: tuple[int, ...]  # every linked site (``equipment_sites``), ascending
    active: bool


@dataclass(frozen=True)
class EquipmentBookingFact:
    """An equipment booking of a project in scope, overlapping the loaded period."""

    id: int
    project_id: int
    equipment_id: int
    start: date
    end: date


@dataclass(frozen=True)
class EquipmentAvailabilityFact:
    """
    The working days of an active equipment linked to a visible site (any
    active equipment, site-less included, when every site is visible).

    ``site_ids`` are all its sites (the visible sites only decide which
    equipment is loaded); ``off_days`` the sorted weekdays of the loaded
    period it is not available: a bank holiday at any of its sites, or a day
    inside one of its blocks (``equipment_off_days``).
    """

    equipment_id: int
    site_ids: tuple[int, ...]
    off_days: tuple[date, ...]


@dataclass(frozen=True)
class TeamInfo:
    id: int
    name: str
    color: str | None
    site_id: int | None


@dataclass(frozen=True)
class TagInfo:
    id: int
    name: str
    color: str | None
    sort_order: int = 0


@dataclass(frozen=True)
class FieldInfo:
    id: int
    name: str
    field_type: str
    sort_order: int = 0


@dataclass(frozen=True)
class OptionInfo:
    id: int
    field_id: int
    name: str
    color: str | None
    sort_order: int = 0


@dataclass
class Facts:
    projects: dict[int, ProjectFact]
    phases: list[PhaseFact]
    bookings: list[BookingFact]
    # site id -> sorted weekday holiday days (multi-day rows expanded)
    holidays: dict[int, list[date]]
    persons: dict[int, str]
    teams: dict[int, TeamInfo]
    fields: dict[int, FieldInfo]
    options: dict[int, OptionInfo]
    tags: dict[int, TagInfo]
    sites: dict[int, str]
    today: date
    # Every existing project id (stale-id warnings); None = those in ``projects``.
    project_ids: frozenset[int] | None = None
    # (min start, max end) of the projects in scope per archived mode, for
    # the ``all`` period (a mode absent or None: no project).
    extents: dict[str, tuple[date, date] | None] = field(default_factory=dict)
    # Loaded only for the families a request needs (``load_facts(families=)``).
    # person id -> capacity fact (the bookable people in scope).
    capacity: dict[int, CapacityFact] = field(default_factory=dict)
    # equipment id -> equipment info (every row: labels, stale-id warnings).
    equipment: dict[int, EquipmentInfo] = field(default_factory=dict)
    equipment_bookings: list[EquipmentBookingFact] = field(default_factory=list)
    equipment_availability: list[EquipmentAvailabilityFact] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Calendar
# ---------------------------------------------------------------------------


def weekday_count(a: date, b: date) -> int:
    """Monday-to-Friday days in ``[a, b]`` (0 when ``b < a``), by arithmetic."""
    if b < a:
        return 0
    days = (b - a).days + 1
    weeks, rest = divmod(days, 7)
    first = a.weekday()
    return weeks * 5 + sum(1 for i in range(rest) if (first + i) % 7 < 5)


def working_days(a: date, b: date, holidays_sorted: Sequence[date]) -> int:
    """Weekdays of ``[a, b]`` minus the holidays in it (sorted, unique, weekdays only)."""
    if b < a:
        return 0
    inside = bisect_right(holidays_sorted, b) - bisect_left(holidays_sorted, a)
    return weekday_count(a, b) - inside


def capacity_days(a: date, b: date, off_days: Sequence[date], max_capacity: int) -> float:
    """
    The days of ``[a, b]`` a person can work, at ``max_capacity`` %: weekdays
    minus their off days in it (sorted, unique, weekdays only), by ``bisect``.
    """
    return working_days(a, b, off_days) * max_capacity / 100


def off_days_within(period: tuple[date, date], *day_sets: Iterable[date]) -> tuple[date, ...]:
    """The sorted, unique weekdays of ``period`` found in any of ``day_sets``."""
    start, end = period
    return tuple(
        sorted(
            {day for days in day_sets for day in days if start <= day <= end and day.weekday() < 5}
        )
    )


def closure_applies(
    event_site_ids: Iterable[int],
    event_team_ids: Iterable[int],
    person_site_ids: Iterable[int],
    person_team_ids: Iterable[int],
    team_sites: Mapping[int, int | None],
) -> bool:
    """
    Whether a site closure takes a person out: ``getClosureOn`` in
    ``frontend/src/utils/siteClosure.ts``. The event must share a site with
    the person; its teams at those shared sites (``team_sites``: team id ->
    site id; an unknown team is ignored) limit it to their members, and with
    none of its teams at a shared site it closes the whole site.
    """
    person_sites = set(person_site_ids)
    shared = {site_id for site_id in event_site_ids if site_id in person_sites}
    if not shared:
        return False
    restricted = [team_id for team_id in event_team_ids if team_sites.get(team_id) in shared]
    return not restricted or bool(set(restricted).intersection(person_team_ids))


class AbsenceSpan(NamedTuple):
    """One absence of a person (``unavailable``: its type takes them out, or none)."""

    start: date
    end: date
    description: str | None
    unavailable: bool


class ClosureSpan(NamedTuple):
    """A site closure: its days, sites and teams (``closure_applies``)."""

    start: date
    end: date
    site_ids: tuple[int, ...]
    team_ids: tuple[int, ...] = ()


def person_off_days(
    period: tuple[date, date],
    site_ids: Sequence[int],
    team_ids: Sequence[int],
    holidays: Mapping[int, Sequence[date]],
    absences: Iterable[AbsenceSpan],
    closures: Iterable[ClosureSpan],
    team_sites: Mapping[int, int | None],
) -> tuple[date, ...]:
    """
    A person's off days in ``period`` (``CapacityFact.off_days``): the bank
    holidays of any of their sites, their unavailable absences (a recurring
    one on its pattern days only) and the closures that apply to them.
    """
    start, end = period
    day_sets: list[Iterable[date]] = [holidays.get(site_id, ()) for site_id in site_ids]
    for absence in absences:
        if absence.unavailable:
            days = parse_recurring_days(absence.description)
            day_sets.append(
                absence_weekdays(max(absence.start, start), min(absence.end, end), days)
            )
    for closure in closures:
        if closure_applies(closure.site_ids, closure.team_ids, site_ids, team_ids, team_sites):
            day_sets.append(
                absence_weekdays(max(closure.start, start), min(closure.end, end), None)
            )
    return off_days_within(period, *day_sets)


def equipment_off_days(
    period: tuple[date, date],
    site_ids: Sequence[int],
    holidays: Mapping[int, Sequence[date]],
    blocks: Iterable[tuple[date, date]],
) -> tuple[date, ...]:
    """
    An equipment's off days in ``period`` (``EquipmentAvailabilityFact.off_days``):
    the bank holidays of any of its sites and the weekdays of its blocks
    (``(start, end)`` pairs).
    """
    start, end = period
    day_sets: list[Iterable[date]] = [holidays.get(site_id, ()) for site_id in site_ids]
    for first, last in blocks:
        day_sets.append(absence_weekdays(max(first, start), min(last, end), None))
    return off_days_within(period, *day_sets)


class WorkingCalendar:
    """Working days per site: weekdays minus that site's bank holidays."""

    def __init__(self, holidays_by_site: Mapping[int, Sequence[date]]):
        self._holidays = holidays_by_site

    def days(self, site_id: int | None, a: date, b: date) -> int:
        holidays: Sequence[date] = () if site_id is None else self._holidays.get(site_id, ())
        return working_days(a, b, holidays)


def expand_holidays(
    rows: Iterable[tuple[int, date, date | None]], period: tuple[date, date]
) -> dict[int, list[date]]:
    """``(site_id, date, end_date)`` rows -> sorted weekday days per site, within ``period``."""
    start, end = period
    days: dict[int, set[date]] = {}
    for site_id, first, last in rows:
        day = max(first, start)
        stop = min(last or first, end)
        while day <= stop:
            if day.weekday() < 5:
                days.setdefault(site_id, set()).add(day)
            day += timedelta(days=1)
    return {site_id: sorted(values) for site_id, values in days.items()}


# ---------------------------------------------------------------------------
# Periods and buckets
# ---------------------------------------------------------------------------

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _month_end(year: int, month: int) -> date:
    if month == 12:
        return date(year, 12, 31)
    return date(year, month + 1, 1) - timedelta(days=1)


def _month_start(month_index: int) -> date:
    """The first day of the month ``year * 12 + month - 1``."""
    return date(month_index // 12, month_index % 12 + 1, 1)


def _quarter_bounds(year: int, quarter: int) -> tuple[date, date]:
    first_month = 3 * quarter - 2
    return date(year, first_month, 1), _month_end(year, first_month + 2)


def resolve_period(
    spec: Any, today: date, extent: tuple[date, date] | None = None
) -> tuple[date, date, bool]:
    """
    ``(from, to, truncated)`` of a period spec.

    Relative: ``this_year`` / ``last_year`` / ``next_year`` (calendar years),
    ``this_quarter`` / ``last_quarter`` / ``next_quarter`` (calendar
    quarters), ``this_month`` / ``last_month`` / ``next_month`` (calendar
    months), ``last_12_months`` (the 12 whole calendar months ending with the
    current one), ``next_12_months`` (the 12 whole calendar months starting
    with the current one: both include the current month), ``all``
    (``extent``, the min..max of the projects in scope; no projects ->
    today). An ``all`` extent longer than
    five years is cut, ``truncated``: its end to at most a year after today
    (planned work stays in), its start to five years before that end.
    Absolute: ``{from, to}``.
    """
    relative = getattr(spec, "relative", None)
    if relative is None:
        return spec.from_, spec.to, False
    year = today.year
    quarter = (today.month - 1) // 3 + 1
    if relative == "this_year":
        return date(year, 1, 1), date(year, 12, 31), False
    if relative == "last_year":
        return date(year - 1, 1, 1), date(year - 1, 12, 31), False
    if relative == "this_quarter":
        first, last = _quarter_bounds(year, quarter)
        return first, last, False
    if relative == "last_quarter":
        first, last = (
            _quarter_bounds(year - 1, 4) if quarter == 1 else _quarter_bounds(year, quarter - 1)
        )
        return first, last, False
    if relative == "next_year":
        return date(year + 1, 1, 1), date(year + 1, 12, 31), False
    if relative == "next_quarter":
        first, last = (
            _quarter_bounds(year + 1, 1) if quarter == 4 else _quarter_bounds(year, quarter + 1)
        )
        return first, last, False
    # Months are counted as ``year * 12 + month - 1`` so shifts cross years.
    month_index = year * 12 + today.month - 1
    if relative in ("this_month", "last_month", "next_month"):
        shift = {"this_month": 0, "last_month": -1, "next_month": 1}[relative]
        first = _month_start(month_index + shift)
        return first, _month_end(first.year, first.month), False
    if relative == "last_12_months":
        return _month_start(month_index - 11), _month_end(year, today.month), False
    if relative == "next_12_months":
        last_month = _month_start(month_index + 11)
        return date(year, today.month, 1), _month_end(last_month.year, last_month.month), False
    if relative == "all":
        if extent is None:
            return today, today, False
        low, high = extent
        if (high - low).days + 1 <= MAX_PERIOD_DAYS:
            return low, high, False
        span = timedelta(days=MAX_PERIOD_DAYS - 1)
        cut_high = min(high, today + timedelta(days=365))
        if cut_high < low:
            # Every project starts more than a year ahead: the first five years.
            cut_high = low + span
        cut_low = max(low, cut_high - span)
        return cut_low, cut_high, (cut_low, cut_high) != (low, high)
    raise MetricError(f"Unknown period: {relative}")


class Bucket(NamedTuple):
    key: str
    label: str
    start: date
    end: date


def _bucket_of(grain: str, day: date) -> Bucket:
    if grain == "year":
        return Bucket(f"{day.year}", f"{day.year}", date(day.year, 1, 1), date(day.year, 12, 31))
    if grain == "quarter":
        quarter = (day.month - 1) // 3 + 1
        first, last = _quarter_bounds(day.year, quarter)
        return Bucket(f"{day.year}-Q{quarter}", f"Q{quarter} {day.year}", first, last)
    if grain == "month":
        return Bucket(
            f"{day.year}-{day.month:02d}",
            f"{_MONTHS[day.month - 1]} {day.year}",
            date(day.year, day.month, 1),
            _month_end(day.year, day.month),
        )
    if grain == "week":
        iso_year, iso_week, _ = day.isocalendar()
        monday = day - timedelta(days=day.weekday())
        return Bucket(
            f"{iso_year}-W{iso_week:02d}",
            f"W{iso_week:02d} {iso_year}",
            monday,
            monday + timedelta(days=6),
        )
    raise MetricError(f"Unknown grain: {grain}")


def buckets(grain: str, start: date, end: date) -> list[Bucket]:
    """The ordered buckets of ``[start, end]``; the first and last are clamped to it."""
    out: list[Bucket] = []
    cursor = start
    while cursor <= end:
        bucket = _bucket_of(grain, cursor)
        out.append(Bucket(bucket.key, bucket.label, max(bucket.start, start), min(bucket.end, end)))
        cursor = bucket.end + timedelta(days=1)
    return out


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

EMPTY_LABELS: dict[str, str] = {
    "site": "No site",
    "team": "No team",
    "project_team": "No team",
    "project_manager": "No manager",
    "customer": "No customer",
    "tag": "No tag",
    "field": "Not set",
    "phase_type": "No phase",
    "equipment_type": "No type",
}
OTHER_KEY = "__other__"
OTHER_LABEL = "Other"


class DimValue(NamedTuple):
    key: Any
    label: str
    color: str | None
    order: tuple[Any, ...]


def _value(key: Any, label: str, color: str | None, *order: Any) -> DimValue:
    return DimValue(key, label, color, (0, *order))


def _by_label(key: Any, label: str, color: str | None = None) -> DimValue:
    return _value(key, label, color, label.casefold(), str(key))


def _empty(kind: str) -> DimValue:
    return DimValue(None, EMPTY_LABELS[kind], None, (1,))


_OTHER = DimValue(OTHER_KEY, OTHER_LABEL, None, (2,))


@dataclass(frozen=True)
class _Dimension:
    kind: str
    label: str
    grain: str | None = None
    field: FieldInfo | None = None


FIELD_DIMENSION_TYPES: frozenset[str] = frozenset({"select", "multiselect", "toggle"})
FIELD_GONE_DETAIL = "The project field of this widget no longer exists"


def _resolve_dimension(facts: Facts, spec: Any) -> _Dimension:
    if spec.kind == "period":
        return _Dimension("period", GRAIN_LABELS[spec.grain], grain=spec.grain)
    if spec.kind == "field":
        info = facts.fields.get(spec.field_id)
        if info is None:
            raise MetricError(FIELD_GONE_DETAIL)
        if info.field_type not in FIELD_DIMENSION_TYPES:
            raise MetricError(
                f'"{info.name}" cannot be used as a dimension: only dropdown and toggle fields can'
            )
        return _Dimension("field", info.name, field=info)
    return _Dimension(spec.kind, DIMENSION_LABELS[spec.kind])


@dataclass
class _Filters:
    archived: str
    site_ids: set[int] | None = None
    team_ids: set[int] | None = None
    project_team_ids: set[int] | None = None
    person_ids: set[int] | None = None
    project_ids: set[int] | None = None
    project_manager_ids: set[int] | None = None
    tag_ids: set[int] | None = None
    confirmed: bool | None = None
    field_options: dict[int, set[int]] = field(default_factory=dict)
    milestones: str = "include"
    equipment_ids: set[int] | None = None
    equipment_types: set[str] | None = None


def _known(
    ids: list[int] | None, known: Iterable[int] | Mapping[int, Any], noun: str, warnings: list[str]
) -> set[int] | None:
    """The ids that still exist (None = no filter); each stale one adds a warning."""
    if not ids:
        return None
    existing = known if isinstance(known, Mapping) else set(known)
    kept: set[int] = set()
    for item in ids:
        if item in existing:
            kept.add(item)
        else:
            _warn(warnings, f"{noun} {item} no longer exists")
    return kept or None


def _known_types(types: list[str] | None, facts: Facts, warnings: list[str]) -> set[str] | None:
    """
    The equipment types (exact names, case-sensitive) some equipment still
    has (None = no filter); each unknown one adds a warning.
    """
    if not types:
        return None
    existing = {info.type for info in facts.equipment.values() if info.type}
    kept: set[str] = set()
    for name in types:
        if name in existing:
            kept.add(name)
        else:
            _warn(warnings, f"Equipment type {name} no longer exists")
    return kept or None


def _warn(warnings: list[str], message: str) -> None:
    if message not in warnings:
        warnings.append(message)


def _resolve_filters(facts: Facts, spec: Any, warnings: list[str]) -> _Filters:
    project_ids = facts.project_ids if facts.project_ids is not None else facts.projects.keys()
    flt = _Filters(
        archived=spec.archived,
        site_ids=_known(spec.site_ids, facts.sites, "Site", warnings),
        team_ids=_known(spec.team_ids, facts.teams, "Team", warnings),
        project_team_ids=_known(spec.project_team_ids, facts.teams, "Team", warnings),
        person_ids=_known(spec.person_ids, facts.persons, "Person", warnings),
        project_ids=_known(spec.project_ids, project_ids, "Project", warnings),
        project_manager_ids=_known(spec.project_manager_ids, facts.persons, "Person", warnings),
        tag_ids=_known(spec.tag_ids, facts.tags, "Tag", warnings),
        confirmed=spec.confirmed,
        milestones=getattr(spec, "milestones", "include"),
        equipment_ids=_known(spec.equipment_ids, facts.equipment, "Equipment", warnings),
        equipment_types=_known_types(spec.equipment_types, facts, warnings),
    )
    for field_id, option_ids in (spec.field_options or {}).items():
        if field_id not in facts.fields:
            _warn(warnings, f"Project field {field_id} no longer exists")
            continue
        kept = set()
        for option_id in option_ids:
            option = facts.options.get(option_id)
            if option is None or option.field_id != field_id:
                _warn(warnings, f"Item {option_id} no longer exists")
            else:
                kept.add(option_id)
        if kept:
            flt.field_options[field_id] = kept
    return flt


def _selected_option_ids(value: Any) -> set[int]:
    if isinstance(value, bool) or value is None:
        return set()
    if isinstance(value, int):
        return {value}
    if isinstance(value, list):
        return {v for v in value if isinstance(v, int) and not isinstance(v, bool)}
    return set()


def _archived_passes(project: ProjectFact, archived: str) -> bool:
    if archived == "exclude":
        return not project.archived
    if archived == "only":
        return project.archived
    return True


def _project_passes(project: ProjectFact, flt: _Filters) -> bool:
    if not _archived_passes(project, flt.archived):
        return False
    if flt.site_ids is not None and project.site_id not in flt.site_ids:
        return False
    if flt.project_team_ids is not None and not flt.project_team_ids.intersection(project.team_ids):
        return False
    if flt.project_ids is not None and project.id not in flt.project_ids:
        return False
    if flt.project_manager_ids is not None and project.pm_id not in flt.project_manager_ids:
        return False
    if flt.tag_ids is not None and not flt.tag_ids.intersection(project.tag_ids):
        return False
    if flt.confirmed is not None and project.confirmed != flt.confirmed:
        return False
    for field_id, option_ids in flt.field_options.items():
        if not option_ids & _selected_option_ids(project.field_values.get(field_id)):
            return False
    return True


class _Item(NamedTuple):
    """One fact of the measure's family, ready to split into dimension values."""

    kind: str
    id: Any
    # None for facts without a project (capacity and availability facts).
    project: ProjectFact | None
    start: date
    end: date
    booking: BookingFact | None = None
    phase: PhaseFact | None = None
    capacity: CapacityFact | None = None
    equipment_booking: EquipmentBookingFact | None = None
    # The equipment's availability on both sides of an equipment-side
    # composite (``EQUIPMENT_SIDE_MEASURES``): its sites answer ``site``.
    availability: EquipmentAvailabilityFact | None = None


def _project_of(item: _Item) -> ProjectFact:
    """The item's project (the matrix keeps project dimensions to project-backed facts)."""
    assert item.project is not None
    return item.project


def _capacity_passes(fact: CapacityFact, flt: _Filters) -> bool:
    """The capacity family's filters, on the person (sites, teams, people)."""
    if flt.site_ids is not None and not flt.site_ids.intersection(fact.site_ids):
        return False
    if flt.team_ids is not None and not flt.team_ids.intersection(fact.team_ids):
        return False
    return flt.person_ids is None or fact.person_id in flt.person_ids


def _capacity_of(facts: Facts, item: _Item) -> CapacityFact:
    """The capacity fact of a capacity-family item (either side)."""
    if item.capacity is not None:
        return item.capacity
    assert item.booking is not None  # the capacity family's booked side
    return facts.capacity[item.booking.person_id]


def _equipment_id(item: _Item) -> int:
    """The equipment of an equipment-family item (either side)."""
    if item.availability is not None:
        return item.availability.equipment_id
    assert item.equipment_booking is not None
    return item.equipment_booking.equipment_id


def _equipment_info(facts: Facts, equipment_id: int) -> EquipmentInfo:
    """The equipment's reference row (a row gone since the load: its id as name)."""
    info = facts.equipment.get(equipment_id)
    if info is None:
        return EquipmentInfo(equipment_id, f"Equipment {equipment_id}", None, (), False)
    return info


def _equipment_passes(info: EquipmentInfo, flt: _Filters) -> bool:
    """The Equipment and Equipment types filters, on the equipment."""
    if flt.equipment_ids is not None and info.id not in flt.equipment_ids:
        return False
    return flt.equipment_types is None or info.type in flt.equipment_types


def _equipment_side_passes(facts: Facts, fact: EquipmentAvailabilityFact, flt: _Filters) -> bool:
    """Equipment utilisation's filters: the equipment's sites, the equipment, its type."""
    if flt.site_ids is not None and not flt.site_ids.intersection(fact.site_ids):
        return False
    return _equipment_passes(_equipment_info(facts, fact.equipment_id), flt)


def _items(
    facts: Facts, measure: str, flt: _Filters, family: str, asked: str = ""
) -> Iterator[_Item]:
    """
    The items of ``measure`` (a base measure for a composite side).

    ``family`` is the family of the measure *asked*: a composite's, which can
    differ from the base measure's own (``FAMILY[measure]`` picks the facts,
    ``family`` the rules applied to them: the capacity rules key on it).
    ``asked`` is the measure asked itself: an equipment-side composite
    (``EQUIPMENT_SIDE_MEASURES``) reads its filters from the equipment.
    """
    kind = FAMILY[measure]
    if kind == "booking" and family == "capacity":
        # The booked side of a capacity measure: bookings of the people with
        # a capacity (others are ignored on both sides), matched on the
        # person's sites and teams -- not the project's site. Bookings stay
        # cut to the projects of the visible sites (the loader's scope).
        for booking in facts.bookings:
            fact = facts.capacity.get(booking.person_id)
            project = facts.projects.get(booking.project_id)
            if fact is None or project is None or not _archived_passes(project, flt.archived):
                continue
            if not _capacity_passes(fact, flt):
                continue
            yield _Item(
                "booking",
                (booking.level, booking.id),
                project,
                booking.start,
                booking.end,
                booking=booking,
            )
    elif kind == "booking":
        for booking in facts.bookings:
            project = facts.projects.get(booking.project_id)
            if project is None or not _project_passes(project, flt):
                continue
            if flt.team_ids is not None and not flt.team_ids.intersection(booking.team_ids):
                continue
            if flt.person_ids is not None and booking.person_id not in flt.person_ids:
                continue
            yield _Item(
                "booking",
                (booking.level, booking.id),
                project,
                booking.start,
                booking.end,
                booking=booking,
            )
    elif kind == "project":
        for project in facts.projects.values():
            if _project_passes(project, flt):
                yield _Item("project", project.id, project, project.start, project.end)
    elif kind == "phase":
        for phase in facts.phases:
            if flt.milestones == "only" and not phase.is_milestone:
                continue
            if flt.milestones == "exclude" and phase.is_milestone:
                continue
            project = facts.projects.get(phase.project_id)
            if project is None or not _project_passes(project, flt):
                continue
            # A milestone is one day (the loader already sets its end to it).
            end = phase.start if phase.is_milestone else phase.end
            if measure in ("phases_due", "phases_overdue"):
                # Filed on its due date (its end), once.
                if measure == "phases_overdue" and (end >= facts.today or phase.status == "done"):
                    continue
                yield _Item("phase", phase.id, project, end, end, phase=phase)
            else:
                yield _Item("phase", phase.id, project, phase.start, end, phase=phase)
    elif kind == "capacity":
        # Every day of the period (the piece loop clips to it and its buckets).
        for fact in facts.capacity.values():
            if _capacity_passes(fact, flt):
                yield _Item("capacity", fact.person_id, None, date.min, date.max, capacity=fact)
    elif kind == "equipment" and asked in EQUIPMENT_SIDE_MEASURES:
        # Both sides of equipment utilisation: the equipment with an
        # availability (active, at a visible site), matched on its sites;
        # the booked side keeps the archived test of its project.
        by_equipment = {a.equipment_id: a for a in facts.equipment_availability}
        if measure == "equipment_available_days":
            for available in facts.equipment_availability:
                if _equipment_side_passes(facts, available, flt):
                    yield _Item(
                        "equipment_availability",
                        available.equipment_id,
                        None,
                        date.min,
                        date.max,
                        availability=available,
                    )
        else:
            for used in facts.equipment_bookings:
                found = by_equipment.get(used.equipment_id)
                project = facts.projects.get(used.project_id)
                if found is None or project is None or not _archived_passes(project, flt.archived):
                    continue
                if not _equipment_side_passes(facts, found, flt):
                    continue
                yield _Item(
                    "equipment_booking",
                    used.id,
                    project,
                    used.start,
                    used.end,
                    equipment_booking=used,
                    availability=found,
                )
    elif kind == "equipment":
        # The booking side: the project's filters, then the equipment's.
        for used in facts.equipment_bookings:
            project = facts.projects.get(used.project_id)
            if project is None or not _project_passes(project, flt):
                continue
            if not _equipment_passes(_equipment_info(facts, used.equipment_id), flt):
                continue
            yield _Item(
                "equipment_booking",
                used.id,
                project,
                used.start,
                used.end,
                equipment_booking=used,
            )
    else:
        raise MetricError(f"Unknown measure family: {kind} ({family})")


def _team_values(facts: Facts, team_ids: Iterable[int], kind: str) -> list[DimValue]:
    values = [
        _by_label(team_id, team.name, team.color)
        for team_id in team_ids
        if (team := facts.teams.get(team_id)) is not None
    ]
    return values or [_empty(kind)]


def _field_values(facts: Facts, info: FieldInfo, value: Any) -> list[DimValue]:
    if info.field_type == "toggle":
        if isinstance(value, bool):
            return [_value(value, "Yes" if value else "No", None, 0 if value else 1)]
        return [_empty("field")]
    values = []
    for option_id in sorted(_selected_option_ids(value)):
        option = facts.options.get(option_id)
        if option is not None and option.field_id == info.id:
            values.append(
                _value(option.id, option.name, option.color, option.sort_order, option.id)
            )
    return values or [_empty("field")]


def _status_value(status: str) -> DimValue:
    """A phase status in board order (an unknown stored value sorts after Done)."""
    if status in PHASE_STATUS_LABELS:
        return _value(status, PHASE_STATUS_LABELS[status], None, PHASE_STATUSES.index(status))
    return _value(status, status, None, len(PHASE_STATUSES), status)


def _values(facts: Facts, dimension: _Dimension, item: _Item, family: str) -> list[DimValue]:
    """
    The dimension values of ``item``; ``family`` is the asked measure's (see
    ``_items``): the capacity family reads ``site`` / ``team`` from the
    person, equipment utilisation ``site`` from the equipment (its items
    carry the availability fact).
    """
    kind = dimension.kind
    if family == "capacity" and kind in ("site", "team", "person"):
        # The person's sites, teams and name, on both sides.
        fact = _capacity_of(facts, item)
        if kind == "team":
            return _team_values(facts, fact.team_ids, kind)
        if kind == "person":
            return [_by_label(fact.person_id, fact.person_name)]
        sites = [
            _by_label(site_id, facts.sites.get(site_id, f"Site {site_id}"))
            for site_id in fact.site_ids
        ]
        return sites or [_empty(kind)]
    if kind == "equipment":
        info = _equipment_info(facts, _equipment_id(item))
        return [_by_label(info.id, info.name)]
    if kind == "equipment_type":
        equipment_type = _equipment_info(facts, _equipment_id(item)).type
        if equipment_type and equipment_type.strip():
            return [_by_label(equipment_type, equipment_type)]
        return [_empty(kind)]
    if kind == "site" and item.availability is not None:
        # Equipment utilisation: the equipment's sites, on both sides.
        sites = [
            _by_label(site_id, facts.sites.get(site_id, f"Site {site_id}"))
            for site_id in item.availability.site_ids
        ]
        return sites or [_empty(kind)]
    if kind == "team":
        return _team_values(facts, item.booking.team_ids if item.booking else (), kind)
    if kind == "person":
        booking = item.booking
        assert booking is not None  # the matrix keeps person to booking-backed facts
        return [_by_label(booking.person_id, booking.person_name)]
    if kind == "phase_type":
        phase_type = (
            item.phase.type if item.phase else item.booking.phase_type if item.booking else None
        )
        return [_by_label(phase_type, phase_type)] if phase_type else [_empty(kind)]
    if kind == "status":
        assert item.phase is not None  # the matrix keeps status to phase measures
        return [_status_value(item.phase.status)]
    project = _project_of(item)
    if kind == "site":
        if project.site_id is None:
            return [_empty(kind)]
        name = project.site_name or facts.sites.get(project.site_id, f"Site {project.site_id}")
        return [_by_label(project.site_id, name)]
    if kind == "project_team":
        return _team_values(facts, project.team_ids, kind)
    if kind == "project":
        return [_by_label(project.id, project.name)]
    if kind == "project_manager":
        if project.pm_id is None:
            return [_empty(kind)]
        name = project.pm_name or facts.persons.get(project.pm_id, f"Person {project.pm_id}")
        return [_by_label(project.pm_id, name)]
    if kind == "customer":
        customer = (project.customer or "").strip()
        return [_by_label(customer, customer)] if customer else [_empty(kind)]
    if kind == "confirmed":
        confirmed = project.confirmed
        return [
            _value(
                confirmed, "Confirmed" if confirmed else "Not confirmed", None, int(not confirmed)
            )
        ]
    if kind == "tag":
        tags = [
            _by_label(tag_id, tag.name, tag.color)
            for tag_id in project.tag_ids
            if (tag := facts.tags.get(tag_id)) is not None
        ]
        return tags or [_empty(kind)]
    if kind == "field":
        assert dimension.field is not None
        return _field_values(facts, dimension.field, project.field_values.get(dimension.field.id))
    raise MetricError(f"Unknown dimension: {kind}")  # pragma: no cover - the schema refuses it


def _amount(measure: str, item: _Item, calendar: WorkingCalendar, start: date, end: date) -> float:
    """The amount of ``item`` over ``[start, end]`` for a base measure (one branch each)."""
    if measure in ("booked_days", "booked_weeks"):
        assert item.booking is not None
        days = calendar.days(_project_of(item).site_id, start, end)
        booked = item.booking.allocation / 100 * days
        return booked if measure == "booked_days" else booked / 5
    if measure in ("project_weeks", "phase_weeks"):
        return calendar.days(_project_of(item).site_id, start, end) / 5
    if measure == "project_volume":
        return float(_project_of(item).volume or 0)
    if measure == "capacity_days":
        assert item.capacity is not None
        return capacity_days(start, end, item.capacity.off_days, item.capacity.max_capacity)
    if measure == "equipment_booked_days":
        # Whole days on the project's calendar (no allocation).
        return float(calendar.days(_project_of(item).site_id, start, end))
    if measure == "equipment_available_days":
        assert item.availability is not None
        return float(working_days(start, end, item.availability.off_days))
    if measure in COUNT_MEASURES:
        return 1.0  # a distinct count: the amount is unused
    raise MetricError(f"Unknown measure: {measure}")


def _ident(measure: str, item: _Item) -> Any:
    """What a distinct measure counts once."""
    if measure == "people_booked":
        assert item.booking is not None
        return item.booking.person_id
    if measure in ("project_count", "project_volume"):
        return _project_of(item).id
    if measure == "equipment_booked":
        return _equipment_id(item)
    return (item.kind, item.id)


def _subject(measure: str, item: _Item) -> Any:
    """
    The distinct subject a composite pairs its two sides on: the person for
    booking and capacity items, the equipment for equipment items, else
    None. ``measure`` is the side's base measure.
    """
    if item.availability is not None or item.equipment_booking is not None:
        return _equipment_id(item)
    if item.capacity is not None:
        return item.capacity.person_id
    if item.booking is not None:
        return item.booking.person_id
    return None


class _Contribution(NamedTuple):
    values: tuple[DimValue, ...]
    fid: tuple[Any, ...]  # one per fact and period bucket
    ident: Any
    amount: float
    # A composite's side: "num" (numerator base) or "den" (denominator base).
    side: str = "num"
    # The side's distinct subject (``_subject``): pairs the two sides per person.
    subject: Any = None


def _combine(measure: str, contributions: Iterable[_Contribution]) -> float | None:
    """The measure over ``contributions``, each fact (or counted thing) once."""
    if measure in COMPOSITES:
        return _combine_composite(measure, contributions)
    if measure in ADDITIVE_MEASURES:
        by_fid: dict[Any, float] = {}
        for c in contributions:
            by_fid.setdefault(c.fid, c.amount)
        return sum(by_fid.values())
    if measure == "project_volume":
        by_ident: dict[Any, float] = {}
        for c in contributions:
            by_ident.setdefault(c.ident, c.amount)
        return sum(by_ident.values())
    if measure in COUNT_MEASURES:
        return float(len({c.ident for c in contributions}))
    raise MetricError(f"Unknown measure: {measure}")


def _base_value(measure: str, contributions: list[_Contribution]) -> float:
    value = _combine(measure, contributions)
    assert value is not None  # a base measure is never a composite
    return value


def ratio_percent(num: float, den: float) -> float | None:
    """
    ``num / den`` as a percentage: None when ``den`` is 0 but ``num`` is not
    (booked time with no capacity has no utilisation), 0.0 when both are 0
    (an empty bucket).
    """
    if den == 0:
        return None if num > 0 else 0.0
    return num / den * 100


# Booked time above a capacity by less than this is float noise, not overtime.
OVER_CAPACITY_EPSILON = 1e-9


def _people_over(subjects: dict[Any, tuple[float, float]]) -> float:
    """The people whose own booked days exceed their capacity (0 capacity included)."""
    return float(
        sum(
            1
            for subject, (booked, capacity) in subjects.items()
            if subject is not None and booked - capacity > OVER_CAPACITY_EPSILON
        )
    )


# measure -> its fold of ``(numerator, denominator, {subject: (num, den)})``.
# ``_combine_composite`` is the one place composites are computed.
COMPOSITE_RULES: dict[
    str, Callable[[float, float, dict[Any, tuple[float, float]]], float | None]
] = {
    "utilisation": lambda booked, capacity, _subjects: ratio_percent(booked, capacity),
    "available_days": lambda booked, capacity, _subjects: capacity - booked,
    "people_over_capacity": lambda _booked, _capacity, subjects: _people_over(subjects),
    # Overlapping bookings add up: over 100 % is a double booking.
    "equipment_utilisation": lambda booked, available, _subjects: ratio_percent(booked, available),
}


def _combine_composite(measure: str, contributions: Iterable[_Contribution]) -> float | None:
    """
    A composite over ``contributions``: each side summed with its base measure
    (additive bases dedupe per fact and bucket), overall and per subject, then
    folded by ``COMPOSITE_RULES[measure]``.
    """
    num_base, den_base = COMPOSITES[measure]
    sides: dict[str, list[_Contribution]] = {"num": [], "den": []}
    by_subject: dict[Any, dict[str, list[_Contribution]]] = {}
    for c in contributions:
        sides[c.side].append(c)
        by_subject.setdefault(c.subject, {"num": [], "den": []})[c.side].append(c)
    num = _base_value(num_base, sides["num"])
    den = _base_value(den_base, sides["den"])
    subjects = {
        subject: (_base_value(num_base, parts["num"]), _base_value(den_base, parts["den"]))
        for subject, parts in by_subject.items()
    }
    rule = COMPOSITE_RULES.get(measure)
    if rule is None:
        raise MetricError(f"Unknown measure: {measure}")
    return rule(num, den, subjects)


def _pieces(
    bucket_list: list[Bucket], starts: list[date], start: date, end: date
) -> Iterator[tuple[int, date, date]]:
    """``(bucket index, start, end)`` of each bucket ``[start, end]`` touches."""
    index = max(bisect_right(starts, start) - 1, 0)
    while index < len(bucket_list) and bucket_list[index].start <= end:
        bucket = bucket_list[index]
        yield index, max(start, bucket.start), min(end, bucket.end)
        index += 1


# The subject of a family's notes ("<noun> in several teams counts in each").
FAMILY_NOUNS: dict[str, str] = {
    "booking": "A booking",
    "project": "A project",
    "phase": "A phase",
    "capacity": "A person",
    "equipment": "An equipment booking",
}


def _note(dimension: _Dimension, family: str) -> str:
    noun = FAMILY_NOUNS[family]
    if dimension.kind == "site":
        # Only the person / equipment side has several sites (a project has one).
        if family == "capacity":
            return "A person at several sites counts in each"
        if family == "equipment":
            return "Equipment at several sites counts in each"
    if dimension.kind == "team":
        return f"{noun} in several teams counts in each"
    of_project = "A project" if family == "project" else f"{noun} of a project"
    if dimension.kind == "project_team":
        return f"{of_project} in several teams counts in each"
    if dimension.kind == "tag":
        return f"{of_project} with several tags counts in each"
    return f'{of_project} with several "{dimension.label}" items counts in each'


@dataclass
class MetricResult:
    unit: str
    dimensions: list[dict[str, str]]
    rows: list[dict[str, Any]]  # each value a number, or None (a ratio over nothing)
    total: float | None
    truncated: bool
    warnings: list[str]
    period: tuple[date, date]
    note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "unit": self.unit,
            "dimensions": self.dimensions,
            "rows": self.rows,
            "total": self.total,
            "truncated": self.truncated,
            "warnings": self.warnings,
            "period": {"from": self.period[0].isoformat(), "to": self.period[1].isoformat()},
        }
        if self.note:
            data["note"] = self.note
        return data


def _key_dict(value: DimValue) -> dict[str, Any]:
    out: dict[str, Any] = {"key": value.key, "label": value.label}
    if value.color:
        out["color"] = value.color
    return out


def _rounded(measure: str, value: float | None, percent: bool) -> float | None:
    if value is None:
        return None
    if (
        not percent
        and measure not in ADDITIVE_MEASURES
        and measure not in FLOAT_MEASURES
        and measure != "project_volume"
    ):
        return int(value)
    return round(value, 2)


def _rank(value: float | None) -> tuple[bool, float]:
    """Top N order: the largest first, None last."""
    return (value is None, -(value or 0.0))


def aggregate(facts: Facts, query: Any, *, viewer: Viewer) -> MetricResult:
    """Answer ``query`` (a ``MetricQuery``) over ``facts``; pure."""
    needed = missing_permission(query, viewer)
    if needed is not None:
        raise MetricError(permission_message(needed))

    start, end, truncated = resolve_period(
        query.filters.period, facts.today, facts.extents.get(query.filters.archived)
    )
    warnings: list[str] = []
    flt = _resolve_filters(facts, query.filters, warnings)
    dimensions = [_resolve_dimension(facts, spec) for spec in query.dimensions]
    measure: str = query.measure
    family = FAMILY[measure]
    calendar = WorkingCalendar(facts.holidays)

    period_index = next((i for i, d in enumerate(dimensions) if d.kind == "period"), None)
    bucket_list: list[Bucket] = []
    if period_index is not None:
        grain = dimensions[period_index].grain
        assert grain is not None
        bucket_list = buckets(grain, start, end)
    bucket_starts = [b.start for b in bucket_list]
    bucket_values = [_value(b.key, b.label, None, i) for i, b in enumerate(bucket_list)]

    # One pass per side: a composite's numerator and denominator bases, else
    # the measure itself. Every contribution lands in the one list below.
    sides: list[tuple[str, str]] = (
        [(COMPOSITES[measure][0], "num"), (COMPOSITES[measure][1], "den")]
        if measure in COMPOSITES
        else [(measure, "num")]
    )
    contributions: list[_Contribution] = []
    several: set[int] = set()
    for base, side in sides:
        for item in _items(facts, base, flt, family, measure):
            first, last = max(item.start, start), min(item.end, end)
            if first > last:
                continue
            lists: list[list[DimValue] | None] = []
            for index, dimension in enumerate(dimensions):
                if index == period_index:
                    lists.append(None)
                    continue
                values = _values(facts, dimension, item, family)
                if len(values) > 1:
                    several.add(index)
                lists.append(values)
            pieces: Iterable[tuple[int | None, date, date]] = (
                _pieces(bucket_list, bucket_starts, first, last)
                if period_index is not None
                else [(None, first, last)]
            )
            ident = _ident(base, item)
            subject = _subject(base, item)
            for bucket_index, piece_start, piece_end in pieces:
                amount = _amount(base, item, calendar, piece_start, piece_end)
                if base in ADDITIVE_MEASURES and amount == 0:
                    continue
                fid = (item.kind, item.id, bucket_index)
                combos = [
                    [bucket_values[bucket_index]]
                    if values is None and bucket_index is not None
                    else values or []
                    for values in lists
                ]
                for combo in product(*combos):
                    contributions.append(
                        _Contribution(tuple(combo), fid, ident, amount, side, subject)
                    )

    total_raw = _combine(measure, contributions)
    percent = query.percent_of is not None

    if query.top_n is not None and dimensions:
        firsts: dict[Any, DimValue] = {}
        grouped: dict[Any, list[_Contribution]] = {}
        for c in contributions:
            firsts.setdefault(c.values[0].key, c.values[0])
            grouped.setdefault(c.values[0].key, []).append(c)
        ranked = sorted(
            firsts, key=lambda key: (*_rank(_combine(measure, grouped[key])), firsts[key].order)
        )
        if len(ranked) > query.top_n:
            kept = set(ranked[: query.top_n])
            contributions = [
                c if c.values[0].key in kept else c._replace(values=(_OTHER, *c.values[1:]))
                for c in contributions
            ]

    rows_by_key: dict[tuple[Any, ...], tuple[tuple[DimValue, ...], list[_Contribution]]] = {}
    for c in contributions:
        key = tuple(v.key for v in c.values)
        rows_by_key.setdefault(key, (c.values, []))[1].append(c)
    if len(dimensions) == 1 and period_index == 0:
        for value in bucket_values:
            rows_by_key.setdefault((value.key,), ((value,), []))

    denominators: dict[Any, float | None] = {}
    if query.percent_of == "first_dimension":
        by_first: dict[Any, list[_Contribution]] = {}
        for c in contributions:
            by_first.setdefault(c.values[0].key, []).append(c)
        denominators = {key: _combine(measure, group) for key, group in by_first.items()}

    rows: list[dict[str, Any]] = []
    if not dimensions:
        rows.append({"keys": [], "value": _rounded(measure, total_raw, False)})
    else:
        for values, group in sorted(
            rows_by_key.values(), key=lambda entry: tuple(v.order for v in entry[0])
        ):
            raw = _combine(measure, group)
            if raw is None:
                pass  # a ratio over nothing stays empty, percentage or not
            elif query.percent_of == "total":
                raw = raw / total_raw * 100 if total_raw else 0.0
            elif query.percent_of == "first_dimension":
                denominator = denominators.get(values[0].key, 0.0)
                raw = raw / denominator * 100 if denominator else 0.0
            rows.append(
                {"keys": [_key_dict(v) for v in values], "value": _rounded(measure, raw, percent)}
            )

    total = (100.0 if total_raw else 0.0) if percent else total_raw
    notes = [_note(dimensions[i], family) for i in sorted(several)]
    return MetricResult(
        unit=PERCENT_UNIT if percent else UNITS[measure],
        dimensions=[{"kind": d.kind, "label": d.label} for d in dimensions],
        rows=rows,
        total=_rounded(measure, total, percent),
        truncated=truncated,
        warnings=warnings,
        period=(start, end),
        note="; ".join(notes) or None,
    )


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------


def _project_scope(
    visible_site_ids: frozenset[int] | None, archived: str
) -> list[ColumnElement[bool]]:
    from app.models.project import Project
    from app.services.site_access import visible_sites_clause

    conditions: list[ColumnElement[bool]] = []
    clause = visible_sites_clause(Project.site_id, visible_site_ids)
    if clause is not None:
        conditions.append(clause)
    if archived == "exclude":
        conditions.append(Project.archived == 0)
    elif archived == "only":
        conditions.append(Project.archived != 0)
    return conditions


async def load_extent(
    db: AsyncSession, *, visible_site_ids: frozenset[int] | None, archived: str
) -> tuple[date, date] | None:
    """(min start, max end) of the projects in scope (the ``all`` period), or None."""
    from sqlalchemy import func, select

    from app.models.project import Project

    result = await db.execute(
        select(func.min(Project.start_date), func.max(Project.end_date)).where(
            *_project_scope(visible_site_ids, archived)
        )
    )
    low, high = result.one()
    if low is None or high is None:
        return None
    return low, high


def _booking_statements(scope: list[Any], start: date, end: date) -> list[Any]:
    from sqlalchemy import func, select

    from app.models.assignment import (
        PhaseStaffAssignment,
        ProjectAssignment,
        SubphaseStaffAssignment,
    )
    from app.models.project import Project, ProjectPhase, ProjectSubphase

    project_rows = (
        select(
            ProjectAssignment.id,
            ProjectAssignment.project_id,
            ProjectAssignment.staff_id,
            ProjectAssignment.allocation,
            ProjectAssignment.start_date,
            ProjectAssignment.end_date,
        )
        .join(Project, Project.id == ProjectAssignment.project_id)
        .where(
            *scope,
            ProjectAssignment.approval_status == "approved",
            ProjectAssignment.start_date <= end,
            ProjectAssignment.end_date >= start,
        )
    )
    statements: list[Any] = [project_rows]
    for model, card, card_fk in (
        (PhaseStaffAssignment, ProjectPhase, PhaseStaffAssignment.phase_id),
        (SubphaseStaffAssignment, ProjectSubphase, SubphaseStaffAssignment.subphase_id),
    ):
        statements.append(
            select(
                model.id,
                card.project_id,
                model.staff_id,
                model.allocation,
                model.start_date,
                model.end_date,
                card.id,
                card.start_date,
                card.end_date,
            )
            .join(card, card.id == card_fk)
            .join(Project, Project.id == card.project_id)
            .where(
                *scope,
                model.approval_status == "approved",
                func.coalesce(model.start_date, card.start_date) <= end,
                func.coalesce(model.end_date, card.end_date) >= start,
            )
        )
    return statements


def _capacity_population(visible_site_ids: frozenset[int] | None) -> Any:
    """
    The ids of the people with a capacity: active users flagged *Bookable as
    a resource* who are members of a visible site (every one, site-less
    included, when every site is visible).
    """
    from sqlalchemy import select

    from app.models.user import User, UserSite
    from app.services.site_access import visible_sites_clause

    statement = select(User.id).where(User.active == 1, User.is_resource.is_(True))
    clause = visible_sites_clause(UserSite.site_id, visible_site_ids)
    if clause is not None:
        statement = statement.where(User.id.in_(select(UserSite.user_id).where(clause)))
    return statement


def _absence_statement(population: Any, start: date, end: date) -> Any:
    """The absences of ``population`` overlapping ``[start, end]``, with their type's flag."""
    from sqlalchemy import select

    from app.models.absence_type import AbsenceType
    from app.models.vacation import Vacation

    return (
        select(
            Vacation.staff_id,
            Vacation.start_date,
            Vacation.end_date,
            Vacation.description,
            AbsenceType.counts_as_unavailable,
        )
        .outerjoin(AbsenceType, AbsenceType.id == Vacation.absence_type_id)
        .where(
            Vacation.staff_id.in_(population),
            Vacation.start_date <= end,
            Vacation.end_date >= start,
        )
    )


def _equipment_booking_statement(scope: list[Any], start: date, end: date) -> Any:
    """The equipment bookings of the projects in scope overlapping ``[start, end]``."""
    from sqlalchemy import select

    from app.models.equipment import EquipmentAssignment
    from app.models.project import Project

    return (
        select(
            EquipmentAssignment.id,
            EquipmentAssignment.project_id,
            EquipmentAssignment.equipment_id,
            EquipmentAssignment.start_date,
            EquipmentAssignment.end_date,
        )
        .join(Project, Project.id == EquipmentAssignment.project_id)
        .where(
            *scope,
            EquipmentAssignment.start_date <= end,
            EquipmentAssignment.end_date >= start,
        )
        .order_by(EquipmentAssignment.id)
    )


def clip_to_card(
    own_start: date | None,
    own_end: date | None,
    card_start: date,
    card_end: date,
) -> tuple[date, date] | None:
    """A card booking's effective dates clipped to its card (None when nothing is left)."""
    start, end, _ = effective_dates(own_start, own_end, card_start, card_end)
    start, end = max(start, card_start), min(end, card_end)
    return (start, end) if start <= end else None


def _top_phase(
    subphase_id: int, subphases: Mapping[int, tuple[int, str]], limit: int = 64
) -> int | None:
    """The phase a subphase sits under (walking nested subphases)."""
    current = subphase_id
    for _ in range(limit):
        parent = subphases.get(current)
        if parent is None:
            return None
        parent_id, parent_type = parent
        if parent_type == "phase":
            return parent_id
        current = parent_id
    return None


async def load_facts(
    db: AsyncSession,
    *,
    period: tuple[date, date],
    visible_site_ids: frozenset[int] | None,
    archived: str,
    today: date,
    extents: dict[str, tuple[date, date] | None] | None = None,
    families: frozenset[str] = frozenset(),
) -> Facts:
    """
    The facts for ``period`` at the visible sites (None = every site).

    ``archived`` is the widest mode the request needs (each widget applies
    its own). ``extents`` (archived mode -> ``load_extent``) is kept on the
    facts for the ``all`` period. ``families`` names the measure families the
    request's widgets read (``measure_families``): the booking, project and
    phase facts always load; the capacity facts (``CapacityFact``: the
    bookable people of the visible sites with their off days) and the
    equipment facts (every ``EquipmentInfo``, the equipment bookings of the
    projects in scope, an ``EquipmentAvailabilityFact`` per active equipment
    of the visible sites) only when their family is named. Raises
    ``TooManyFacts`` above ``MAX_FACT_ROWS`` booking rows (absence and
    equipment-booking rows included when their family loads).
    """
    from sqlalchemy import func, or_, select

    from app.models.equipment import Equipment, EquipmentBlock, EquipmentSite
    from app.models.project import Project, ProjectPhase, ProjectSubphase
    from app.models.project_field import ProjectField, ProjectFieldOption
    from app.models.site import BankHoliday, CompanyEvent, CompanyEventSite, Site
    from app.models.tag import ProjectTag, Tag
    from app.models.team import CompanyEventTeam, ProjectTeam, Team, TeamMember
    from app.models.user import User, UserSite
    from app.services.project_field_rules import load_project_field_values

    start, end = period
    scope = _project_scope(visible_site_ids, archived)
    statements = _booking_statements(scope, start, end)

    with_capacity = "capacity" in families
    population = _capacity_population(visible_site_ids) if with_capacity else None
    equipment_statement = (
        _equipment_booking_statement(scope, start, end) if "equipment" in families else None
    )
    counted = list(statements)
    if population is not None:
        counted.append(_absence_statement(population, start, end))
    if equipment_statement is not None:
        counted.append(equipment_statement)
    count = 0
    for statement in counted:
        result = await db.execute(select(func.count()).select_from(statement.subquery()))
        count += int(result.scalar_one())
    if count > MAX_FACT_ROWS:
        raise TooManyFacts()

    # Reference data (every row: labels, colours, stale-id warnings).
    persons = {
        row.id: f"{row.first_name or ''} {row.last_name or ''}".strip()
        for row in (await db.execute(select(User.id, User.first_name, User.last_name))).all()
    }
    sites = {row.id: row.name for row in (await db.execute(select(Site.id, Site.name))).all()}
    teams = {
        row.id: TeamInfo(row.id, row.name, row.color, row.site_id)
        for row in (await db.execute(select(Team.id, Team.name, Team.color, Team.site_id))).all()
    }
    tags = {
        row.id: TagInfo(row.id, row.name, row.color, row.sort_order)
        for row in (await db.execute(select(Tag.id, Tag.name, Tag.color, Tag.sort_order))).all()
    }
    fields = {
        row.id: FieldInfo(row.id, row.name, row.field_type, row.sort_order)
        for row in (
            await db.execute(
                select(
                    ProjectField.id,
                    ProjectField.name,
                    ProjectField.field_type,
                    ProjectField.sort_order,
                )
            )
        ).all()
    }
    options = {
        row.id: OptionInfo(row.id, row.field_id, row.name, row.color, row.sort_order)
        for row in (
            await db.execute(
                select(
                    ProjectFieldOption.id,
                    ProjectFieldOption.field_id,
                    ProjectFieldOption.name,
                    ProjectFieldOption.color,
                    ProjectFieldOption.sort_order,
                )
            )
        ).all()
    }
    all_project_ids = frozenset((await db.execute(select(Project.id))).scalars().all())

    # Bookings (raw rows; clipped once the projects are known).
    project_rows = (await db.execute(statements[0])).all()
    phase_rows = (await db.execute(statements[1])).all()
    subphase_rows = (await db.execute(statements[2])).all()
    equipment_rows = (
        (await db.execute(equipment_statement)).all() if equipment_statement is not None else []
    )
    booked_project_ids = {
        row[1] for row in (*project_rows, *phase_rows, *subphase_rows, *equipment_rows)
    }

    # Projects touching the period, and those of the loaded bookings.
    project_result = await db.execute(
        select(
            Project.id,
            Project.name,
            Project.site_id,
            Site.name.label("site_name"),
            Project.archived,
            Project.start_date,
            Project.end_date,
            Project.customer,
            Project.pm_id,
            Project.confirmed,
            Project.volume,
        )
        .outerjoin(Site, Site.id == Project.site_id)
        .where(
            *scope,
            or_(
                (Project.start_date <= end) & (Project.end_date >= start),
                Project.id.in_(sorted(booked_project_ids)),
            ),
        )
    )
    project_rows_raw = project_result.all()
    project_ids = sorted(row.id for row in project_rows_raw)

    team_links: dict[int, list[int]] = {}
    tag_links: dict[int, list[int]] = {}
    field_values: dict[int, dict[int, Any]] = {}
    phase_info: dict[int, tuple[str, PhaseFact]] = {}
    subphase_parents: dict[int, tuple[int, str]] = {}
    if project_ids:
        for project_id, team_id in (
            await db.execute(
                select(ProjectTeam.project_id, ProjectTeam.team_id)
                .where(ProjectTeam.project_id.in_(project_ids))
                .order_by(ProjectTeam.project_id, ProjectTeam.team_id)
            )
        ).all():
            team_links.setdefault(project_id, []).append(team_id)
        for project_id, tag_id in (
            await db.execute(
                select(ProjectTag.project_id, ProjectTag.tag_id)
                .where(ProjectTag.project_id.in_(project_ids))
                .order_by(ProjectTag.project_id, ProjectTag.tag_id)
            )
        ).all():
            tag_links.setdefault(project_id, []).append(tag_id)
        field_values = await load_project_field_values(db, project_ids)
        for row in (
            await db.execute(
                select(
                    ProjectPhase.id,
                    ProjectPhase.project_id,
                    ProjectPhase.type,
                    ProjectPhase.start_date,
                    ProjectPhase.end_date,
                    ProjectPhase.is_milestone,
                    ProjectPhase.status,
                ).where(ProjectPhase.project_id.in_(project_ids))
            )
        ).all():
            milestone = bool(row.is_milestone)
            phase_info[row.id] = (
                row.type,
                PhaseFact(
                    row.id,
                    row.project_id,
                    row.type,
                    row.start_date,
                    row.start_date if milestone else row.end_date,
                    milestone,
                    row.status or "todo",
                ),
            )
        if subphase_rows:
            for row in (
                await db.execute(
                    select(
                        ProjectSubphase.id, ProjectSubphase.parent_id, ProjectSubphase.parent_type
                    ).where(ProjectSubphase.project_id.in_(sorted({r[1] for r in subphase_rows})))
                )
            ).all():
                subphase_parents[row.id] = (row.parent_id, row.parent_type)

    projects: dict[int, ProjectFact] = {}
    for row in project_rows_raw:
        projects[row.id] = ProjectFact(
            id=row.id,
            name=row.name,
            site_id=row.site_id,
            site_name=row.site_name,
            archived=bool(row.archived),
            start=row.start_date,
            end=row.end_date,
            customer=row.customer,
            pm_id=row.pm_id,
            pm_name=persons.get(row.pm_id) if row.pm_id is not None else None,
            confirmed=bool(row.confirmed),
            volume=row.volume,
            team_ids=tuple(team_links.get(row.id, ())),
            tag_ids=tuple(tag_links.get(row.id, ())),
            field_values=field_values.get(row.id, {}),
        )

    phases = [fact for _, fact in phase_info.values() if fact.start <= end and fact.end >= start]
    phases.sort(key=lambda fact: fact.id)

    # The teams of the booked people at each site.
    person_ids = sorted({row[2] for row in (*project_rows, *phase_rows, *subphase_rows)})
    teams_by_person_site: dict[tuple[int, int | None], list[int]] = {}
    if person_ids:
        for user_id, team_id in (
            await db.execute(
                select(TeamMember.user_id, TeamMember.team_id)
                .where(TeamMember.user_id.in_(person_ids))
                .order_by(TeamMember.user_id, TeamMember.team_id)
            )
        ).all():
            team = teams.get(team_id)
            if team is not None:
                teams_by_person_site.setdefault((user_id, team.site_id), []).append(team_id)

    bookings: list[BookingFact] = []

    def add(
        level: str,
        row: Any,
        dates: tuple[date, date] | None,
        phase_type: str | None,
    ) -> None:
        project = projects.get(row[1])
        if project is None or dates is None:
            return
        bookings.append(
            BookingFact(
                id=row[0],
                level=level,
                project_id=row[1],
                person_id=row[2],
                person_name=persons.get(row[2], f"Person {row[2]}"),
                team_ids=tuple(teams_by_person_site.get((row[2], project.site_id), ())),
                allocation=row[3],
                start=dates[0],
                end=dates[1],
                phase_type=phase_type,
            )
        )

    for row in project_rows:
        add("project", row, (row[4], row[5]) if row[4] <= row[5] else None, None)
    for row in phase_rows:
        phase = phase_info.get(row[6])
        add("phase", row, clip_to_card(row[4], row[5], row[7], row[8]), phase[0] if phase else None)
    for row in subphase_rows:
        top = _top_phase(row[6], subphase_parents)
        phase = phase_info.get(top) if top is not None else None
        add(
            "subphase",
            row,
            clip_to_card(row[4], row[5], row[7], row[8]),
            phase[0] if phase else None,
        )

    # The capacity family: the bookable people, their sites, teams, absences
    # and the site closures of the period.
    capacity_ids: list[tuple[int, int]] = []
    sites_of: dict[int, list[int]] = {}
    teams_of: dict[int, list[int]] = {}
    absences: dict[int, list[AbsenceSpan]] = {}
    closures: list[ClosureSpan] = []
    if population is not None:
        capacity_ids = [
            (row.id, row.max_capacity)
            for row in (
                await db.execute(
                    select(User.id, User.max_capacity)
                    .where(User.id.in_(population))
                    .order_by(User.id)
                )
            ).all()
        ]
        people = [person_id for person_id, _ in capacity_ids]
        if people:
            for user_id, site_id in (
                await db.execute(
                    select(UserSite.user_id, UserSite.site_id)
                    .where(UserSite.user_id.in_(people))
                    .order_by(UserSite.user_id, UserSite.site_id)
                )
            ).all():
                sites_of.setdefault(user_id, []).append(site_id)
            for user_id, team_id in (
                await db.execute(
                    select(TeamMember.user_id, TeamMember.team_id)
                    .where(TeamMember.user_id.in_(people))
                    .order_by(TeamMember.user_id, TeamMember.team_id)
                )
            ).all():
                teams_of.setdefault(user_id, []).append(team_id)
            for row in (await db.execute(_absence_statement(population, start, end))).all():
                # An untyped absence (or one of a type gone) is unavailable.
                unavailable = row.counts_as_unavailable is None or bool(row.counts_as_unavailable)
                absences.setdefault(row.staff_id, []).append(
                    AbsenceSpan(row.start_date, row.end_date, row.description, unavailable)
                )
            event_rows = (
                await db.execute(
                    select(
                        CompanyEvent.id,
                        CompanyEvent.site_id,
                        CompanyEvent.date,
                        CompanyEvent.end_date,
                    ).where(
                        CompanyEvent.counts_as_unavailable.is_(True),
                        CompanyEvent.date <= end,
                        func.coalesce(CompanyEvent.end_date, CompanyEvent.date) >= start,
                    )
                )
            ).all()
            event_ids = [row.id for row in event_rows]
            event_sites: dict[int, list[int]] = {}
            event_teams: dict[int, list[int]] = {}
            if event_ids:
                for event_id, site_id in (
                    await db.execute(
                        select(CompanyEventSite.event_id, CompanyEventSite.site_id).where(
                            CompanyEventSite.event_id.in_(event_ids)
                        )
                    )
                ).all():
                    event_sites.setdefault(event_id, []).append(site_id)
                for event_id, team_id in (
                    await db.execute(
                        select(CompanyEventTeam.event_id, CompanyEventTeam.team_id).where(
                            CompanyEventTeam.event_id.in_(event_ids)
                        )
                    )
                ).all():
                    event_teams.setdefault(event_id, []).append(team_id)
            for row in event_rows:
                # The linked sites, else the legacy site (``closureSiteIds``).
                linked = event_sites.get(row.id) or (
                    [row.site_id] if row.site_id is not None else []
                )
                closures.append(
                    ClosureSpan(
                        row.date,
                        row.end_date or row.date,
                        tuple(sorted(linked)),
                        tuple(sorted(event_teams.get(row.id, ()))),
                    )
                )

    # The equipment family: every equipment (reference data), the bookings
    # of the projects loaded, the active equipment of the visible sites
    # (their availability) and their blocks.
    equipment: dict[int, EquipmentInfo] = {}
    equipment_bookings: list[EquipmentBookingFact] = []
    available: list[EquipmentInfo] = []
    blocks_of: dict[int, list[tuple[date, date]]] = {}
    if equipment_statement is not None:
        equipment_sites: dict[int, list[int]] = {}
        for equipment_id, site_id in (
            await db.execute(
                select(EquipmentSite.equipment_id, EquipmentSite.site_id).order_by(
                    EquipmentSite.equipment_id, EquipmentSite.site_id
                )
            )
        ).all():
            equipment_sites.setdefault(equipment_id, []).append(site_id)
        for row in (
            await db.execute(
                select(Equipment.id, Equipment.name, Equipment.type, Equipment.active).order_by(
                    Equipment.id
                )
            )
        ).all():
            equipment[row.id] = EquipmentInfo(
                id=row.id,
                name=row.name,
                type=row.type,
                site_ids=tuple(equipment_sites.get(row.id, ())),
                active=bool(row.active),
            )
        equipment_bookings = [
            EquipmentBookingFact(row[0], row[1], row[2], row[3], row[4])
            for row in equipment_rows
            if row[1] in projects and row[3] <= row[4]
        ]
        available = [
            info
            for info in equipment.values()
            if info.active
            and (visible_site_ids is None or visible_site_ids.intersection(info.site_ids))
        ]
        if available:
            for equipment_id, first, last in (
                await db.execute(
                    select(
                        EquipmentBlock.equipment_id,
                        EquipmentBlock.start_date,
                        EquipmentBlock.end_date,
                    ).where(
                        EquipmentBlock.equipment_id.in_([info.id for info in available]),
                        EquipmentBlock.start_date <= end,
                        EquipmentBlock.end_date >= start,
                    )
                )
            ).all():
                blocks_of.setdefault(equipment_id, []).append((first, last))

    # Bank holidays of the projects' sites (booked days), of the capacity
    # people's sites (their off days) and of the available equipment's sites.
    holiday_sites = sorted(
        {p.site_id for p in projects.values() if p.site_id is not None}
        | {site_id for site_ids in sites_of.values() for site_id in site_ids}
        | {site_id for info in available for site_id in info.site_ids}
    )
    holidays: dict[int, list[date]] = {}
    if holiday_sites:
        holiday_rows = (
            await db.execute(
                select(BankHoliday.site_id, BankHoliday.date, BankHoliday.end_date).where(
                    BankHoliday.site_id.in_(holiday_sites),
                    BankHoliday.date <= end,
                    func.coalesce(BankHoliday.end_date, BankHoliday.date) >= start,
                )
            )
        ).all()
        holidays = expand_holidays(((row[0], row[1], row[2]) for row in holiday_rows), (start, end))

    capacity: dict[int, CapacityFact] = {}
    if capacity_ids:
        team_sites = {team.id: team.site_id for team in teams.values()}
        for person_id, max_capacity in capacity_ids:
            person_sites = sites_of.get(person_id, [])
            person_teams = teams_of.get(person_id, [])
            capacity[person_id] = CapacityFact(
                person_id=person_id,
                person_name=persons.get(person_id, f"Person {person_id}"),
                site_ids=tuple(person_sites),
                team_ids=tuple(person_teams),
                max_capacity=max_capacity,
                off_days=person_off_days(
                    (start, end),
                    person_sites,
                    person_teams,
                    holidays,
                    absences.get(person_id, ()),
                    closures,
                    team_sites,
                ),
            )

    equipment_availability = [
        EquipmentAvailabilityFact(
            equipment_id=info.id,
            site_ids=info.site_ids,
            off_days=equipment_off_days(
                (start, end), info.site_ids, holidays, blocks_of.get(info.id, ())
            ),
        )
        for info in available
    ]

    return Facts(
        projects=projects,
        phases=phases,
        bookings=bookings,
        holidays=holidays,
        persons=persons,
        teams=teams,
        fields=fields,
        options=options,
        tags=tags,
        sites=sites,
        today=today,
        project_ids=all_project_ids,
        extents=dict(extents or {}),
        capacity=capacity,
        equipment=equipment,
        equipment_bookings=equipment_bookings,
        equipment_availability=equipment_availability,
    )
