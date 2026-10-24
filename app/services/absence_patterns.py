"""
Recurring absences (``[R:d,...]`` in ``vacations.description``), server side.

An absence whose description starts with ``[R:1,3]`` applies only on those
days of the week between its dates. The digits are JavaScript day numbers:
**0 = Sunday**, 1 = Monday ... 6 = Saturday (a Python ``date`` gives it as
``isoweekday() % 7``). Mirror of ``parseRecurringPattern`` in
``frontend/src/utils/recurringVacation.ts`` (the same regex: the pattern must
open the description, digits 0-6 only, comma-separated, no spaces); both
sides share ``PATTERN_CASES`` in ``tests/test_absence_patterns.py`` -- change
one, change both.

Import-light: no models, no SQLAlchemy.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import date, timedelta

# ``^\[R:([0-6](?:,[0-6])*)\]`` in recurringVacation.ts (``re.match`` anchors
# at the start like ``^``).
RECURRING_PATTERN = re.compile(r"\[R:([0-6](?:,[0-6])*)\]")


def js_weekday(day: date) -> int:
    """The JavaScript day of the week of ``day`` (0 = Sunday ... 6 = Saturday)."""
    return day.isoweekday() % 7


def parse_recurring_days(description: str | None) -> frozenset[int] | None:
    """
    The days of the week of a recurring absence, or None when ``description``
    carries no ``[R:...]`` prefix (a plain absence: every day of its range).
    """
    if not description:
        return None
    match = RECURRING_PATTERN.match(description)
    if match is None:
        return None
    return frozenset(int(digit) for digit in match.group(1).split(","))


def absence_weekdays(start: date, end: date, days: frozenset[int] | None) -> Iterator[date]:
    """
    The Monday-to-Friday days of ``[start, end]`` an absence takes: every one
    for a plain absence (``days`` None), else those whose ``js_weekday`` is in
    ``days`` (a Saturday or Sunday pattern day takes no weekday).
    """
    day = start
    while day <= end:
        if day.weekday() < 5 and (days is None or js_weekday(day) in days):
            yield day
        day += timedelta(days=1)
