"""
Dashboards (2.6.0): the metric-query spec, widget and dashboard bodies, responses.

``MetricQuery`` is what a widget asks the metric engine
(``app/services/metrics.py``): a measure, up to two dimensions, filters with a
period, an optional percentage and top N -- or, for a calculated widget,
``formula``: named terms (each a measure with its own filters) combined by an
arithmetic expression (``app/services/formula.py``). Every refusal is a 422 in plain
words (``PydanticCustomError``, no "Value error," prefix), including the
validity matrix (``metrics.MATRIX``): "<measure> cannot be broken down by
<dimension>". The engine's constants are the one source; this module imports
them, never the reverse.

``WidgetIn`` / ``DashboardIn`` are the write bodies. A widget's ``query``,
``options`` and ``layout`` travel as JSON objects both ways; the router stores
them as compact JSON text. A widget that fails validation is named by its
title in the 422.
"""

import re
from datetime import date, datetime
from typing import Annotated, Any, Literal, get_args

from pydantic import (
    BaseModel,
    ConfigDict,
    Discriminator,
    Field,
    Tag,
    ValidationError,
    ValidatorFunctionWrapHandler,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticCustomError

from app.models.dashboard import DASHBOARD_VISIBILITIES, DASHBOARD_WIDGET_KINDS
from app.services.dashboard_seed import GRID_COLUMNS
from app.services.formula import MAX_FORMULA_LENGTH, FormulaError, parse
from app.services.metrics import (
    DIMENSION_LABELS,
    FILTER_KEYS,
    MAX_FORMULA_TERMS,
    MAX_PERIOD_DAYS,
    PERIOD_TOO_LONG_DETAIL,
    filter_error,
    filter_given,
    matrix_error,
    percent_error,
    term_error,
)

# The Literals spell out the engine's tuples (``metrics.MEASURES``,
# ``PLAIN_DIMENSION_KINDS``, ``RELATIVE_PERIODS``) for the type checker;
# ``tests/test_metric_matrix.py`` asserts they are equal, in order.
Measure = Literal[
    "booked_days",
    "booked_weeks",
    "booking_count",
    "people_booked",
    "project_count",
    "project_weeks",
    "project_volume",
    "phase_count",
    "phase_weeks",
    "phases_due",
    "phases_overdue",
    "capacity_days",
    "capacity_weeks",
    "available_days",
    "utilisation",
    "people_over_capacity",
    "equipment_booked_days",
    "equipment_booking_count",
    "equipment_booked",
    "equipment_utilisation",
]
PlainKind = Literal[
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
]
Grain = Literal["year", "quarter", "month", "week"]
RelativeName = Literal[
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
]
WidgetKind = Literal["kpi", "bar", "line", "pie", "table", "gauge", "heatmap", "treemap", "sankey"]
Visibility = Literal["private", "shared", "everyone"]

# Ids per filter list and widgets per dashboard (bounds on one request).
MAX_FILTER_IDS = 500
MAX_WIDGETS = 50
# At most this many roles, sites, teams or people per kind on one dashboard.
MAX_TARGETS = 200
# The largest gauge target (WidgetOptions.target).
MAX_GAUGE_TARGET = 1_000_000_000
# Bounds on the stored widget JSON (a huge row or height would freeze every
# viewer's grid): the grid row and height, and the KPI bucket key.
MAX_GRID_Y = 10000
MAX_GRID_H = 40
MAX_KPI_BUCKET_LENGTH = 200


def _error(message: str) -> PydanticCustomError:
    return PydanticCustomError("metric_query", message)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PlainDimension(_Strict):
    kind: PlainKind


class FieldDimension(_Strict):
    kind: Literal["field"]
    field_id: int


class PeriodDimension(_Strict):
    kind: Literal["period"]
    grain: Grain


Dimension = Annotated[
    PlainDimension | FieldDimension | PeriodDimension, Field(discriminator="kind")
]


class RelativePeriod(_Strict):
    relative: RelativeName


class AbsolutePeriod(_Strict):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_: date = Field(alias="from")
    to: date

    @model_validator(mode="after")
    def _check_span(self) -> "AbsolutePeriod":
        if self.to < self.from_:
            raise _error("A period cannot end before it starts")
        if (self.to - self.from_).days + 1 > MAX_PERIOD_DAYS:
            raise _error(PERIOD_TOO_LONG_DETAIL)
        return self


def _period_kind(value: Any) -> str:
    if isinstance(value, RelativePeriod) or (isinstance(value, dict) and "relative" in value):
        return "relative"
    return "absolute"


Period = Annotated[
    Annotated[RelativePeriod, Tag("relative")] | Annotated[AbsolutePeriod, Tag("absolute")],
    Discriminator(_period_kind),
]

IdList = Annotated[list[int], Field(max_length=MAX_FILTER_IDS)]


class TermFilters(_Strict):
    """
    The filters of a query, the period aside: those of a calculated widget's
    terms (``FormulaTerm``), which share the widget's period.
    """

    site_ids: IdList | None = None
    team_ids: IdList | None = None
    project_team_ids: IdList | None = None
    person_ids: IdList | None = None
    project_ids: IdList | None = None
    project_manager_ids: IdList | None = None
    tag_ids: IdList | None = None
    confirmed: bool | None = None
    field_options: dict[int, IdList] | None = Field(default=None, max_length=100)
    archived: Literal["exclude", "include", "only"] = "exclude"
    equipment_ids: IdList | None = None
    equipment_types: (
        Annotated[
            list[Annotated[str, Field(min_length=1, max_length=100)]],
            Field(max_length=100),
        ]
        | None
    ) = None
    milestones: Literal["include", "only", "exclude"] = "include"
    # True: projects with a customer (not blank); False: projects without one.
    has_customer: bool | None = None


class MetricFilters(TermFilters):
    period: Period = Field(default_factory=lambda: RelativePeriod(relative="this_year"))


TERM_NAME_PATTERN = r"[a-z][a-z0-9_]{0,39}"
TERM_NAME_DETAIL = (
    "A term name is a lowercase word of letters, digits and _, starting with a letter "
    "(customer_weeks)"
)


class FormulaTerm(_Strict):
    """
    One named term of a calculated widget: a summed or counted measure with
    its own filters over the widget's period. ``total``: not split by the
    dimensions other than the period (its whole-scope value in every row).
    """

    name: str
    measure: Measure
    filters: TermFilters = Field(default_factory=TermFilters)
    total: bool = False

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        if not re.fullmatch(TERM_NAME_PATTERN, value):
            raise _error(TERM_NAME_DETAIL)
        return value


class MetricFormula(_Strict):
    """
    A calculated widget (2.6.0): ``terms`` combined by ``expression``; the
    result is a percentage (x 100) or a plain number.
    """

    expression: str = Field(max_length=MAX_FORMULA_LENGTH)
    terms: list[FormulaTerm] = Field(min_length=1, max_length=MAX_FORMULA_TERMS)
    result: Literal["percent", "number"] = "percent"


def _check_filters(measure: str, filters: TermFilters) -> None:
    """A filter the measure's facts do not carry would be silently ignored: a 422."""
    for key in FILTER_KEYS:
        message = filter_error(measure, key)
        if message and filter_given(filters, key):
            raise _error(message)


class MetricQuery(_Strict):
    measure: Measure
    dimensions: list[Dimension] = Field(default_factory=list)
    filters: MetricFilters = Field(default_factory=MetricFilters)
    percent_of: Literal["total", "first_dimension"] | None = None
    top_n: int | None = Field(default=None, ge=1, le=50)
    # A calculated widget: named terms combined by a formula.
    formula: MetricFormula | None = None

    @model_validator(mode="after")
    def _check_query(self) -> "MetricQuery":
        if len(self.dimensions) > 2:
            raise _error("A widget can be broken down by two dimensions at most")
        kinds = [d.kind for d in self.dimensions]
        # Two project fields are two dimensions; the same one twice is not.
        identities = [(d.kind, getattr(d, "field_id", None)) for d in self.dimensions]
        if len(set(identities)) != len(identities):
            raise _error("The two dimensions must be different")
        if self.formula is not None:
            self._check_formula(self.formula, kinds)
        else:
            for kind in kinds:
                message = matrix_error(self.measure, kind)
                if message:
                    raise _error(message)
            # The measure's filters (``metrics.MEASURE_FILTERS``).
            _check_filters(self.measure, self.filters)
        if self.percent_of is not None:
            message = percent_error(self.measure)
            if message:
                raise _error(message)
        if self.percent_of is not None and not self.dimensions:
            raise _error("A percentage needs a dimension")
        if self.percent_of == "first_dimension" and len(self.dimensions) != 2:
            raise _error("A percentage of the first dimension needs two dimensions")
        if self.top_n is not None:
            if not self.dimensions:
                raise _error("Top N needs a dimension")
            if kinds[0] == "period":
                label = DIMENSION_LABELS["period"].lower()
                raise _error(f"Top N cannot be used when the first dimension is the {label}")
        return self

    def _check_formula(self, formula: MetricFormula, kinds: list[str]) -> None:
        """
        A calculated widget: a formula that parses and uses exactly its terms
        (unique names); the query's measure is the first term's and its
        filters carry the period only; each term a summed or counted measure
        with filters it takes; each dimension accepted by every term it splits
        (the period by every term); at least one split term when a dimension
        other than the period is set; no percentage of a dimension.
        """
        try:
            parsed = parse(formula.expression)
        except FormulaError as exc:
            raise _error(exc.message) from None
        names = [term.name for term in formula.terms]
        for name in names:
            if names.count(name) > 1:
                raise _error(f'Two terms are named "{name}"')
        for name in parsed.names:
            if name not in names:
                raise _error(f'The formula uses "{name}", which is not a term')
        for name in names:
            if name not in parsed.names:
                raise _error(f'The term "{name}" is not used in the formula')
        if self.measure != formula.terms[0].measure:
            raise _error("A calculation's measure is the measure of its first term")
        for key in FILTER_KEYS:
            if key != "period" and filter_given(self.filters, key):
                raise _error("The filters of a calculation belong to its terms")
        if self.percent_of is not None:
            raise _error("A calculation cannot show a percentage of a dimension")
        for term in formula.terms:
            message = term_error(term.measure)
            if message:
                raise _error(message)
            _check_filters(term.measure, term.filters)
        for kind in kinds:
            for term in formula.terms:
                if kind != "period" and term.total:
                    continue
                message = matrix_error(term.measure, kind)
                if message:
                    raise _error(message)
        if any(kind != "period" for kind in kinds) and all(term.total for term in formula.terms):
            raise _error(
                "With a dimension other than the period, at least one term must be split "
                "by it (not use its total)"
            )


class WidgetOptions(_Strict):
    stacked: bool | None = None
    percent: bool | None = None
    orientation: Literal["horizontal", "vertical"] | None = None
    number_format: Literal["integer", "decimal", "percent"] | None = None
    show_legend: bool | None = None
    # The KPI's bucket when ``percent_of`` is set: the dimension value's key.
    kpi_bucket: bool | int | Annotated[str, Field(max_length=MAX_KPI_BUCKET_LENGTH)] | None = None
    # The gauge's target (the bands sit around it), in the measure's unit.
    # Accepted on any kind, like the other options; the client keeps it for a
    # gauge and a KPI.
    target: float | None = Field(default=None, ge=0, le=MAX_GAUGE_TARGET, allow_inf_nan=False)
    # Show the value as a percentage of ``target`` (2.6.0): value / target x
    # 100, computed by the client; ignored without a target above 0.
    percent_of_target: bool | None = None
    # A gauge's target is a goal to reach (2.6.0): red below 85 % of it, amber
    # up to it, green from it. Kept by the client on a gauge with a target
    # above 0 only.
    target_is_goal: bool | None = None


class GridPosition(_Strict):
    x: int = Field(ge=0)
    y: int = Field(ge=0, le=MAX_GRID_Y)
    w: int = Field(ge=1)
    h: int = Field(ge=1, le=MAX_GRID_H)


class WidgetLayout(_Strict):
    lg: GridPosition
    md: GridPosition
    sm: GridPosition

    @model_validator(mode="after")
    def _check_fit(self) -> "WidgetLayout":
        for name, columns in GRID_COLUMNS.items():
            position: GridPosition = getattr(self, name)
            if position.x + position.w > columns:
                raise _error(f"The widget does not fit the {name} grid of {columns} columns")
        return self


class WidgetIn(_Strict):
    # Accepted and ignored: a save replaces the widgets and assigns new ids.
    id: int | None = None
    kind: WidgetKind
    title: str = Field(min_length=1, max_length=120)
    query: MetricQuery
    options: WidgetOptions = Field(default_factory=WidgetOptions)
    layout: WidgetLayout
    sort_order: int | None = None

    @field_validator("title")
    @classmethod
    def _strip_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise _error("A widget needs a title")
        return value


class DashboardIn(BaseModel):
    # Unknown keys are ignored: ``is_default`` (never settable), or the id and
    # read-only fields of a dashboard sent back as it was received.
    model_config = ConfigDict(extra="ignore")

    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    # POST: ``private`` when absent. PUT: absent (with the four lists) keeps
    # the dashboard's sharing as it is; see ``update_dashboard``.
    visibility: Visibility = "private"
    # The targets of a ``shared`` dashboard (any match opens it); stored only
    # for ``shared``, each list de-duplicated and sorted.
    role_ids: list[int] = Field(default_factory=list, max_length=MAX_TARGETS)
    site_ids: list[int] = Field(default_factory=list, max_length=MAX_TARGETS)
    team_ids: list[int] = Field(default_factory=list, max_length=MAX_TARGETS)
    user_ids: list[int] = Field(default_factory=list, max_length=MAX_TARGETS)
    widgets: list[WidgetIn] = Field(default_factory=list, max_length=MAX_WIDGETS)
    # POST only: copy the widgets of this dashboard (``widgets`` in the body win).
    source_id: int | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise _error("A dashboard needs a name")
        return value

    @field_validator("role_ids", "site_ids", "team_ids", "user_ids")
    @classmethod
    def _unique_ids(cls, value: list[int]) -> list[int]:
        return sorted(set(value))

    @field_validator("widgets", mode="wrap")
    @classmethod
    def _name_failing_widget(cls, value: Any, handler: ValidatorFunctionWrapHandler) -> Any:
        """A widget that fails validation is named by its title (else its position)."""
        try:
            return handler(value)
        except ValidationError as exc:
            first = exc.errors()[0]
            location = first.get("loc", ())
            index = location[0] if location and isinstance(location[0], int) else None
            name = "A widget"
            if index is not None and isinstance(value, list) and index < len(value):
                item = value[index]
                title = item.get("title") if isinstance(item, dict) else None
                if isinstance(title, str) and title.strip():
                    name = f'"{title.strip()}"'
                else:
                    name = f"Widget {index + 1}"
            raise _error(f"{name}: {first['msg']}") from None


# --- Responses -------------------------------------------------------------


class DashboardWidgetOut(BaseModel):
    id: int
    kind: str
    title: str
    query: dict[str, Any]
    options: dict[str, Any]
    layout: dict[str, Any]
    sort_order: int


class SharedTarget(BaseModel):
    id: int
    name: str


class SharedTeam(SharedTarget):
    site_name: str


class SharedWith(BaseModel):
    """Whom a ``shared`` dashboard is shared with, by name (empty lists otherwise)."""

    roles: list[SharedTarget]
    sites: list[SharedTarget]
    teams: list[SharedTeam]
    users: list[SharedTarget]


class ShareableUser(BaseModel):
    """One person the dashboard builder may share with."""

    id: int
    name: str
    job_title: str | None
    site_names: list[str]


class DashboardSummary(BaseModel):
    id: int
    name: str
    description: str | None
    visibility: str
    role_ids: list[int]
    site_ids: list[int]
    team_ids: list[int]
    user_ids: list[int]
    shared_with: SharedWith
    owner_id: int | None
    owner_name: str | None
    is_default: bool
    widget_count: int
    can_edit: bool
    updated_at: datetime


class DashboardOut(DashboardSummary):
    widgets: list[DashboardWidgetOut]


# The visibilities and widget kinds above mirror the model constants.
assert get_args(Visibility) == DASHBOARD_VISIBILITIES
assert get_args(WidgetKind) == DASHBOARD_WIDGET_KINDS
