/**
 * Calendar-date parsing must be timezone-proof.
 *
 * `new Date('YYYY-MM-DD')` is UTC midnight, which every zone west of UTC reads
 * back as the previous day. This file pins the process to America/New_York
 * (negative offset) so the regression shows up regardless of the machine or
 * CI timezone. Node re-reads process.env.TZ on assignment; each vitest test
 * file runs in its own isolated worker.
 */
// No @types/node in the app tsconfig; vitest runs on Node, where this exists.
declare const process: { env: Record<string, string | undefined> };
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { describe, it, expect, afterAll } from 'vitest';
import {
  parseLocalDate,
  formatLocalDate,
  toDateOnly,
  addDaysToDateString,
  daysBetweenDateStrings,
  formatShortDateRange,
  formatSingleDate,
  parseDate,
} from '../date';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('date utils in a negative-offset timezone (America/New_York)', () => {
  it('is really running west of UTC', () => {
    expect(new Date(2026, 2, 2).getTimezoneOffset()).toBeGreaterThan(0);
    // The bug this file guards against:
    expect(new Date('2026-03-02').getDate()).toBe(1);
  });

  it('parseLocalDate reads YYYY-MM-DD as local midnight of that day', () => {
    const d = parseLocalDate('2026-03-02');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 2, 2]);
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
  });

  it('parseLocalDate reads the backend midnight-UTC form as the same calendar day', () => {
    for (const s of ['2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00Z', '2026-03-02T00:00:00', '2026-03-02T00:00']) {
      const d = parseLocalDate(s);
      expect(formatLocalDate(d)).toBe('2026-03-02');
    }
  });

  it('parseLocalDate keeps real instants as instants', () => {
    const d = parseLocalDate('2026-03-02T15:30:00.000Z');
    expect(d.getTime()).toBe(Date.UTC(2026, 2, 2, 15, 30));
  });

  it('formatLocalDate / toDateOnly round-trip', () => {
    expect(formatLocalDate(new Date(2026, 0, 9))).toBe('2026-01-09');
    expect(toDateOnly('2026-12-31T00:00:00.000Z')).toBe('2026-12-31');
    expect(toDateOnly('2026-12-31')).toBe('2026-12-31');
  });

  it('addDaysToDateString works across month ends and the DST switch', () => {
    expect(addDaysToDateString('2026-03-01', 1)).toBe('2026-03-02');
    expect(addDaysToDateString('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysToDateString('2026-03-07', 2)).toBe('2026-03-09'); // DST starts 2026-03-08
    expect(addDaysToDateString('2026-03-02T00:00:00.000Z', -2)).toBe('2026-02-28');
  });

  it('daysBetweenDateStrings counts whole calendar days, DST included', () => {
    expect(daysBetweenDateStrings('2026-03-01', '2026-03-05')).toBe(4);
    expect(daysBetweenDateStrings('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetweenDateStrings('2026-03-05', '2026-03-01')).toBe(-4);
  });

  it('formatShortDateRange / formatSingleDate show the stored calendar days', () => {
    // A phase stored as 2026-03-02..2026-03-06 used to display "Mar 1 - Mar 5".
    const range = formatShortDateRange('2026-03-02T00:00:00.000Z', '2026-03-06T00:00:00.000Z');
    expect(range).toMatch(/\b2\b/);
    expect(range).toMatch(/\b6\b/);
    expect(range).not.toMatch(/\b1\b/);
    expect(formatSingleDate('2026-03-02')).toMatch(/\b2\b/);
  });

  it('parseDate (legacy helper) no longer shifts midnight-UTC dates', () => {
    expect(formatLocalDate(parseDate('2026-03-02T00:00:00.000Z'))).toBe('2026-03-02');
  });
});
