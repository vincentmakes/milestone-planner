import { describe, it, expect } from 'vitest';
import { buildEventDateSet, buildHolidayDateSet } from '../sites';
import type { BankHoliday, CompanyEvent } from '@/types';

const holiday = (date: string, end_date?: string | null) =>
  ({ id: 1, site_id: 1, date, end_date, name: 'H' }) as BankHoliday;
const event = (date: string, end_date?: string | null) =>
  ({ id: 1, site_id: 1, date, end_date, name: 'E' }) as CompanyEvent;

describe('buildHolidayDateSet', () => {
  it('adds single-day holidays, normalising ISO timestamps', () => {
    const set = buildHolidayDateSet([holiday('2026-08-01T00:00:00.000Z'), holiday('2026-12-25', null)]);
    expect([...set].sort()).toEqual(['2026-08-01', '2026-12-25']);
  });

  it('expands multi-day ranges across a month boundary', () => {
    const set = buildHolidayDateSet([holiday('2026-01-30', '2026-02-02')]);
    expect([...set]).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  });

  it('is empty for no holidays and de-duplicates overlaps', () => {
    expect(buildHolidayDateSet([]).size).toBe(0);
    expect(buildHolidayDateSet([holiday('2026-05-01', '2026-05-02'), holiday('2026-05-02')]).size).toBe(2);
  });
});

describe('buildEventDateSet', () => {
  it('expands event ranges the same way', () => {
    const set = buildEventDateSet([event('2026-03-30T00:00:00.000Z', '2026-04-01'), event('2026-06-01')]);
    expect([...set]).toEqual(['2026-03-30', '2026-03-31', '2026-04-01', '2026-06-01']);
  });
});
