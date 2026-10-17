/**
 * date.ts helpers that are not timezone-specific (those live in
 * date.newYork.test.ts): period navigation, business days, ISO weeks, ranges.
 */
import { describe, it, expect } from 'vitest';
import {
  navigateDate,
  getBusinessDaysBetween,
  addBusinessDays,
  getISOWeekNumber,
  formatWeekNumber,
  getPeriodLabel,
  doRangesOverlap,
  getRangeOverlap,
  toInputDateFormat,
  formatDateISO,
  formatQuarter,
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

describe('business days', () => {
  it('counts weekdays inclusively', () => {
    // Fri 2026-03-06 .. Mon 2026-03-09 → Fri + Mon
    expect(getBusinessDaysBetween(new Date(2026, 2, 6), new Date(2026, 2, 9))).toBe(2);
    expect(getBusinessDaysBetween(new Date(2026, 2, 7), new Date(2026, 2, 8))).toBe(0);
  });

  it('skips weekends when adding', () => {
    expect(ymd(addBusinessDays(new Date(2026, 2, 6), 1))).toBe('2026-03-09');
    expect(ymd(addBusinessDays(new Date(2026, 2, 6), 0))).toBe('2026-03-06');
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
