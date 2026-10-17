/**
 * Period labels, timeline ranges and display formatting in utils/date.ts
 * (navigation, business days and ISO weeks are covered by date.test.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  addDaysToDateString,
  formatDateDisplay,
  formatDateShort,
  formatMonthYear,
  formatQuarter,
  getPeriodLabel,
  getTimelineRange,
  isDateInRange,
  navigateDate,
  toDateOnly,
} from '../date';

const d = (y: number, m: number, day: number) => new Date(y, m, day, 12);
const iso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

describe('period labels', () => {
  it('labels each view mode', () => {
    expect(getPeriodLabel(d(2026, 4, 14), 'month')).toBe('May 2026');
    expect(getPeriodLabel(d(2026, 4, 14), 'quarter')).toBe('Q2 2026');
    expect(getPeriodLabel(d(2026, 4, 14), 'year')).toBe('2026');
    expect(getPeriodLabel(d(2026, 4, 14), 'week')).toBe('Week 20, 2026');
    expect(getPeriodLabel(d(2026, 4, 14), 'decade' as never)).toBe('May 2026');
  });

  it('formats months, quarters and display dates', () => {
    expect(formatMonthYear(d(2026, 0, 1))).toBe('January 2026');
    expect(formatQuarter(d(2026, 11, 31))).toBe('Q4 2026');
    expect(formatDateDisplay(d(2026, 0, 15))).toBe(
      new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(d(2026, 0, 15))
    );
    expect(formatDateShort(d(2026, 0, 15))).toBe(
      new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(d(2026, 0, 15))
    );
  });
});

describe('timeline range', () => {
  it.each([
    ['week', d(2026, 2, 18), '2026-02-16', '2026-04-19'],
    ['month', d(2026, 5, 15), '2026-02-01', '2026-10-31'],
    ['quarter', d(2026, 4, 10), '2025-04-01', '2027-06-30'],
    ['year', d(2026, 4, 10), '2022-01-01', '2030-12-31'],
    ['unknown', d(2026, 5, 15), '2026-02-01', '2026-10-31'],
  ] as const)('spans 4 periods either side in %s view', (mode, center, start, end) => {
    const range = getTimelineRange(center, mode as never);
    expect([iso(range.start), iso(range.end)]).toEqual([start, end]);
  });

  it('honours custom period counts', () => {
    const range = getTimelineRange(d(2026, 5, 15), 'month', 1, 0);
    expect([iso(range.start), iso(range.end)]).toEqual(['2026-05-01', '2026-06-30']);
  });
});

describe('small helpers', () => {
  it('navigates quarters, years and unknown modes by months', () => {
    expect(iso(navigateDate(d(2026, 0, 15), 1, 'quarter'))).toBe('2026-04-15');
    expect(iso(navigateDate(d(2026, 0, 15), -1, 'year'))).toBe('2025-01-15');
    expect(iso(navigateDate(d(2026, 0, 15), 1, 'other' as never))).toBe('2026-02-15');
  });

  it('checks inclusive range membership', () => {
    expect(isDateInRange(d(2026, 0, 10), d(2026, 0, 10), d(2026, 0, 20))).toBe(true);
    expect(isDateInRange(d(2026, 0, 21), d(2026, 0, 10), d(2026, 0, 20))).toBe(false);
  });

  it('normalises model dates and adds days across month ends', () => {
    expect(toDateOnly('2026-03-01T00:00:00.000Z')).toBe('2026-03-01');
    expect(addDaysToDateString('2026-01-30', 3)).toBe('2026-02-02');
    expect(addDaysToDateString('2026-03-01', -1)).toBe('2026-02-28');
  });
});
