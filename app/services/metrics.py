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
  bookings are left out; absences and closures do not subtract.
- ``aggregate`` is pure: it applies the query's own period and filters to the
  facts, splits them into the dimension values, and computes the measure.
  ``/dashboards/{id}/data`` loads the facts once for the union of its widgets'
  periods and aggregates every widget from them.

Rules (see ``tests/test_metrics.py`` ``FACT_CASES``):

- **Working day** = Monday to Friday, not a bank holiday of the *project's*
  site (multi-day holidays count every weekday they cover); a site-less
  project only skips weekends. Counted arithmetically, never by expanding days.
- ``booked_days`` = sum of allocation / 100 x working days of (booking span x
  period x bucket); ``booked_weeks`` = that / 5. ``project_weeks`` /
  ``phase_weeks`` prorate the project's / phase's span the same way (no
  allocation). ``project_count`` counts a project in every period bucket its
  span touches; ``project_volume`` adds each project's volume once.
- The **distinct** measures (``booking_count``, ``people_booked``,
  ``project_count``, ``project_volume``, ``phase_count``) recompute the total,
  the "Other" bucket and the percentage denominators over distinct facts: a
  project with two tags counts in both tag rows but once in the total.
  Additive measures do the same with the fact's amount (a booking in two teams
  adds its days to both team rows, once to the total).
- Multi-valued dimensions (``tag``, ``team``, ``project_team``, a
  multiselect ``field``) count a fact in each value and set ``note``.
- Stale ids in a stored query's filters are dropped with a warning; a deleted
  project field used as a dimension is an error (``MetricError``).

The **validity matrix** (``MATRIX``: which dimensions each measure accepts)
lives here and is the one source: the pydantic spec enforces it and
``metric_matrix_json()`` writes ``shared/metric-matrix.json`` for the frontend
(``tests/test_metric_matrix.py`` fails when the file is stale).

Import-light: no routers, no request objects; the models are imported inside
the loader only, so the schemas can import the constants cheaply.
"""

from __future__ import annotations

import json
from bisect import bisect_left, bisect_right
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from itertools import product
from typing import TYPE_CHECKING, Any, NamedTuple

from app.services.booking_segments import effective_dates

if TYPE_CHECKING:
    from sqlalchemy import ColumnElement
    from sqlalchemy.ext.asyncio import AsyncSession

# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

MEASURES: tuple[str, ...] = (
    "booked_days",
    "booked_weeks",
    "booking_count",
    "people_booked",
    "project_count",
    "project_weeks",
    "project_volume",
    "phase_count",
    "phase_weeks",
)
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
)
DIMENSION_KINDS: tuple[str, ...] = (*PLAIN_DIMENSION_KINDS, "field", "period")
RELATIVE_PERIODS: tuple[str, ...] = (
    "this_year",
    "last_year",
    "this_quarter",
    "last_quarter",
    "last_12_months",
    "all",
)
GRAINS: tuple[str, ...] = ("year", "quarter", "month", "week")
ARCHIVED_MODES: tuple[str, ...] = ("exclude", "include", "only")

# A period covers at most five years (inclusive days).
MAX_PERIOD_DAYS = 1826
PERIOD_TOO_LONG_DETAIL = "A period can cover at most five years"
# Soft cap on the booking rows one request loads.
MAX_FACT_ROWS = 200_000
TOO_MANY_FACTS_DETAIL = "Narrow the filters: this query covers too many bookings"

BOOKING_MEASURES: frozenset[str] = frozenset(
    {"booked_days", "booked_weeks", "booking_count", "people_booked"}
)
PROJECT_MEASURES: frozenset[str] = frozenset({"project_count", "project_weeks", "project_volume"})
PHASE_MEASURES: frozenset[str] = frozenset({"phase_count", "phase_weeks"})
# Summed amounts (the rest count distinct facts).
ADDITIVE_MEASURES: frozenset[str] = frozenset(
    {"booked_days", "booked_weeks", "project_weeks", "phase_weeks"}
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
    "field": "Project field",
    "period": "Period",
}
GRAIN_LABELS: dict[str, str] = {
    "year": "Year",
    "quarter": "Quarter",
    "month": "Month",
    "week": "Week",
}

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
_ALL_DIMENSIONS: frozenset[str] = frozenset(DIMENSION_KINDS)

MATRIX: dict[str, frozenset[str]] = {
    "booked_days": _ALL_DIMENSIONS,
    "booked_weeks": _ALL_DIMENSIONS,
    "booking_count": _ALL_DIMENSIONS,
    # Distinct people are not additive over time.
    "people_booked": _ALL_DIMENSIONS - {"period"},
    "project_count": _PROJECT_DIMENSIONS,
    "project_weeks": _PROJECT_DIMENSIONS,
    # A volume is not spread over time.
    "project_volume": _PROJECT_DIMENSIONS - {"period"},
    "phase_count": _PROJECT_DIMENSIONS | {"phase_type"},
    "phase_weeks": _PROJECT_DIMENSIONS | {"phase_type"},
}
# The permission a dimension needs (the per-person load is gated by it).
NEEDS: dict[str, str] = {"person": "views.staff"}
# ``archived: include | only`` needs this key.
ARCHIVED_NEEDS = "views.archived"
PERMISSION_NAMES: dict[str, str] = {"views.staff": "Staff", "views.archived": "Archived"}


def matrix_error(measure: str, kind: str) -> str | None:
    """The plain-words refusal of ``measure`` x ``kind``, or None when valid."""
    if kind in MATRIX[measure]:
        return None
    return f"{MEASURE_LABELS[measure]} cannot be broken down by {DIMENSION_LABELS[kind].lower()}"


def metric_matrix_json() -> str:
    """The content of the committed ``shared/metric-matrix.json`` (frontend mirror)."""
    data: dict[str, Any] = {
        "measures": {
            measure: {"unit": UNITS[measure], "dimensions": sorted(MATRIX[measure])}
            for measure in MEASURES
        },
        "needs": {"person": NEEDS["person"], "archived": ARCHIVED_NEEDS},
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
    """What the caller may see beyond the visible sites (per-widget errors)."""

    can_see_staff: bool
    can_see_archived: bool


def permission_message(key: str) -> str:
    return f"This widget needs the {PERMISSION_NAMES[key]} view permission"


def missing_permission(query: Any, viewer: Viewer) -> str | None:
    """The key ``query`` needs and ``viewer`` lacks, or None."""
    for dimension in query.dimensions:
        needed = NEEDS.get(dimension.kind)
        if needed == "views.staff" and not viewer.can_see_staff:
            return needed
    if query.filters.archived != "exclude" and not viewer.can_see_archived:
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


def _quarter_bounds(year: int, quarter: int) -> tuple[date, date]:
    first_month = 3 * quarter - 2
    return date(year, first_month, 1), _month_end(year, first_month + 2)


def resolve_period(
    spec: Any, today: date, extent: tuple[date, date] | None = None
) -> tuple[date, date, bool]:
    """
    ``(from, to, truncated)`` of a period spec.

    Relative: ``this_year`` / ``last_year`` (calendar years), ``this_quarter``
    / ``last_quarter``, ``last_12_months`` (the 12 whole calendar months
    ending with the current one), ``all`` (``extent``, the min..max of the
    projects in scope; no projects -> today). An ``all`` extent longer than
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
    if relative == "last_12_months":
        month_index = year * 12 + (today.month - 1) - 11
        first = date(month_index // 12, month_index % 12 + 1, 1)
        return first, _month_end(year, today.month), False
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


def _project_passes(project: ProjectFact, flt: _Filters) -> bool:
    if flt.archived == "exclude" and project.archived:
        return False
    if flt.archived == "only" and not project.archived:
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
    project: ProjectFact
    start: date
    end: date
    booking: BookingFact | None = None
    phase: PhaseFact | None = None


def _items(facts: Facts, measure: str, flt: _Filters) -> Iterator[_Item]:
    if measure in BOOKING_MEASURES:
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
    elif measure in PROJECT_MEASURES:
        for project in facts.projects.values():
            if _project_passes(project, flt):
                yield _Item("project", project.id, project, project.start, project.end)
    else:
        for phase in facts.phases:
            project = facts.projects.get(phase.project_id)
            if project is None or not _project_passes(project, flt):
                continue
            end = phase.start if phase.is_milestone else phase.end
            yield _Item("phase", phase.id, project, phase.start, end, phase=phase)


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


def _values(facts: Facts, dimension: _Dimension, item: _Item) -> list[DimValue]:
    project = item.project
    kind = dimension.kind
    if kind == "site":
        if project.site_id is None:
            return [_empty(kind)]
        name = project.site_name or facts.sites.get(project.site_id, f"Site {project.site_id}")
        return [_by_label(project.site_id, name)]
    if kind == "team":
        return _team_values(facts, item.booking.team_ids if item.booking else (), kind)
    if kind == "project_team":
        return _team_values(facts, project.team_ids, kind)
    if kind == "person":
        booking = item.booking
        assert booking is not None  # the matrix keeps person to booking measures
        return [_by_label(booking.person_id, booking.person_name)]
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
    if kind == "phase_type":
        phase_type = (
            item.phase.type if item.phase else item.booking.phase_type if item.booking else None
        )
        return [_by_label(phase_type, phase_type)] if phase_type else [_empty(kind)]
    if kind == "field":
        assert dimension.field is not None
        return _field_values(facts, dimension.field, project.field_values.get(dimension.field.id))
    raise MetricError(f"Unknown dimension: {kind}")  # pragma: no cover - the schema refuses it


def _amount(measure: str, item: _Item, calendar: WorkingCalendar, start: date, end: date) -> float:
    if measure == "project_volume":
        return float(item.project.volume or 0)
    if measure not in ADDITIVE_MEASURES:
        return 1.0
    days = calendar.days(item.project.site_id, start, end)
    if measure in ("booked_days", "booked_weeks"):
        assert item.booking is not None
        booked = item.booking.allocation / 100 * days
        return booked if measure == "booked_days" else booked / 5
    return days / 5


def _ident(measure: str, item: _Item) -> Any:
    """What a distinct measure counts once."""
    if measure == "people_booked":
        assert item.booking is not None
        return item.booking.person_id
    if measure in ("project_count", "project_volume"):
        return item.project.id
    return (item.kind, item.id)


class _Contribution(NamedTuple):
    values: tuple[DimValue, ...]
    fid: tuple[Any, ...]  # one per fact and period bucket
    ident: Any
    amount: float


def _combine(measure: str, contributions: Iterable[_Contribution]) -> float:
    """The measure over ``contributions``, each fact (or counted thing) once."""
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
    return float(len({c.ident for c in contributions}))


def _pieces(
    bucket_list: list[Bucket], starts: list[date], start: date, end: date
) -> Iterator[tuple[int, date, date]]:
    """``(bucket index, start, end)`` of each bucket ``[start, end]`` touches."""
    index = max(bisect_right(starts, start) - 1, 0)
    while index < len(bucket_list) and bucket_list[index].start <= end:
        bucket = bucket_list[index]
        yield index, max(start, bucket.start), min(end, bucket.end)
        index += 1


def _note(dimension: _Dimension, noun: str) -> str:
    if dimension.kind == "team":
        return f"A {noun} in several teams counts in each"
    of_project = "A project" if noun == "project" else f"A {noun} of a project"
    if dimension.kind == "project_team":
        return f"{of_project} in several teams counts in each"
    if dimension.kind == "tag":
        return f"{of_project} with several tags counts in each"
    return f'{of_project} with several "{dimension.label}" items counts in each'


def _noun(measure: str) -> str:
    if measure in BOOKING_MEASURES:
        return "booking"
    return "project" if measure in PROJECT_MEASURES else "phase"


@dataclass
class MetricResult:
    unit: str
    dimensions: list[dict[str, str]]
    rows: list[dict[str, Any]]
    total: float
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


def _rounded(measure: str, value: float, percent: bool) -> float:
    if not percent and measure not in ADDITIVE_MEASURES and measure != "project_volume":
        return int(value)
    return round(value, 2)


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
    calendar = WorkingCalendar(facts.holidays)

    period_index = next((i for i, d in enumerate(dimensions) if d.kind == "period"), None)
    bucket_list: list[Bucket] = []
    if period_index is not None:
        grain = dimensions[period_index].grain
        assert grain is not None
        bucket_list = buckets(grain, start, end)
    bucket_starts = [b.start for b in bucket_list]
    bucket_values = [_value(b.key, b.label, None, i) for i, b in enumerate(bucket_list)]

    contributions: list[_Contribution] = []
    several: set[int] = set()
    for item in _items(facts, measure, flt):
        first, last = max(item.start, start), min(item.end, end)
        if first > last:
            continue
        lists: list[list[DimValue] | None] = []
        for index, dimension in enumerate(dimensions):
            if index == period_index:
                lists.append(None)
                continue
            values = _values(facts, dimension, item)
            if len(values) > 1:
                several.add(index)
            lists.append(values)
        pieces: Iterable[tuple[int | None, date, date]] = (
            _pieces(bucket_list, bucket_starts, first, last)
            if period_index is not None
            else [(None, first, last)]
        )
        ident = _ident(measure, item)
        for bucket_index, piece_start, piece_end in pieces:
            amount = _amount(measure, item, calendar, piece_start, piece_end)
            if measure in ADDITIVE_MEASURES and amount == 0:
                continue
            fid = (item.kind, item.id, bucket_index)
            combos = [
                [bucket_values[bucket_index]]
                if values is None and bucket_index is not None
                else values or []
                for values in lists
            ]
            for combo in product(*combos):
                contributions.append(_Contribution(tuple(combo), fid, ident, amount))

    total_raw = _combine(measure, contributions)
    percent = query.percent_of is not None

    if query.top_n is not None and dimensions:
        firsts: dict[Any, DimValue] = {}
        grouped: dict[Any, list[_Contribution]] = {}
        for c in contributions:
            firsts.setdefault(c.values[0].key, c.values[0])
            grouped.setdefault(c.values[0].key, []).append(c)
        ranked = sorted(
            firsts, key=lambda key: (-_combine(measure, grouped[key]), firsts[key].order)
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

    denominators: dict[Any, float] = {}
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
            if query.percent_of == "total":
                raw = raw / total_raw * 100 if total_raw else 0.0
            elif query.percent_of == "first_dimension":
                denominator = denominators.get(values[0].key, 0.0)
                raw = raw / denominator * 100 if denominator else 0.0
            rows.append(
                {"keys": [_key_dict(v) for v in values], "value": _rounded(measure, raw, percent)}
            )

    total = (100.0 if total_raw else 0.0) if percent else total_raw
    notes = [_note(dimensions[i], _noun(measure)) for i in sorted(several)]
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
) -> Facts:
    """
    The facts for ``period`` at the visible sites (None = every site).

    ``archived`` is the widest mode the request needs (each widget applies
    its own). ``extents`` (archived mode -> ``load_extent``) is kept on the
    facts for the ``all`` period. Raises ``TooManyFacts`` above
    ``MAX_FACT_ROWS`` booking rows.
    """
    from sqlalchemy import func, or_, select

    from app.models.project import Project, ProjectPhase, ProjectSubphase
    from app.models.project_field import ProjectField, ProjectFieldOption
    from app.models.site import BankHoliday, Site
    from app.models.tag import ProjectTag, Tag
    from app.models.team import ProjectTeam, Team, TeamMember
    from app.models.user import User
    from app.services.project_field_rules import load_project_field_values

    start, end = period
    scope = _project_scope(visible_site_ids, archived)
    statements = _booking_statements(scope, start, end)

    count = 0
    for statement in statements:
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
    booked_project_ids = {row[1] for row in (*project_rows, *phase_rows, *subphase_rows)}

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

    holiday_sites = sorted({p.site_id for p in projects.values() if p.site_id is not None})
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
    )
