"""
Base schema classes with custom serialization.

This module provides datetime/date serialization that matches Node.js output.

TIMEZONE ISSUE EXPLAINED:
-------------------------
The database stores timestamps as LOCAL TIME (CET/CEST) in TIMESTAMP WITHOUT TIME ZONE columns.
For example, an event at 10:01:16 CET is stored as "10:01:16" (no timezone info).

Node.js behavior:
- Reads "10:01:16" from DB
- Treats it as if it were UTC
- Outputs "09:01:16Z" (JavaScript Date interprets DB time and subtracts local offset)

Python/asyncpg behavior:
- Reads "10:01:16" from DB as naive datetime
- Outputs "10:01:16" as-is

LONG-TERM FIX (recommended for future):
1. Use TIMESTAMPTZ columns instead of TIMESTAMP
2. Store all times explicitly in UTC: NOW() AT TIME ZONE 'UTC'
3. Migrate existing data to UTC
4. Node.js: Use explicit UTC storage in INSERT/UPDATE

FOR NOW:
We subtract 1 hour from datetime output to match Node.js behavior.
This maintains API compatibility with the existing frontend.

NOTE: This assumes CET (UTC+1). During CEST (summer), this would be incorrect.
A proper fix should use the actual server timezone offset.
"""

import calendar
from datetime import date, datetime, timedelta
from typing import Annotated

from pydantic import BaseModel, ConfigDict, PlainSerializer


def is_dst_europe(dt: datetime | date) -> bool:
    """
    Check if a date is in European Summer Time (CEST).

    DST in Europe: Last Sunday of March to last Sunday of October.
    """
    if isinstance(dt, datetime):
        year = dt.year
        month = dt.month
        day = dt.day
    else:
        year = dt.year
        month = dt.month
        day = dt.day

    if month < 3 or month > 10:
        return False
    if month > 3 and month < 10:
        return True

    # March: DST starts last Sunday
    if month == 3:
        # Find last Sunday of March
        last_day = calendar.monthrange(year, 3)[1]
        last_sunday = last_day - (calendar.weekday(year, 3, last_day) + 1) % 7
        return day >= last_sunday

    # October: DST ends last Sunday
    if month == 10:
        last_day = calendar.monthrange(year, 10)[1]
        last_sunday = last_day - (calendar.weekday(year, 10, last_day) + 1) % 7
        return day < last_sunday

    return False


def get_utc_offset_hours(dt: datetime | date) -> int:
    """Get UTC offset in hours for Europe/Zurich timezone."""
    return 2 if is_dst_europe(dt) else 1


def serialize_datetime_js(dt: datetime | None) -> str | None:
    """
    Serialize datetime to match JavaScript's toISOString().

    Node.js outputs: "2025-12-08T09:01:16.715Z" for DB value "10:01:16"

    We subtract the appropriate offset (1h for CET, 2h for CEST).
    """
    if dt is None:
        return None

    # Get the UTC offset for this specific date
    offset_hours = get_utc_offset_hours(dt)
    adjusted = dt - timedelta(hours=offset_hours)

    # Format with milliseconds and Z suffix
    formatted = adjusted.strftime("%Y-%m-%dT%H:%M:%S")
    ms = adjusted.microsecond // 1000
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
