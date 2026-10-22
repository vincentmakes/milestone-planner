/**
 * The click rules of the date range picker, as pure functions over
 * `YYYY-MM-DD` strings (compared as strings — the format sorts by date).
 *
 * The first click sets the start, the next the end (booking.com style). The
 * end never precedes the start: a start picked after the end drags the end
 * along by the same number of days, and an end picked before the start
 * becomes the new start (same shift) while the end is still awaited. Day
 * counts go through `daysBetweenDateStrings` / `addDaysToDateString`, which
 * are local-calendar and DST-safe.
 */

import { addDaysToDateString, daysBetweenDateStrings } from '@/utils/date';

/** `YYYY-MM-DD`, or `''` for no date — never a `Date` across the component boundary. */
export type IsoDate = string;

/** What an empty field shows. */
export const DATE_PLACEHOLDER = 'Pick a date';

/** Keys that open the calendar from a focused field (plain focus never does, so Tab passes through). */
export const OPEN_KEYS: ReadonlySet<string> = new Set(['Enter', ' ', 'ArrowDown']);

/** The field whose turn it is: the next click fills it. */
export type ActiveField = 'start' | 'end';

export interface DateRangeValue {
  start: IsoDate;
  end: IsoDate;
}

export interface RangeState extends DateRangeValue {
  active: ActiveField;
}

export interface RangeClickResult extends RangeState {
  /** The range is complete: close the picker and focus the End field. */
  done: boolean;
}

/** Days from start to end, 0 when either is missing. */
function durationOf({ start, end }: DateRangeValue): number {
  return start && end ? daysBetweenDateStrings(start, end) : 0;
}

/** Move the start to `day`, the end following by the current duration (an empty end stays empty). */
function moveStart(range: DateRangeValue, day: IsoDate): DateRangeValue {
  return { start: day, end: range.end ? addDaysToDateString(day, durationOf(range)) : '' };
}

/** Apply one click on `clicked` to the range; one call per click, so a shift is atomic. */
export function applyRangeClick(state: RangeState, clicked: IsoDate): RangeClickResult {
  const { start, end } = state;

  if (state.active === 'start' || !start) {
    if (end && clicked > end) return { ...moveStart(state, clicked), active: 'end', done: false };
    return { start: clicked, end, active: 'end', done: false };
  }

  if (clicked < start) return { ...moveStart(state, clicked), active: 'end', done: false };
  return { start, end: clicked, active: 'end', done: true };
}

/**
 * With an optional end (bank holidays, company events) an end equal to the
 * start means "the same day" and is emitted as `''`, so the forms' payload
 * code (`endDate || null`) and dirty checks keep working unchanged.
 */
export function collapseOptionalEnd(range: DateRangeValue, endOptional: boolean): DateRangeValue {
  return { start: range.start, end: endOptional && range.end === range.start ? '' : range.end };
}

/** The range a click on `hovered` would produce, for the hover preview (null when incomplete). */
export function previewRange(state: RangeState, hovered: IsoDate): { from: IsoDate; to: IsoDate } | null {
  const next = applyRangeClick(state, hovered);
  return next.start && next.end ? { from: next.start, to: next.end } : null;
}

const firstOfMonth = (day: IsoDate): IsoDate => `${day.slice(0, 8)}01`;

/**
 * The first month the calendar shows when it opens (`YYYY-MM-01`): the active
 * field's month, or the start's when the end sits in the very next month and
 * two months are shown (the whole range is then visible), else today's.
 */
export function initialMonth(state: RangeState, numberOfMonths: number, today: IsoDate): IsoDate {
  const { start, end } = state;
  const focus = state.active === 'end' ? end || start : start || end;
  if (!focus) return firstOfMonth(today);

  const month = firstOfMonth(focus);
  if (numberOfMonths > 1 && state.active === 'end' && start && end) {
    const startMonth = firstOfMonth(start);
    if (addDaysToDateString(month, -1).slice(0, 7) === startMonth.slice(0, 7)) return startMonth;
  }
  return month;
}

/** A day kept within the optional bounds (`minDate` / `maxDate`); empty stays empty. */
export function clampDay(day: IsoDate, minDate?: IsoDate, maxDate?: IsoDate): IsoDate {
  if (!day) return day;
  if (minDate && day < minDate) return minDate;
  if (maxDate && day > maxDate) return maxDate;
  return day;
}
