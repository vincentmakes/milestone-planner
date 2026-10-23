"""
Dashboards (2.1.0): the metric-query spec, widget and dashboard bodies, responses.

``MetricQuery`` is what a widget asks the metric engine
(``app/services/metrics.py``): a measure, up to two dimensions, filters with a
period, an optional percentage and top N. Every refusal is a 422 in plain
words (``PydanticCustomError``, no "Value error," prefix), including the
validity matrix (``metrics.MATRIX``): "<measure> cannot be broken down by
<dimension>". The engine's constants are the one source; this module imports
them, never the reverse.

``WidgetIn`` / ``DashboardIn`` are the write bodies. A widget's ``query``,
``options`` and ``layout`` travel as JSON objects both ways; the router stores
them as compact JSON text. A widget that fails validation is named by its
title in the 422.
"""

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
from app.services.metrics import (
    DIMENSION_LABELS,
    MAX_PERIOD_DAYS,
    PERIOD_TOO_LONG_DETAIL,
    matrix_error,
)

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
]
Grain = Literal["year", "quarter", "month", "week"]
RelativeName = Literal[
    "this_year", "last_year", "this_quarter", "last_quarter", "last_12_months", "all"
]
WidgetKind = Literal["kpi", "bar", "line", "pie", "table"]
Visibility = Literal["private", "roles", "everyone"]

# Ids per filter list and widgets per dashboard (bounds on one request).
MAX_FILTER_IDS = 500
MAX_WIDGETS = 50


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


class MetricFilters(_Strict):
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
    period: Period = Field(default_factory=lambda: RelativePeriod(relative="this_year"))


class MetricQuery(_Strict):
    measure: Measure
    dimensions: list[Dimension] = Field(default_factory=list)
    filters: MetricFilters = Field(default_factory=MetricFilters)
    percent_of: Literal["total", "first_dimension"] | None = None
    top_n: int | None = Field(default=None, ge=1, le=50)

    @model_validator(mode="after")
    def _check_query(self) -> "MetricQuery":
        if len(self.dimensions) > 2:
            raise _error("A widget can be broken down by two dimensions at most")
        kinds = [d.kind for d in self.dimensions]
        if len(set(kinds)) != len(kinds):
            raise _error("The two dimensions must be different")
        for kind in kinds:
            message = matrix_error(self.measure, kind)
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


class WidgetOptions(_Strict):
    stacked: bool | None = None
    percent: bool | None = None
    orientation: Literal["horizontal", "vertical"] | None = None
    number_format: Literal["integer", "decimal", "percent"] | None = None
    show_legend: bool | None = None
    # The KPI's bucket when ``percent_of`` is set: the dimension value's key.
    kpi_bucket: bool | int | str | None = None


class GridPosition(_Strict):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    w: int = Field(ge=1)
    h: int = Field(ge=1)


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


class DashboardIn(_Strict):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    visibility: Visibility = "private"
    role_ids: list[int] = Field(default_factory=list, max_length=200)
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


class DashboardSummary(BaseModel):
    id: int
    name: str
    description: str | None
    visibility: str
    role_ids: list[int]
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
