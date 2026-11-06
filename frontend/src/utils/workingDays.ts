/**
 * The working-day rule (2.5.0), client side.
 *
 * A day is a **working day** when it falls Monday to Friday or, with the
 * instance setting `weekend_working_days` on (Settings → General → *Weekends
 * are working days*, off by default; read it with `selectWeekendsWorking`),
 * on any day of the week. Bank holidays, closures and absences are the
 * caller's off days, taken away on top.
 *
 * Used by the Staff heatmap (`calculateWorkloadCells`), the availability
 * badges (`StaffView`, `ResourceCard`), the Gantt's Shift-hover work days
 * and its weekend absence markers. Mirror of `app/services/working_days.py`
 * (`is_working_day` / `count_working_days`, which the dashboards count
 * with): both sides share `WORKING_DAY_CASES` and `COUNT_CASES`
 * (`tests/test_working_days.py` ↔ `utils/__tests__/workingDayMirror.test.ts`)
 * — change one, change both.
 *
 * Dates are model date strings (`YYYY-MM-DD`, or the midnight ISO form),
 * read through `parseLocalDate` — never `new Date(str)`.
 */

import { daysBetweenDateStrings, parseLocalDate, toDateOnly } from './date';

/**
 * Working days in a calendar week, by the setting (the backend's
 * `WORKING_DAYS_PER_WEEK[weekends_working]`, the dashboards' weeks divisor).
 */
export function workingDaysPerWeek(weekendsWorking: boolean): 5 | 7 {
  return weekendsWorking ? 7 : 5;
}

/** Whether `dateStr` is a working day: Monday to Friday, or any day with weekends on. */
export function isWorkingDay(dateStr: string, weekendsWorking: boolean): boolean {
  if (weekendsWorking) return true;
  const day = parseLocalDate(dateStr).getDay();
  return day !== 0 && day !== 6;
}

export interface CountWorkingDaysOptions {
  /** Saturdays and Sundays count (the setting); default off */
  weekendsWorking?: boolean;
  /** `YYYY-MM-DD` off days (holidays, …); one that is no working day takes nothing away */
  offDays?: Iterable<string>;
}

/**
 * The working days of `[start, end]` (0 when `end` is before `start`) minus
 * the off days in it, counted arithmetically, never by walking the range.
 */
export function countWorkingDays(
  start: string,
  end: string,
  { weekendsWorking = false, offDays = [] }: CountWorkingDaysOptions = {}
): number {
  const first = toDateOnly(start);
  const last = toDateOnly(end);
  const days = daysBetweenDateStrings(first, last) + 1;
  if (!(days > 0)) return 0;
  let total: number;
  if (weekendsWorking) {
    total = days;
  } else {
    const weeks = Math.floor(days / 7);
    // Monday = 0 … Sunday = 6, like Python's `date.weekday()`.
    const firstWeekday = (parseLocalDate(first).getDay() + 6) % 7;
    total = weeks * 5;
    for (let i = 0; i < days % 7; i++) {
      if ((firstWeekday + i) % 7 < 5) total++;
    }
  }
  let inside = 0;
  for (const day of new Set(offDays)) {
    if (day >= first && day <= last && isWorkingDay(day, weekendsWorking)) inside++;
  }
  return total - inside;
}
