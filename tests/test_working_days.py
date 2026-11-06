"""
The working-day rule (app/services/working_days.py).

``WORKING_DAY_CASES`` and ``COUNT_CASES`` are shared with
``frontend/src/utils/__tests__/workingDayMirror.test.ts`` (``isWorkingDay`` /
``countWorkingDays`` in ``frontend/src/utils/workingDays.ts``): the dashboards
count working days with this module, the Staff heatmap, the availability
badges and the Gantt tooltip with the TypeScript one, and they only agree
while both sides answer these tables the same way. Change one, change both.

- ``WORKING_DAY_CASES``: ``(date, weekends_working, holiday, expected)`` --
  whether the day counts as a working day when it is (``holiday``) or is not
  one of the caller's off days.
- ``COUNT_CASES``: ``(start, end, weekends_working, off_days, expected)`` --
  the working days of ``[start, end]`` minus the off days in it.

2 March 2026 is a Monday.
"""

from datetime import date

import pytest

from app.services.working_days import (
    WORKING_DAYS_PER_WEEK,
    count_working_days,
    is_working_day,
)

WORKING_DAY_CASES: list[tuple[str, bool, bool, bool]] = [
    # Weekends off (the default): Monday to Friday.
    ("2026-03-02", False, False, True),  # Monday
    ("2026-03-04", False, False, True),  # Wednesday
    ("2026-03-06", False, False, True),  # Friday
    ("2026-03-07", False, False, False),  # Saturday
    ("2026-03-08", False, False, False),  # Sunday
    ("2026-03-04", False, True, False),  # a weekday holiday
    ("2026-03-07", False, True, False),  # a Saturday holiday: no working day anyway
    # Weekends on: every day.
    ("2026-03-02", True, False, True),
    ("2026-03-06", True, False, True),
    ("2026-03-07", True, False, True),
    ("2026-03-08", True, False, True),
    ("2026-03-04", True, True, False),
    ("2026-03-07", True, True, False),  # a Saturday holiday now takes a day
    ("2026-03-08", True, True, False),
    # Month and year ends.
    ("2026-02-28", False, False, False),  # Saturday
    ("2026-02-28", True, False, True),
    ("2026-12-31", False, False, True),  # Thursday
    ("2027-01-03", False, False, False),  # Sunday
    ("2027-01-03", True, False, True),
]

COUNT_CASES: list[tuple[str, str, bool, list[str], int]] = [
    # One week, Monday to Sunday.
    ("2026-03-02", "2026-03-08", False, [], 5),
    ("2026-03-02", "2026-03-08", True, [], 7),
    # Friday to Monday: the weekend counts only when on.
    ("2026-03-06", "2026-03-09", False, [], 2),
    ("2026-03-06", "2026-03-09", True, [], 4),
    # Saturday to Sunday alone.
    ("2026-03-07", "2026-03-08", False, [], 0),
    ("2026-03-07", "2026-03-08", True, [], 2),
    # A single day.
    ("2026-03-04", "2026-03-04", False, [], 1),
    ("2026-03-07", "2026-03-07", False, [], 0),
    ("2026-03-07", "2026-03-07", True, [], 1),
    # An empty range.
    ("2026-03-08", "2026-03-02", False, [], 0),
    ("2026-03-08", "2026-03-02", True, [], 0),
    # Off days: a weekday holiday, a Saturday one, one outside the range.
    ("2026-03-02", "2026-03-08", False, ["2026-03-04"], 4),
    ("2026-03-02", "2026-03-08", False, ["2026-03-07"], 5),
    ("2026-03-02", "2026-03-08", True, ["2026-03-07"], 6),
    ("2026-03-02", "2026-03-08", True, ["2026-03-04", "2026-03-07", "2026-03-08"], 4),
    ("2026-03-02", "2026-03-06", False, ["2026-03-01", "2026-03-09"], 5),
    # An off day in the midnight ISO form, on the range's last day.
    ("2026-03-02", "2026-03-06", False, ["2026-03-06T00:00:00.000Z"], 4),
    # All of March 2026: 22 weekdays, 31 days.
    ("2026-03-01", "2026-03-31", False, [], 22),
    ("2026-03-01", "2026-03-31", True, [], 31),
    ("2026-03-01", "2026-03-31", False, ["2026-03-04", "2026-03-11", "2026-03-14"], 20),
    ("2026-03-01", "2026-03-31", True, ["2026-03-04", "2026-03-11", "2026-03-14"], 28),
    # Across a year end.
    ("2026-12-28", "2027-01-03", False, ["2027-01-01"], 4),
    ("2026-12-28", "2027-01-03", True, ["2027-01-01"], 6),
]


def d(text: str) -> date:
    # The calendar day of a date or of its midnight ISO form (the frontend's
    # ``toDateOnly``); the server itself only ever sees ``date`` objects.
    return date.fromisoformat(text[:10])


@pytest.mark.parametrize(("day", "weekends_working", "holiday", "expected"), WORKING_DAY_CASES)
def test_working_day_cases(day, weekends_working, holiday, expected):
    off_days = [d(day)] if holiday else []
    counted = count_working_days(
        d(day), d(day), weekends_working=weekends_working, off_days=off_days
    )
    assert counted == int(expected)
    if not holiday:
        assert is_working_day(d(day), weekends_working) is expected


@pytest.mark.parametrize(("start", "end", "weekends_working", "off_days", "expected"), COUNT_CASES)
def test_count_cases(start, end, weekends_working, off_days, expected):
    counted = count_working_days(
        d(start), d(end), weekends_working=weekends_working, off_days=[d(day) for day in off_days]
    )
    assert counted == expected


def test_the_shared_tables_are_whole():
    # The TypeScript mirror asserts the same lengths.
    assert len(WORKING_DAY_CASES) == 19
    assert len(COUNT_CASES) == 23


def test_the_count_matches_day_by_day_counting():
    """The arithmetic agrees with walking the days, for every start weekday and length."""
    holidays = [d("2026-03-04"), d("2026-03-07"), d("2026-03-16"), d("2026-03-22")]
    for weekends_working in (False, True):
        for first in range(1, 8):
            for length in range(0, 30):
                start = date(2026, 3, first)
                end = date.fromordinal(start.toordinal() + length - 1)
                walked = sum(
                    1
                    for ordinal in range(start.toordinal(), end.toordinal() + 1)
                    if is_working_day(date.fromordinal(ordinal), weekends_working)
                    and date.fromordinal(ordinal) not in holidays
                )
                assert (
                    count_working_days(
                        start, end, weekends_working=weekends_working, off_days=holidays
                    )
                    == walked
                )


def test_off_days_default_to_none_and_weekends_to_off():
    assert count_working_days(d("2026-03-02"), d("2026-03-08")) == 5


def test_working_days_per_week():
    assert WORKING_DAYS_PER_WEEK[False] == 5
    assert WORKING_DAYS_PER_WEEK[True] == 7
