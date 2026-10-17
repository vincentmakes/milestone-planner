"""
Validation for user-supplied dates and date ranges.

``parse_day`` / ``parse_day_range`` turn ``YYYY-MM-DD`` query strings into
dates with a 400 on bad input (instead of an unhandled ``ValueError`` or an
asyncpg ``DataError`` -> 500); ``ensure_date_order`` is the handler-side
counterpart of ``app.schemas.base.DateRangeOrdered`` for partial updates.

The availability endpoints build one entry per day on the event loop, so an
unbounded range (``0001-01-01..9999-12-31`` is ~3.65 M days) stalls the worker
and can exhaust its memory, and a malformed date used to surface as an opaque
500. Parse strictly, require ``start <= end`` and cap the span.
"""

from datetime import date, datetime

from fastapi import HTTPException, status

from app.schemas.base import DATE_ORDER_MESSAGE

# Inclusive day count: a full leap year fits.
MAX_DAY_RANGE = 366


def parse_day(value: str, name: str) -> date:
    """Parse one ``YYYY-MM-DD`` query value; 400 naming the parameter otherwise."""
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{name} must be a valid date (YYYY-MM-DD)",
        ) from None


def ensure_date_order(start: date | None, end: date | None) -> None:
    """422 when a (merged) range ends before it starts; ``None`` bounds pass."""
    if start is not None and end is not None and end < start:
        raise HTTPException(status_code=422, detail=DATE_ORDER_MESSAGE)


def exceeds_max_span(start: date, end: date, *, max_days: int = MAX_DAY_RANGE) -> bool:
    """True when the inclusive ``start..end`` span holds more than ``max_days`` days."""
    return (end - start).days + 1 > max_days


def parse_day_range(
    start_value: str, end_value: str, *, max_days: int = MAX_DAY_RANGE
) -> tuple[date, date]:
    """Parse ``YYYY-MM-DD`` bounds; 400 on bad input, inverted or oversized ranges."""
    try:
        start = datetime.strptime(start_value, "%Y-%m-%d").date()
        end = datetime.strptime(end_value, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="startDate and endDate must be valid dates (YYYY-MM-DD)",
        ) from None

    if start > end:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="startDate must be on or before endDate",
        )

    if exceeds_max_span(start, end, max_days=max_days):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Date range must not exceed {max_days} days",
        )

    return start, end
