"""
Recurring absences (app/services/absence_patterns.py).

``PATTERN_CASES`` is shared with ``frontend/src/utils/__tests__/recurringVacation.test.ts``
(``parseRecurringPattern``): each case is ``(description, days)`` where
``days`` is the sorted list of JavaScript day numbers (0 = Sunday) or None when
the description is no recurring pattern. The TypeScript side compares
``parseRecurringPattern(description)?.daysOfWeek ?? null`` with ``days``
(``None`` = ``undefined`` there for the empty description). Change one, change
both.
"""

from datetime import date

import pytest

from app.services.absence_patterns import absence_weekdays, js_weekday, parse_recurring_days

PATTERN_CASES: list[tuple[str | None, list[int] | None]] = [
    # Recognised: the prefix opens the description.
    ("[R:1,3] Home office", [1, 3]),
    ("[R:1,3]", [1, 3]),
    ("[R:1,3]Home office", [1, 3]),
    ("[R:3,1] Part-time", [1, 3]),
    ("[R:0] Sunday", [0]),
    ("[R:1] Monday", [1]),
    ("[R:6,0] Weekend", [0, 6]),
    ("[R:0,1,2,3,4,5,6] Every day", [0, 1, 2, 3, 4, 5, 6]),
    ("[R:5] [R:1] Two prefixes", [5]),
    # Not recognised: a plain absence.
    (None, None),
    ("", None),
    ("Holidays", None),
    (" [R:1] Leading space", None),
    ("Home office [R:1]", None),
    ("[R:7] Out of range", None),
    ("[R:1,7] One out of range", None),
    ("[R:13] Two digits", None),
    ("[R:] Empty", None),
    ("[R:1,] Trailing comma", None),
    ("[R:,1] Leading comma", None),
    ("[R: 1] Space", None),
    ("[R:1, 3] Space after comma", None),
    ("[r:1] Lower case", None),
    ("[R:1;3] Semicolon", None),
    ("[R:1,3 Unclosed", None),
    ("R:1 No brackets", None),
]


@pytest.mark.parametrize(("description", "days"), PATTERN_CASES)
def test_parse_recurring_days(description, days):
    parsed = parse_recurring_days(description)
    assert (sorted(parsed) if parsed is not None else None) == days


def test_a_repeated_day_counts_once():
    # The TypeScript side keeps the duplicate in its array; the set is the same.
    assert parse_recurring_days("[R:3,1,3]") == frozenset({1, 3})


@pytest.mark.parametrize(
    ("day", "expected"),
    [
        ("2026-03-01", 0),  # Sunday
        ("2026-03-02", 1),  # Monday
        ("2026-03-04", 3),  # Wednesday
        ("2026-03-07", 6),  # Saturday
    ],
)
def test_js_weekday(day, expected):
    assert js_weekday(date.fromisoformat(day)) == expected


def _days(start: str, end: str, days: frozenset[int] | None) -> list[str]:
    return [
        day.isoformat()
        for day in absence_weekdays(date.fromisoformat(start), date.fromisoformat(end), days)
    ]


def test_a_plain_absence_takes_every_weekday():
    # Sunday 1 March .. Monday 9 March 2026.
    assert _days("2026-03-01", "2026-03-09", None) == [
        "2026-03-02",
        "2026-03-03",
        "2026-03-04",
        "2026-03-05",
        "2026-03-06",
        "2026-03-09",
    ]


def test_a_recurring_absence_takes_its_days_between_its_dates():
    assert _days("2026-03-01", "2026-03-09", frozenset({1})) == ["2026-03-02", "2026-03-09"]
    # Mondays and Wednesdays of March 2026: 5 + 4.
    assert len(_days("2026-03-01", "2026-03-31", frozenset({1, 3}))) == 9


def test_a_weekend_pattern_takes_no_weekday():
    assert _days("2026-03-01", "2026-03-31", frozenset({0, 6})) == []
    assert _days("2026-03-01", "2026-03-01", frozenset({0})) == []


def test_an_inverted_range_is_empty():
    assert _days("2026-03-09", "2026-03-02", None) == []
