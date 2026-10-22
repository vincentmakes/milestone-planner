/**
 * Auto-calculation (cascades after a drag/resize/link) and savePendingUpdates.
 *
 * The date tests run pinned to America/New_York: `new Date('YYYY-MM-DD')` is
 * UTC midnight there = the previous local day, which used to shift every
 * cascaded child, parent and project date one day early west of UTC.
 */
// No @types/node in the app tsconfig; vitest runs on Node, where this exists.
declare const process: { env: Record<string, string | undefined> };
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Phase, Project, Subphase } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  updatePhase: vi.fn(),
  updateSubphase: vi.fn(),
  updateProject: vi.fn(),
  updateStaffAssignment: vi.fn(),
  updateEquipmentAssignment: vi.fn(),
}));

import {
  moveChildrenByOffset,
  movePhasesWithProject,
  cascadeParentDatesUp,
  autoAdjustProjectDates,
  processSubphaseMove,
  savePendingUpdates,
  PendingUpdatesError,
} from '../autoCalculation';
import type { PendingUpdate } from '../autoCalculation';
import * as projectsApi from '@/api/endpoints/projects';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function sub(id: number, start: string, end: string, children: Subphase[] = []): Subphase {
  return {
    id,
    project_id: 1,
    parent_phase_id: 10,
    parent_subphase_id: null,
    name: `S${id}`,
    start_date: start,
    end_date: end,
    color: '#000',
    order_index: 0,
    status: 'todo',
    dependencies: [],
    children,
    staffAssignments: [],
    equipmentAssignments: [],
  } as Subphase;
}

function phase(id: number, start: string, end: string, children: Subphase[] = []): Phase {
  return {
    id,
    project_id: 1,
    name: `P${id}`,
    start_date: start,
    end_date: end,
    color: '#000',
    order_index: 0,
    status: 'todo',
    dependencies: [],
    children,
    staffAssignments: [],
    equipmentAssignments: [],
  };
}

function project(phases: Phase[], start = '2026-03-01', end = '2026-03-31'): Project {
  return {
    id: 1,
    name: 'Proj',
    site_id: 1,
    confirmed: true,
    archived: false,
    start_date: start,
    end_date: end,
    phases,
    staffAssignments: [],
    equipmentAssignments: [],
  };
}

describe('autoCalculation dates in America/New_York', () => {
  it('runs west of UTC', () => {
    expect(new Date(2026, 2, 1).getTimezoneOffset()).toBeGreaterThan(0);
  });

  it('moveChildrenByOffset moves children (and grandchildren) by exactly the offset', () => {
    const grandchild = sub(3, '2026-03-02', '2026-03-03');
    const child = sub(2, '2026-03-01', '2026-03-05', [grandchild]);
    const updates: PendingUpdate[] = [];

    moveChildrenByOffset([child], 1, updates);

    expect(child.start_date).toBe('2026-03-02');
    expect(child.end_date).toBe('2026-03-06');
    expect(grandchild.start_date).toBe('2026-03-03');
    expect(grandchild.end_date).toBe('2026-03-04');
    expect(updates.map((u) => [u.id, u.start_date, u.end_date])).toEqual([
      [2, '2026-03-02', '2026-03-06'],
      [3, '2026-03-03', '2026-03-04'],
    ]);
  });

  it('accepts the backend midnight-UTC date form', () => {
    const child = sub(2, '2026-03-01T00:00:00.000Z', '2026-03-05T00:00:00.000Z');
    moveChildrenByOffset([child], 2, []);
    expect([child.start_date, child.end_date]).toEqual(['2026-03-03', '2026-03-07']);
  });

  it('moves across the DST switch without losing a day', () => {
    const child = sub(2, '2026-03-06', '2026-03-07');
    moveChildrenByOffset([child], 3, []);
    expect([child.start_date, child.end_date]).toEqual(['2026-03-09', '2026-03-10']);
  });

  it('movePhasesWithProject moves phases, subphases and assignments', () => {
    const p = project([phase(10, '2026-03-02', '2026-03-06', [sub(2, '2026-03-02', '2026-03-04')])]);
    p.staffAssignments = [
      { id: 7, staff_id: 1, allocation: 50, start_date: '2026-03-02', end_date: '2026-03-06' },
    ];
    const updates: PendingUpdate[] = [];

    movePhasesWithProject(p, 7, updates);

    expect([p.phases[0].start_date, p.phases[0].end_date]).toEqual(['2026-03-09', '2026-03-13']);
    expect([p.phases[0].children[0].start_date, p.phases[0].children[0].end_date]).toEqual(['2026-03-09', '2026-03-11']);
    expect([p.staffAssignments[0].start_date, p.staffAssignments[0].end_date]).toEqual(['2026-03-09', '2026-03-13']);
    expect(updates.find((u) => u.type === 'staffAssignment')).toMatchObject({ id: 7, allocation: 50 });
  });

  it('tags cascaded project-level staff updates with their route level', () => {
    const p = project([]);
    p.staffAssignments = [
      { id: 7, staff_id: 1, allocation: 50, start_date: '2026-03-02', end_date: '2026-03-06' },
    ];
    const updates: PendingUpdate[] = [];

    movePhasesWithProject(p, 1, updates);

    expect(updates).toEqual([expect.objectContaining({ type: 'staffAssignment', id: 7, level: 'project' })]);
  });

  // Regression (RBAC): linked phase/subphase staff rows have no dates of
  // their own (they follow their item) and their ids are only unique per
  // level, so a cascaded update for one used to PUT /api/assignments/{id} --
  // the project-level row that happens to share the id. A pending row is a
  // request awaiting approval: an editor's PUT on it is a 409. (Unlinked
  // segments are fitted with their card: autoCalculation.cascades.test.ts.)
  it('never writes linked phase/subphase staff rows or pending rows', () => {
    const dated = { staff_id: 2, allocation: 40, start_date: '2026-03-02', end_date: '2026-03-04' };
    const child = sub(2, '2026-03-02', '2026-03-04');
    child.staffAssignments = [{ id: 7, ...dated }];
    const ph = phase(10, '2026-03-02', '2026-03-06', [child]);
    ph.staffAssignments = [{ id: 7, ...dated }];
    const p = project([ph]);
    p.staffAssignments = [
      { id: 8, staff_id: 3, allocation: 50, start_date: '2026-03-02', end_date: '2026-03-06', approval_status: 'pending' },
    ];
    const updates: PendingUpdate[] = [];

    movePhasesWithProject(p, 7, updates);

    expect(updates.filter((u) => u.type === 'staffAssignment')).toEqual([]);
    // Linked rows show their item's new dates locally; the pending row awaits a decision.
    expect(ph.staffAssignments[0].start_date).toBe('2026-03-09');
    expect(child.staffAssignments[0].start_date).toBe('2026-03-09');
    expect(p.staffAssignments[0].start_date).toBe('2026-03-02');
  });

  it('moveChildrenByOffset leaves subphase staff rows to their subphase', () => {
    const child = sub(2, '2026-03-02', '2026-03-04');
    child.staffAssignments = [{ id: 7, staff_id: 2, allocation: 40, start_date: '2026-03-02', end_date: '2026-03-04' }];
    const updates: PendingUpdate[] = [];

    moveChildrenByOffset([child], 2, updates);

    expect(updates.map((u) => u.type)).toEqual(['subphase']);
  });

  it('cascadeParentDatesUp sets parent and project to the union of the children', () => {
    // One child Mar 1–5: the phase AND the project used to become Feb 28 – Mar 4.
    const p = project([phase(10, '2026-02-20', '2026-03-20', [sub(2, '2026-03-01', '2026-03-05')])], '2026-02-20', '2026-03-20');
    const updates: PendingUpdate[] = [];

    cascadeParentDatesUp(p, 2, updates);

    expect([p.phases[0].start_date, p.phases[0].end_date]).toEqual(['2026-03-01', '2026-03-05']);
    expect([p.start_date, p.end_date]).toEqual(['2026-03-01', '2026-03-05']);
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'phase', id: 10, start_date: '2026-03-01', end_date: '2026-03-05' }),
        expect.objectContaining({ type: 'project', id: 1, start_date: '2026-03-01', end_date: '2026-03-05' }),
      ])
    );
  });

  it('cascadeParentDatesUp walks nested subphases up to the phase', () => {
    const inner = sub(3, '2026-03-10', '2026-03-12');
    const outer = sub(2, '2026-03-11', '2026-03-11', [inner]);
    const p = project([phase(10, '2026-03-11', '2026-03-11', [outer])], '2026-03-11', '2026-03-11');

    cascadeParentDatesUp(p, 3, []);

    expect([outer.start_date, outer.end_date]).toEqual(['2026-03-10', '2026-03-12']);
    expect([p.phases[0].start_date, p.phases[0].end_date]).toEqual(['2026-03-10', '2026-03-12']);
    expect([p.start_date, p.end_date]).toEqual(['2026-03-10', '2026-03-12']);
  });

  it('cascadeParentDatesUp is a no-op when the parent already matches (mixed date forms)', () => {
    const p = project(
      [phase(10, '2026-03-01T00:00:00.000Z', '2026-03-05T00:00:00.000Z', [sub(2, '2026-03-01', '2026-03-05')])],
      '2026-03-01T00:00:00.000Z',
      '2026-03-05T00:00:00.000Z'
    );
    expect(processSubphaseMove(p, 2, '2026-03-05', '2026-03-05')).toEqual([]);
  });

  it('autoAdjustProjectDates spans earliest phase start to latest phase end', () => {
    const p = project([phase(10, '2026-03-03', '2026-03-09'), phase(11, '2026-03-01', '2026-03-04')]);
    const updates: PendingUpdate[] = [];

    autoAdjustProjectDates(p, updates);

    expect([p.start_date, p.end_date]).toEqual(['2026-03-01', '2026-03-09']);
    expect(updates).toEqual([
      expect.objectContaining({ type: 'project', id: 1, start_date: '2026-03-01', end_date: '2026-03-09', name: 'Proj' }),
    ]);
  });
});

describe('savePendingUpdates', () => {
  beforeEach(() => {
    vi.mocked(projectsApi.updatePhase).mockReset().mockResolvedValue({} as never);
    vi.mocked(projectsApi.updateSubphase).mockReset().mockResolvedValue({} as never);
    vi.mocked(projectsApi.updateStaffAssignment).mockReset().mockResolvedValue({} as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const updates: PendingUpdate[] = [
    { type: 'phase', id: 1, start_date: '2026-03-01', end_date: '2026-03-02' },
    { type: 'subphase', id: 2, start_date: '2026-03-01', end_date: '2026-03-02' },
    { type: 'staffAssignment', id: 3, start_date: '2026-03-01', end_date: '2026-03-02' },
  ];

  it('resolves when every update succeeds (allocation defaults to 100)', async () => {
    await expect(savePendingUpdates(updates)).resolves.toBeUndefined();
    expect(projectsApi.updateStaffAssignment).toHaveBeenCalledWith(
      3,
      { start_date: '2026-03-01', end_date: '2026-03-02', allocation: 100 },
      'project'
    );
  });

  it('routes a staff-assignment update by its level', async () => {
    await savePendingUpdates([
      { type: 'staffAssignment', id: 4, level: 'subphase', start_date: '2026-03-01', end_date: '2026-03-02', allocation: 30 },
    ]);
    expect(projectsApi.updateStaffAssignment).toHaveBeenCalledWith(
      4,
      { start_date: '2026-03-01', end_date: '2026-03-02', allocation: 30 },
      'subphase'
    );
  });

  it('attempts every update and rejects with the failures when any fails', async () => {
    vi.mocked(projectsApi.updateSubphase).mockRejectedValue(new Error('409 conflict'));

    const err = await savePendingUpdates(updates).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PendingUpdatesError);
    const failure = err as PendingUpdatesError;
    expect(failure.total).toBe(3);
    expect(failure.failures.map((f) => f.update.id)).toEqual([2]);
    expect(failure.message).toContain('subphase 2');
    // The independent writes were still sent.
    expect(projectsApi.updatePhase).toHaveBeenCalledTimes(1);
    expect(projectsApi.updateStaffAssignment).toHaveBeenCalledTimes(1);
  });
});
