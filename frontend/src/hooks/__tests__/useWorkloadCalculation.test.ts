/**
 * Only absences that count as unavailable zero a person's capacity in the
 * Staff heatmap. An available one (Home Office) leaves the workload alone but
 * is still named in the cell tooltip. `workloadRuns` merges adjacent cells
 * that read the same into one block.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateWorkloadCells,
  getWorkloadTooltip,
  getWorkloadBackground,
  workloadLabel,
  workloadRuns,
} from '../useWorkloadCalculation';
import type { WorkloadCell } from '../useWorkloadCalculation';
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

describe('workloadRuns', () => {
  /** Consecutive days from 2026-03-02 (a Monday) */
  const days = (n: number, from = 2) =>
    Array.from({ length: n }, (_, i) => `2026-03-${String(from + i).padStart(2, '0')}`);
  const at = (assignments: typeof assignment[], dates: string[], vacations: Vacation[] = []) =>
    calculateWorkloadCells(assignments, vacations, dates.map(cell), 100, byId);
  const spans = (runs: ReturnType<typeof workloadRuns>) => runs.map((r) => [r.from, r.to, workloadLabel(r.workload)]);

  it('joins adjacent cells with the same allocation into one run with its dates', () => {
    const dates = days(5);
    const runs = workloadRuns(at([{ ...assignment, allocation: 75 }], dates), dates);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      from: 0,
      to: 4,
      tooltip: '75% allocated',
      startDate: '2026-03-02',
      endDate: '2026-03-06',
    });
    expect(runs[0].workload).toMatchObject({ total: 75, state: 'partial' });
  });

  it('splits where the total changes, and keeps a one-day run', () => {
    const dates = days(5);
    const extra = { ...assignment, id: 2, allocation: 50, start_date: '2026-03-04', end_date: '2026-03-04' };
    const runs = workloadRuns(at([assignment, extra], dates), dates);
    expect(spans(runs)).toEqual([
      [0, 1, '50%'],
      [2, 2, '100%'],
      [3, 4, '50%'],
    ]);
    expect(runs[1]).toMatchObject({ startDate: '2026-03-04', endDate: '2026-03-04' });
  });

  it('skips the cells that draw nothing and splits a run around them', () => {
    const dates = days(5);
    const short = { ...assignment, start_date: '2026-03-02', end_date: '2026-03-03' };
    const late = { ...assignment, id: 2, start_date: '2026-03-05', end_date: '2026-03-06' };
    expect(spans(workloadRuns(at([short, late], dates), dates))).toEqual([
      [0, 1, '50%'],
      [3, 4, '50%'],
    ]);
    expect(workloadRuns(at([], dates), dates)).toEqual([]);
  });

  it('joins Friday and the next Monday when the weekend cells are hidden (adjacent by index)', () => {
    const dates = ['2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10'];
    const runs = workloadRuns(at([assignment], dates), dates);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ from: 0, to: 3, startDate: '2026-03-05', endDate: '2026-03-10' });
  });

  it('keeps two different absences apart even though both read "OFF"', () => {
    const dates = days(2);
    const sick: Vacation = { ...vacation(1), id: 2, start_date: '2026-03-02', end_date: '2026-03-02', description: 'Sick' };
    const leave: Vacation = { ...vacation(1), id: 3, start_date: '2026-03-03', end_date: '2026-03-03', description: 'Leave' };
    const runs = workloadRuns(at([], dates, [sick, leave]), dates);
    expect(spans(runs)).toEqual([
      [0, 0, 'OFF'],
      [1, 1, 'OFF'],
    ]);
  });

  it('keeps an available absence (no badge) apart from the plain days around it', () => {
    const dates = days(3);
    const runs = workloadRuns(at([assignment], dates, [vacation(2)]), dates);
    expect(runs.map((r) => [r.from, r.to, !!r.workload.hasAvailableAbsence])).toEqual([
      [0, 0, false],
      [1, 1, true],
      [2, 2, false],
    ]);
  });

  it('skips non-working cells: a run stops before one', () => {
    const dates = days(4);
    const cells: WorkloadCell[] = at([assignment], dates);
    cells[2] = { ...cells[2], state: 'nonworking' };
    expect(spans(workloadRuns(cells, dates))).toEqual([
      [0, 1, '50%'],
      [3, 3, '50%'],
    ]);
  });
});

describe('workloadLabel', () => {
  const base = calculateWorkloadCells([assignment], [], [cell('2026-03-10')], 100, byId)[0];

  it('reads the allocation, OFF, 0 % on a conflict, and nothing on an empty or non-working day', () => {
    expect(workloadLabel(base)).toBe('50%');
    expect(workloadLabel({ ...base, state: 'vacation' })).toBe('OFF');
    expect(workloadLabel({ ...base, state: 'conflict' })).toBe('0%');
    expect(workloadLabel({ ...base, state: 'empty' })).toBeNull();
    expect(workloadLabel({ ...base, state: 'nonworking' })).toBeNull();
  });
});

describe('calculateWorkloadCells on non-working days', () => {
  // Fri 6, Sat 7, Sun 8, Mon 9 March 2026; the booking runs all month.
  const days = ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09'].map(cell);
  const weekendClosure: CompanyEvent = {
    id: 2,
    site_id: 1,
    site_ids: [1],
    date: '2026-03-07',
    end_date: '2026-03-08',
    name: 'Weekend shutdown',
    color: '#f97316',
    counts_as_unavailable: true,
  };
  const closures = (dateStr: string) => getClosureOn(new Set([1]), dateStr, buildClosureIndex([weekendClosure]));
  const weekendAbsence: Vacation = { ...vacation(1), start_date: '2026-03-07', end_date: '2026-03-08' };

  it('makes a weekend nonworking by default: no allocation, no badge, no "Available"', () => {
    const cells = calculateWorkloadCells([assignment], [], days, 100, byId);
    expect(cells.map((w) => w.state)).toEqual(['partial', 'nonworking', 'nonworking', 'partial']);
    expect(cells[1]).toEqual({ total: 0, assignments: [], isOnVacation: false, available: 0, state: 'nonworking' });
    expect(workloadLabel(cells[1])).toBeNull();
    // Friday and Monday are separate blocks: the weekend between them draws nothing.
    expect(workloadRuns(cells, days.map((c) => c.dateStr)).map((r) => [r.from, r.to])).toEqual([
      [0, 0],
      [3, 3],
    ]);
  });

  it('puts nonworking before an absence or a closure on the weekend', () => {
    const withAbsence = calculateWorkloadCells([assignment], [weekendAbsence], days, 100, byId);
    expect(withAbsence.map((w) => w.state)).toEqual(['partial', 'nonworking', 'nonworking', 'partial']);
    const withClosure = calculateWorkloadCells([assignment], [], days, 100, byId, closures);
    expect(withClosure.map((w) => w.state)).toEqual(['partial', 'nonworking', 'nonworking', 'partial']);
  });

  it('counts the weekend like any day when weekends are working days', () => {
    const cells = calculateWorkloadCells([assignment], [], days, 100, byId, undefined, true);
    expect(cells.map((w) => [w.state, w.total])).toEqual([
      ['partial', 50],
      ['partial', 50],
      ['partial', 50],
      ['partial', 50],
    ]);
    expect(workloadRuns(cells, days.map((c) => c.dateStr))).toHaveLength(1);
    // ... and an absence or a closure then takes the weekend day off.
    const absent = calculateWorkloadCells([assignment], [weekendAbsence], days, 100, byId, undefined, true);
    expect(absent.map((w) => w.state)).toEqual(['partial', 'conflict', 'conflict', 'partial']);
    const closed = calculateWorkloadCells([], [], days, 100, byId, closures, true);
    expect(closed.map((w) => w.state)).toEqual(['empty', 'vacation', 'vacation', 'empty']);
  });

  it('decides on the cell date, not on the cell flags', () => {
    const flagged = { dateStr: '2026-03-09', isWeekend: true } as TimelineCell;
    expect(calculateWorkloadCells([assignment], [], [flagged], 100, byId)[0].state).toBe('partial');
  });
});
