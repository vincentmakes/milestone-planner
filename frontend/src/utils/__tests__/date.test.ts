/**
 * date.ts helpers that are not timezone-specific (those live in
 * date.newYork.test.ts): period navigation, ISO weeks, ranges,
 * the medium date and the date-time of a timestamp.
 */
import { describe, it, expect } from 'vitest';
import {
  navigateDate,
  getISOWeekNumber,
  formatWeekNumber,
  getPeriodLabel,
  doRangesOverlap,
  getRangeOverlap,
  toInputDateFormat,
  formatDateISO,
  formatQuarter,
  formatMediumDate,
  formatDateTime,
} from '../date';

const ymd = (d: Date) => formatDateISO(d);

describe('navigateDate', () => {
  it('clamps month steps to the month end', () => {
    expect(ymd(navigateDate(new Date(2026, 0, 31), 1, 'month'))).toBe('2026-02-28');
    expect(ymd(navigateDate(new Date(2026, 2, 31), -1, 'month'))).toBe('2026-02-28');
    expect(ymd(navigateDate(new Date(2025, 10, 30), 1, 'quarter'))).toBe('2026-02-28');
    expect(ymd(navigateDate(new Date(2028, 1, 29), 1, 'year'))).toBe('2029-02-28');
  });

  it('steps whole weeks', () => {
    expect(ymd(navigateDate(new Date(2026, 2, 27), -1, 'week'))).toBe('2026-03-20');
  });
});

describe('ISO weeks', () => {
  it('numbers weeks by ISO 8601 (week 1 holds the first Thursday)', () => {
    // Fri Jan 1 2027 belongs to week 53 of 2026.
    expect(getISOWeekNumber(new Date(2027, 0, 1))).toBe(53);
    expect(formatWeekNumber(new Date(2027, 0, 1))).toBe('W53');
    expect(getISOWeekNumber(new Date(2027, 0, 4))).toBe(1);
    // Mon Dec 29 2025 is already week 1 of 2026.
    expect(getISOWeekNumber(new Date(2025, 11, 29))).toBe(1);
  });

  it('labels a week with its ISO week-numbering year', () => {
    expect(getPeriodLabel(new Date(2027, 0, 1), 'week')).toBe('Week 53, 2026');
    expect(getPeriodLabel(new Date(2025, 11, 29), 'week')).toBe('Week 1, 2026');
    expect(getPeriodLabel(new Date(2026, 4, 10), 'quarter')).toBe(formatQuarter(new Date(2026, 4, 10)));
    expect(getPeriodLabel(new Date(2026, 4, 10), 'year')).toBe('2026');
  });
});

describe('ranges', () => {
  it('detects overlap including touching ends', () => {
    const d = (n: number) => new Date(2026, 2, n);
    expect(doRangesOverlap(d(1), d(5), d(5), d(9))).toBe(true);
    expect(doRangesOverlap(d(1), d(4), d(5), d(9))).toBe(false);
    expect(getRangeOverlap(d(1), d(6), d(4), d(9))).toEqual({ start: d(4), end: d(6) });
    expect(getRangeOverlap(d(1), d(2), d(4), d(9))).toBeNull();
  });
});

describe('toInputDateFormat', () => {
  it('extracts the calendar date from either wire form', () => {
    expect(toInputDateFormat('2026-03-02T00:00:00.000Z')).toBe('2026-03-02');
    expect(toInputDateFormat('2026-03-02')).toBe('2026-03-02');
    expect(toInputDateFormat(null)).toBe('');
  });
});

describe('formatMediumDate', () => {
  const medium = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  it('shows a model date in the browser locale with a short month', () => {
    expect(formatMediumDate('2026-10-22')).toBe(medium.format(new Date(2026, 9, 22)));
    expect(formatMediumDate('2026-10-22')).toMatch(/22/);
    expect(formatMediumDate('2026-10-22')).toMatch(/2026/);
  });

  it('reads the midnight ISO form as the same calendar day', () => {
    expect(formatMediumDate('2026-03-02T00:00:00.000Z')).toBe(medium.format(new Date(2026, 2, 2)));
  });

  it('is empty for no date', () => {
    expect(formatMediumDate('')).toBe('');
  });
});

describe('formatDateTime', () => {
  const dateTime = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  it('shows a timestamp as local date and time, short month, no seconds', () => {
    const iso = '2026-11-03T08:07:09.000Z';
    expect(formatDateTime(iso)).toBe(dateTime.format(new Date(iso)));
    expect(formatDateTime(iso)).toMatch(/2026/);
    expect(formatDateTime(iso)).not.toMatch(/:09/); // the seconds are dropped
  });

  it('is empty for a value that is not a timestamp (the caller picks the placeholder)', () => {
    expect(formatDateTime('not a date')).toBe('');
    expect(formatDateTime('')).toBe('');
  });
});
