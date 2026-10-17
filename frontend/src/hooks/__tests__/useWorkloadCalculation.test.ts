/**
 * Only absences that count as unavailable zero a person's capacity in the
 * Staff heatmap. An available one (Home Office) leaves the workload alone but
 * is still named in the cell tooltip.
 */

import { describe, it, expect } from 'vitest';
import { calculateWorkloadCells, getWorkloadTooltip, getWorkloadBackground } from '../useWorkloadCalculation';
import { indexAbsenceTypes } from '@/utils/recurringVacation';
import { buildClosureIndex, getClosureOn } from '@/utils/siteClosure';
import type { TimelineCell } from '@/components/gantt/utils';
import type { AbsenceType, CompanyEvent, Vacation } from '@/types';

const TYPES: AbsenceType[] = [
  { id: 1, name: 'Holidays', color: '#8b5cf6', counts_as_unavailable: true, sort_order: 0, is_active: true },
  { id: 2, name: 'Home Office', color: '#0ea5e9', counts_as_unavailable: false, sort_order: 1, is_active: true },
];
const byId = indexAbsenceTypes(TYPES);

const cell = (dateStr: string) => ({ dateStr }) as TimelineCell;
const assignment = { id: 1, allocation: 50, start_date: '2026-03-01', end_date: '2026-03-31', projectName: 'P' };
const vacation = (absence_type_id: number | null): Vacation => ({
  id: 1,
  staff_id: 7,
  start_date: '2026-03-03',
  end_date: '2026-03-03',
  description: 'Remote day',
  absence_type_id,
});

describe('calculateWorkloadCells', () => {
  it('keeps the workload of a Home Office day and reports the absence', () => {
    const [w] = calculateWorkloadCells([assignment], [vacation(2)], [cell('2026-03-03')], 100, byId);
    expect(w).toMatchObject({
      isOnVacation: false,
      state: 'partial',
      total: 50,
      available: 50,
      hasAvailableAbsence: true,
      absenceName: 'Home Office',
      absenceColor: '#0ea5e9',
    });
    expect(getWorkloadTooltip(w)).toBe('Home Office: Remote day\n50% allocated');
  });

  it('zeroes capacity for an unavailable type and flags the conflict', () => {
    const [w] = calculateWorkloadCells([assignment], [vacation(1)], [cell('2026-03-03')], 100, byId);
    expect(w).toMatchObject({ isOnVacation: true, state: 'conflict', available: 0, absenceName: 'Holidays' });
    expect(getWorkloadTooltip(w)).toContain('Conflict: 50% assigned');
  });

  it('treats an untyped absence as unavailable', () => {
    const [w] = calculateWorkloadCells([], [vacation(null)], [cell('2026-03-03')], 100, byId);
    expect(w).toMatchObject({ isOnVacation: true, state: 'vacation', absenceName: 'Vacation' });
    expect(w.absenceColor).toBeUndefined();
  });

  it('leaves days without an absence untouched', () => {
    const [w] = calculateWorkloadCells([assignment], [vacation(1)], [cell('2026-03-04')], 100, byId);
    expect(w).toMatchObject({ isOnVacation: false, hasAvailableAbsence: false, state: 'partial' });
    expect(getWorkloadTooltip(w)).toBe('50% allocated');
  });
});

/**
 * A company event flagged as a site closure takes the staff of its sites off
 * like an unavailable absence, under the event's name and colour.
 */
describe('calculateWorkloadCells with site closures', () => {
  const shutdown: CompanyEvent = {
    id: 1,
    site_id: 1,
    site_ids: [1],
    date: '2026-03-10',
    end_date: '2026-03-11',
    name: 'Site shutdown',
    color: '#f97316',
    counts_as_unavailable: true,
  };
  const index = buildClosureIndex([shutdown]);
  const closuresFor = (siteIds: number[]) => (dateStr: string) =>
    getClosureOn(new Set(siteIds), dateStr, index);

  it('zeroes the capacity and shows OFF (state vacation) with the event colour', () => {
    const [w] = calculateWorkloadCells([], [], [cell('2026-03-10')], 100, byId, closuresFor([1]));
    expect(w).toMatchObject({
      isOnVacation: true,
      state: 'vacation',
      available: 0,
      closureName: 'Site shutdown',
      closureColor: '#f97316',
      absenceName: undefined,
    });
    expect(getWorkloadTooltip(w)).toBe('Site closed: Site shutdown');
    expect(getWorkloadBackground(w).background).toContain('#f97316');
  });

  it('flags assigned work during the closure as a conflict', () => {
    const [w] = calculateWorkloadCells([assignment], [], [cell('2026-03-11')], 100, byId, closuresFor([1]));
    expect(w).toMatchObject({ state: 'conflict', available: 0, total: 50 });
    expect(getWorkloadTooltip(w)).toBe(
      'Site closed: Site shutdown\n⚠️ Conflict: 50% assigned during site closure'
    );
  });

  it('leaves staff of other sites and other days untouched', () => {
    const [other] = calculateWorkloadCells([assignment], [], [cell('2026-03-10')], 100, byId, closuresFor([2]));
    expect(other).toMatchObject({ isOnVacation: false, state: 'partial', closureName: undefined });

    const [after] = calculateWorkloadCells([assignment], [], [cell('2026-03-12')], 100, byId, closuresFor([1]));
    expect(after).toMatchObject({ isOnVacation: false, state: 'partial' });
  });

  it('also accepts a day → event map and names an absence on the same day', () => {
    const map = new Map([['2026-03-10', shutdown]]);
    const remoteDay: Vacation = { ...vacation(2), start_date: '2026-03-10', end_date: '2026-03-10' };
    const [w] = calculateWorkloadCells([], [remoteDay], [cell('2026-03-10')], 100, byId, map);
    expect(w).toMatchObject({ isOnVacation: true, state: 'vacation', closureName: 'Site shutdown' });
    expect(getWorkloadTooltip(w)).toBe('Site closed: Site shutdown\nHome Office: Remote day');
  });

  it('falls back to the default event colour', () => {
    const [w] = calculateWorkloadCells(
      [], [], [cell('2026-03-10')], 100, byId,
      new Map([['2026-03-10', { ...shutdown, color: null }]])
    );
    expect(w.closureColor).toBe('#ef4444');
  });
});
