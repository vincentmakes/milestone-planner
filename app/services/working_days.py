"""
The working-day rule (2.5.0), server side.

A day is a **working day** when it falls Monday to Friday or, with the
instance setting ``weekend_working_days`` on (Settings -> General -> *Weekends
are working days*, off by default), on any day of the week. Bank holidays,
closures, blocks and absences are the caller's *off days*, taken away on top.

The dashboards' engine (``app/services/metrics.py``) counts every working day
through this module. Mirror of ``frontend/src/utils/workingDays.ts``
(``isWorkingDay`` / ``countWorkingDays``, used by the Staff heatmap, the
availability badges and the Gantt tooltip): both sides share
``WORKING_DAY_CASES`` and ``COUNT_CASES`` in ``tests/test_working_days.py``
-- change one, change both.

Import-light: no models, no SQLAlchemy.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Mapping, Sequence
from datetime import date
from types import MappingProxyType

# Working days in a calendar week, by the setting: ``booked_weeks``,
# ``project_weeks`` and ``phase_weeks`` divide their days by it.
WORKING_DAYS_PER_WEEK: Mapping[bool, int] = MappingProxyType({False: 5, True: 7})


def is_working_day(day: date, weekends_working: bool) -> bool:
    """Whether ``day`` is a working day: Monday to Friday, or any day with weekends on."""
    return weekends_working or day.weekday() < 5


def count_working_days(
    a: date,
    b: date,
    *,
    weekends_working: bool = False,
    off_days: Sequence[date] = (),
) -> int:
    """
    The working days of ``[a, b]`` (0 when ``b < a``) minus the ``off_days``
    in it, counted arithmetically, never by expanding the range.

    ``off_days`` is sorted and unique; an off day that is no working day (a
    Saturday holiday with weekends off) takes nothing away.
    """
    if b < a:
        return 0
    days = (b - a).days + 1
    if weekends_working:
        total = days
    else:
        weeks, rest = divmod(days, 7)
        first = a.weekday()
        total = weeks * 5 + sum(1 for i in range(rest) if (first + i) % 7 < 5)
    low = bisect_left(off_days, a)
    high = bisect_right(off_days, b)
    inside = sum(1 for i in range(low, high) if is_working_day(off_days[i], weekends_working))
    return total - inside
