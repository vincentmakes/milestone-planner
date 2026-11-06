/**
 * Mirror of tests/test_working_days.py.
 *
 * The dashboards count working days on the server
 * (app/services/working_days.py), the Staff heatmap, the availability badges
 * and the Gantt tooltip with utils/workingDays.ts. That is only consistent
 * while both answer exactly the same -- so WORKING_DAY_CASES and COUNT_CASES
 * below are copied verbatim, in the same order, from the backend test. If you
 * change one, change both.
 *
 * - WORKING_DAY_CASES: [date, weekendsWorking, holiday, expected] -- whether
 *   the day counts as a working day when it is (holiday) or is not one of the
 *   caller's off days.
 * - COUNT_CASES: [start, end, weekendsWorking, offDays, expected] -- the
 *   working days of [start, end] minus the off days in it.
 *
 * 2 March 2026 is a Monday.
 */

import { describe, it, expect } from 'vitest';
import { formatLocalDate } from '../date';
import { countWorkingDays, isWorkingDay, workingDaysPerWeek } from '../workingDays';

const WORKING_DAY_CASES: [string, boolean, boolean, boolean][] = [
  // Weekends off (the default): Monday to Friday.
  ['2026-03-02', false, false, true], // Monday
  ['2026-03-04', false, false, true], // Wednesday
  ['2026-03-06', false, false, true], // Friday
  ['2026-03-07', false, false, false], // Saturday
  ['2026-03-08', false, false, false], // Sunday
  ['2026-03-04', false, true, false], // a weekday holiday
  ['2026-03-07', false, true, false], // a Saturday holiday: no working day anyway
  // Weekends on: every day.
  ['2026-03-02', true, false, true],
  ['2026-03-06', true, false, true],
  ['2026-03-07', true, false, true],
  ['2026-03-08', true, false, true],
  ['2026-03-04', true, true, false],
  ['2026-03-07', true, true, false], // a Saturday holiday now takes a day
  ['2026-03-08', true, true, false],
  // Month and year ends.
  ['2026-02-28', false, false, false], // Saturday
  ['2026-02-28', true, false, true],
  ['2026-12-31', false, false, true], // Thursday
  ['2027-01-03', false, false, false], // Sunday
  ['2027-01-03', true, false, true],
];

const COUNT_CASES: [string, string, boolean, string[], number][] = [
  // One week, Monday to Sunday.
  ['2026-03-02', '2026-03-08', false, [], 5],
  ['2026-03-02', '2026-03-08', true, [], 7],
  // Friday to Monday: the weekend counts only when on.
  ['2026-03-06', '2026-03-09', false, [], 2],
  ['2026-03-06', '2026-03-09', true, [], 4],
  // Saturday to Sunday alone.
  ['2026-03-07', '2026-03-08', false, [], 0],
  ['2026-03-07', '2026-03-08', true, [], 2],
  // A single day.
  ['2026-03-04', '2026-03-04', false, [], 1],
  ['2026-03-07', '2026-03-07', false, [], 0],
  ['2026-03-07', '2026-03-07', true, [], 1],
  // An empty range.
  ['2026-03-08', '2026-03-02', false, [], 0],
  ['2026-03-08', '2026-03-02', true, [], 0],
  // Off days: a weekday holiday, a Saturday one, one outside the range.
  ['2026-03-02', '2026-03-08', false, ['2026-03-04'], 4],
  ['2026-03-02', '2026-03-08', false, ['2026-03-07'], 5],
  ['2026-03-02', '2026-03-08', true, ['2026-03-07'], 6],
  ['2026-03-02', '2026-03-08', true, ['2026-03-04', '2026-03-07', '2026-03-08'], 4],
  ['2026-03-02', '2026-03-06', false, ['2026-03-01', '2026-03-09'], 5],
  // All of March 2026: 22 weekdays, 31 days.
  ['2026-03-01', '2026-03-31', false, [], 22],
  ['2026-03-01', '2026-03-31', true, [], 31],
  ['2026-03-01', '2026-03-31', false, ['2026-03-04', '2026-03-11', '2026-03-14'], 20],
  ['2026-03-01', '2026-03-31', true, ['2026-03-04', '2026-03-11', '2026-03-14'], 28],
  // Across a year end.
  ['2026-12-28', '2027-01-03', false, ['2027-01-01'], 4],
  ['2026-12-28', '2027-01-03', true, ['2027-01-01'], 6],
];

describe('mirror of app/services/working_days.py', () => {
  it.each(WORKING_DAY_CASES)('%s (weekends %s, holiday %s) is a working day: %s', (day, weekendsWorking, holiday, expected) => {
    const offDays = holiday ? [day] : [];
    expect(countWorkingDays(day, day, { weekendsWorking, offDays })).toBe(Number(expected));
    if (!holiday) expect(isWorkingDay(day, weekendsWorking)).toBe(expected);
  });

  it.each(COUNT_CASES)('%s .. %s (weekends %s, off %j) has %i working days', (start, end, weekendsWorking, offDays, expected) => {
    expect(countWorkingDays(start, end, { weekendsWorking, offDays })).toBe(expected);
  });

  it('holds the whole shared tables', () => {
    expect(WORKING_DAY_CASES).toHaveLength(19);
    expect(COUNT_CASES).toHaveLength(22);
  });
});

describe('workingDays', () => {
  it('reads the midnight ISO form as its calendar day', () => {
    expect(isWorkingDay('2026-03-07T00:00:00.000Z', false)).toBe(false);
    expect(countWorkingDays('2026-03-02T00:00:00.000Z', '2026-03-08T00:00:00.000Z')).toBe(5);
  });

  it('defaults to weekends off and no off days, and counts an off day once', () => {
    expect(countWorkingDays('2026-03-02', '2026-03-08')).toBe(5);
    expect(countWorkingDays('2026-03-02', '2026-03-08', { offDays: new Set(['2026-03-04']) })).toBe(4);
    expect(countWorkingDays('2026-03-02', '2026-03-08', { offDays: ['2026-03-04', '2026-03-04'] })).toBe(4);
  });

  it('counts nothing for an unreadable range', () => {
    expect(countWorkingDays('', '2026-03-08')).toBe(0);
  });

  it('matches walking the days for every start weekday and length', () => {
    const holidays = ['2026-03-04', '2026-03-07', '2026-03-16', '2026-03-22'];
    for (const weekendsWorking of [false, true]) {
      for (let first = 1; first <= 7; first++) {
        const start = formatLocalDate(new Date(2026, 2, first));
        let walked = 0;
        for (let length = 1; length < 30; length++) {
          const end = formatLocalDate(new Date(2026, 2, first + length - 1));
          if (isWorkingDay(end, weekendsWorking) && !holidays.includes(end)) walked++;
          expect(countWorkingDays(start, end, { weekendsWorking, offDays: holidays })).toBe(walked);
        }
      }
    }
  });

  it('has 5 or 7 working days per week', () => {
    expect(workingDaysPerWeek(false)).toBe(5);
    expect(workingDaysPerWeek(true)).toBe(7);
  });
});
