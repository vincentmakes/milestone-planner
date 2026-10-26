"""
Base schema classes with custom serialization.

This module provides datetime/date serialization that matches Node.js output
(``Date.prototype.toISOString()``: ``YYYY-MM-DDTHH:MM:SS.mmmZ``).

Every ``TIMESTAMP`` column is naive and holds UTC: the app writes
``app.utils.utcnow_naive()`` and both the default and the per-tenant engines
pin the connection ``timezone`` to UTC, so ``DEFAULT CURRENT_TIMESTAMP`` is UTC
too. A naive value is therefore serialised as-is with a ``Z`` suffix - no
local-offset shift. Pure dates are calendar days and serialise as midnight UTC.
"""

from datetime import UTC, date, datetime
from typing import Annotated, Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel, BeforeValidator, ConfigDict, PlainSerializer, model_validator

T = TypeVar("T")

# A "#rrggbb" hex colour (tags, tag groups, teams).
COLOR_PATTERN = "^#[0-9A-Fa-f]{6}$"


def serialize_datetime_js(dt: datetime | None) -> str | None:
    """
    Serialize a datetime like JavaScript's ``toISOString()``.

    Naive values are UTC (see the module docstring) and are output unchanged,
    e.g. ``2025-12-08 09:01:16.715`` -> ``"2025-12-08T09:01:16.715Z"``. An
    aware value is converted to UTC first.
    """
    if dt is None:
        return None

    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC)

    # Format with milliseconds and Z suffix
    formatted = dt.strftime("%Y-%m-%dT%H:%M:%S")
    ms = dt.microsecond // 1000
    return f"{formatted}.{ms:03d}Z"


def serialize_date_as_datetime_js(d: date | None) -> str | None:
    """
    Serialize date as datetime at midnight UTC, matching Node.js.

    Node.js typically outputs dates as midnight UTC:
    Example: 2025-01-01 in DB -> "2025-01-01T00:00:00.000Z" in JSON

    NOTE: We do NOT apply timezone offset for pure dates because:
    1. Dates in the database represent calendar days, not specific moments in time
    2. Applying timezone offset causes off-by-one day errors in frontend calculations
    3. Node.js treats DATE columns as calendar dates at midnight UTC
    """
    if d is None:
        return None

    # Return as midnight UTC - no timezone adjustment for dates
    return f"{d.year:04d}-{d.month:02d}-{d.day:02d}T00:00:00.000Z"


def serialize_date_simple(d: date | None) -> str | None:
    """
    Serialize date as simple ISO date string (YYYY-MM-DD).
    Use this when dates should stay as dates (not converted to datetime).
    """
    if d is None:
        return None
    return d.isoformat()


# Annotated types for Pydantic v2 serialization
DateTimeJS = Annotated[datetime, PlainSerializer(serialize_datetime_js, return_type=str)]
DateAsDateTimeJS = Annotated[date, PlainSerializer(serialize_date_as_datetime_js, return_type=str)]
DateSimple = Annotated[date, PlainSerializer(serialize_date_simple, return_type=str)]


class BaseSchema(BaseModel):
    """
    Base schema class with standard configuration.
    Use DateTimeJS, DateAsDateTimeJS, or DateSimple types for fields.
    """

    model_config = ConfigDict(
        from_attributes=True,
    )


# ---------------------------------------------------------------------------
# Date ranges
# ---------------------------------------------------------------------------

DATE_ORDER_MESSAGE = "end_date must be on or after start_date"


class DateRangeOrdered(BaseModel):
    """
    Mixin for request bodies with ``start_date`` / ``end_date``: an inverted
    range is a 422 validation error. Only checked when both are present, so
    partial updates pass here -- their handler checks the merged row with
    ``app.services.date_range.ensure_date_order``.
    """

    @model_validator(mode="after")
    def _check_date_order(self):
        start = getattr(self, "start_date", None)
        end = getattr(self, "end_date", None)
        if start is not None and end is not None and end < start:
            raise ValueError(DATE_ORDER_MESSAGE)
        return self


def _blank_as_none(value: object) -> object:
    """Surrounding whitespace dropped; a blank string becomes ``None``."""
    if isinstance(value, str):
        return value.strip() or None
    return value


# An optional free-text field (a booking's comment or note): blank or
# whitespace-only is no text at all. The length limit is the field's own
# ``Field(max_length=...)``, checked after the strip.
OptionalText = Annotated[str | None, BeforeValidator(_blank_as_none)]


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------


class PaginationParams:
    """FastAPI dependency for pagination query parameters.

    Usage::

        @router.get("/items")
        async def list_items(pagination: PaginationParams = Depends()):
            query = select(Item).offset(pagination.offset).limit(pagination.limit)
    """

    def __init__(
        self,
        offset: int = Query(0, ge=0, description="Number of items to skip"),
        limit: int = Query(50, ge=1, le=200, description="Max items to return"),
    ):
        self.offset = offset
        self.limit = limit


class PaginatedResponse(BaseSchema, Generic[T]):
    """Paginated response wrapper."""

    items: list[T]
    total: int
    offset: int
    limit: int
