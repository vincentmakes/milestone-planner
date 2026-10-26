/**
 * Auto-calculation branches not covered by autoCalculation.test.ts:
 * dependency cascades for every link type (phases and subphases, with lag
 * and chains), phase dates from children, project date updates merged into a
 * queued project write, assignment moves (incl. undated bookings), and the
 * per-type persistence of pending updates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fitCardBookings,
  autoAdjustProjectDates,
  cascadeDependentPhases,
  cascadeDependentSubphases,
  cascadeParentDatesUp,
  cascadePhaseDatesFromChildren,
  cloneProject,
  moveChildrenByOffset,
  movePhasesWithProject,
  processPhaseMove,
  processSubphaseMove,
  savePendingUpdates,
} from '../autoCalculation';
import type { PendingUpdate } from '../autoCalculation';
import {
  updatePhase,
  updateProject,
  updateSubphase,
  updateStaffAssignment,
  updateEquipmentAssignment,
} from '@/api/endpoints/projects';
import { makePhase, makeProject, makeSubphase } from '@/test/factories';
import type { DependencyType, Project, StaffAssignment } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  updatePhase: vi.fn(),
  updateSubphase: vi.fn(),
  updateProject: vi.fn(),
  updateStaffAssignment: vi.fn(),
  updateEquipmentAssignment: vi.fn(),
}));

/** Design (Mar 2-6) -> Build (Mar 9-13, 4-day span) -> Test (Mar 16-18) */
function chain(type: DependencyType = 'FS', lag = 0): Project {
  return makeProject({
    id: 1,
    name: 'Bioprocess Scale-Up',
    start_date: '2026-03-02',
    end_date: '2026-03-18',
    phases: [
      makePhase({ id: 1, start_date: '2026-03-02', end_date: '2026-03-06' }),
      makePhase({ id: 2, start_date: '2026-03-09', end_date: '2026-03-13', dependencies: [{ id: 1, type, lag }] }),
      makePhase({ id: 3, start_date: '2026-03-16', end_date: '2026-03-18', dependencies: [{ id: 2, type: 'FS', lag: 2 }] }),
      // depends on a SUBPHASE with id 1, not on phase 1
      makePhase({ id: 4, start_date: '2026-04-01', end_date: '2026-04-02', dependencies: [{ id: 1, type: 'FS', lag: 0, entity: 'subphase' }] }),
    ],
  });
}

const dates = (p: Project, id: number) => {
  const phase = p.phases.find((ph) => ph.id === id)!;
  return [phase.start_date, phase.end_date];
};

describe('cascadeDependentPhases', () => {
  it.each([
    ['FS', 0, ['2026-03-07', '2026-03-11']],
    ['FS', 2, ['2026-03-09', '2026-03-13']],
    ['SS', 1, ['2026-03-03', '2026-03-07']],
    ['FF', 0, ['2026-03-02', '2026-03-06']],
    ['SF', 3, ['2026-03-01', '2026-03-05']],
    ['XX' as DependencyType, 0, ['2026-03-07', '2026-03-11']],
  ] as const)('%s with lag %d places the successor at %j', (type, lag, expected) => {
    const project = chain(type, lag);
    const updates: PendingUpdate[] = [];
    cascadeDependentPhases(project, 1, updates);
    expect(dates(project, 2)).toEqual(expected);
    // phase 4 names a subphase predecessor and is left alone
    expect(dates(project, 4)).toEqual(['2026-04-01', '2026-04-02']);
    if (expected[0] !== '2026-03-09') {
      expect(updates[0]).toEqual({ type: 'phase', id: 2, start_date: expected[0], end_date: expected[1] });
    }
  });

  it('follows the chain to the successors of the successor', () => {
    const project = chain('FS', 0);
    const updates: PendingUpdate[] = [];
    cascadeDependentPhases(project, 1, updates);
    // Build now ends Mar 11 -> Test starts Mar 12 + 2 lag
    expect(dates(project, 3)).toEqual(['2026-03-14', '2026-03-16']);
    expect(updates.map((u) => u.id)).toEqual([2, 3]);
  });

  it('writes nothing when the successor is already in place, or the phase is unknown', () => {
    const project = chain('FS', 2);
    const updates: PendingUpdate[] = [];
    cascadeDependentPhases(project, 1, updates);
    cascadeDependentPhases(project, 99, updates);
    expect(updates).toEqual([]);
  });
});

describe('cascadeDependentSubphases', () => {
  function subProject(type: DependencyType) {
    return makeProject({
      id: 1,
      phases: [
        makePhase({
          id: 10,
          children: [
            makeSubphase({ id: 1, start_date: '2026-03-02', end_date: '2026-03-04' }),
            makeSubphase({
              id: 2,
              start_date: '2026-03-10',
              end_date: '2026-03-11',
              children: [
                makeSubphase({ id: 3, start_date: '2026-03-20', end_date: '2026-03-20', dependencies: [{ id: 1, type, lag: 0 }] }),
                makeSubphase({ id: 5, start_date: '2026-03-20', end_date: '2026-03-20', dependencies: [{ id: 1, type: 'FS', lag: 0, entity: 'phase' }] }),
              ],
            }),
          ],
        }),
        makePhase({
          id: 11,
          children: [makeSubphase({ id: 4, start_date: '2026-03-25', end_date: '2026-03-26', dependencies: [{ id: 3, type: 'FS', lag: 0 }] })],
        }),
      ],
    });
  }
  const sub = (p: Project, id: number) => {
    const all = p.phases.flatMap((ph) => ph.children.flatMap((c) => [c, ...c.children]));
    const s = all.find((x) => x.id === id)!;
    return [s.start_date, s.end_date];
  };

  it('moves nested successors and their own successors across phases', () => {
    const project = subProject('FS');
    const updates: PendingUpdate[] = [];
    cascadeDependentSubphases(project, 1, updates);
    expect(sub(project, 3)).toEqual(['2026-03-05', '2026-03-05']);
    expect(sub(project, 4)).toEqual(['2026-03-06', '2026-03-07']);
    // a dependency on PHASE 1 is not about subphase 1
    expect(sub(project, 5)).toEqual(['2026-03-20', '2026-03-20']);
    expect(updates.map((u) => [u.type, u.id])).toEqual([['subphase', 3], ['subphase', 4]]);
  });

  it('supports start-to-start and ignores unknown subphases', () => {
    const project = subProject('SS');
    const updates: PendingUpdate[] = [];
    cascadeDependentSubphases(project, 1, updates);
    expect(sub(project, 3)).toEqual(['2026-03-02', '2026-03-02']);
    cascadeDependentSubphases(project, 999, updates);
    expect(updates).toHaveLength(2);
  });
});

describe('parent and project dates', () => {
  it('fits a phase to its children and then the project to its phases', () => {
    const project = makeProject({
      id: 1,
      start_date: '2026-03-02',
      end_date: '2026-03-31',
      phases: [
        makePhase({
          id: 10,
          start_date: '2026-03-02',
          end_date: '2026-03-31',
          children: [
            makeSubphase({ id: 1, start_date: '2026-03-05', end_date: '2026-03-10' }),
            makeSubphase({ id: 2, start_date: '2026-03-12', end_date: '2026-03-20' }),
          ],
        }),
      ],
    });
    const updates: PendingUpdate[] = [];
    cascadePhaseDatesFromChildren(project, 10, updates);
    expect(dates(project, 10)).toEqual(['2026-03-05', '2026-03-20']);
    expect(updates[0]).toEqual({ type: 'phase', id: 10, start_date: '2026-03-05', end_date: '2026-03-20' });
    expect(updates[1]).toMatchObject({ type: 'project', id: 1, start_date: '2026-03-05', end_date: '2026-03-20', name: project.name });

    // already fitted: nothing more
    cascadePhaseDatesFromChildren(project, 10, updates);
    // unknown or childless phase: nothing
    cascadePhaseDatesFromChildren(project, 99, updates);
    expect(updates).toHaveLength(2);
  });

  it('updates an already queued project write instead of adding a second one', () => {
    const project = makeProject({
      id: 1,
      start_date: '2026-03-01',
      end_date: '2026-03-31',
      phases: [makePhase({ id: 10, start_date: '2026-03-05', end_date: '2026-03-06' })],
    });
    const updates: PendingUpdate[] = [{ type: 'project', id: 1, start_date: 'x', end_date: 'y', name: 'P' }];
    autoAdjustProjectDates(project, updates);
    expect(updates).toEqual([{ type: 'project', id: 1, start_date: '2026-03-05', end_date: '2026-03-06', name: 'P' }]);

    const empty = makeProject({ phases: [] });
    autoAdjustProjectDates(empty, updates);
    expect(updates).toHaveLength(1);
  });

  it('processPhaseMove returns the project update, processSubphaseMove the parent chain', () => {
    const project = makeProject({
      id: 1,
      start_date: '2026-03-02',
      end_date: '2026-03-06',
      phases: [
        makePhase({
          id: 10,
          start_date: '2026-03-02',
          end_date: '2026-03-06',
          children: [makeSubphase({ id: 1, start_date: '2026-03-02', end_date: '2026-03-12' })],
        }),
      ],
    });
    const copy = cloneProject(project);
    expect(copy).not.toBe(project);
    expect(processSubphaseMove(copy, 1, '2026-03-06', '2026-03-12').map((u) => [u.type, u.id, u.end_date])).toEqual([
      ['phase', 10, '2026-03-12'],
      ['project', 1, '2026-03-12'],
    ]);
    expect(processPhaseMove(project, 10, '', '')).toEqual([]);
    // an orphan subphase id walks nowhere
    const updates: PendingUpdate[] = [];
    cascadeParentDatesUp(project, 404, updates);
    expect(updates).toEqual([]);
  });
});

describe('moving bookings with their parents', () => {
  it('moves dated project bookings and equipment at every level, skips undated or invalid ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = makeProject({
      id: 1,
      phases: [
        makePhase({
          id: 10,
          start_date: '2026-03-02',
          end_date: '2026-03-06',
          // Linked phase/subphase staff rows follow their item: never written
          // (unlinked segments: see "unlinked card bookings" below)
          staffAssignments: [{ id: 11, staff_id: 4, allocation: 50, start_date: '2026-03-02', end_date: '2026-03-03' }],
          equipmentAssignments: [
            { id: 2, equipment_id: 1, start_date: '2026-03-04', end_date: '2026-03-05' },
            { id: 3, equipment_id: 1, start_date: '', end_date: '' },
            { id: 4, equipment_id: 1, start_date: 'soon', end_date: 'later' },
          ],
          children: [
            makeSubphase({
              id: 20,
              start_date: '2026-03-02',
              end_date: '2026-03-03',
              staffAssignments: [{ id: 12, staff_id: 4, allocation: 10, start_date: '2026-03-02', end_date: '2026-03-02' }],
              equipmentAssignments: [{ id: 7, equipment_id: 1, start_date: '2026-03-03', end_date: '2026-03-03' }],
            }),
          ],
        }),
      ],
      staffAssignments: [
        { id: 1, staff_id: 4, allocation: 50, start_date: '2026-03-02', end_date: '2026-03-03' },
        { id: 5, staff_id: 4, allocation: undefined as unknown as number, start_date: '2026-03-02', end_date: '2026-03-02' },
        { id: 6, staff_id: 4, allocation: 10, start_date: 'bad', end_date: 'bad' },
        { id: 9, staff_id: 4, allocation: 10, start_date: '', end_date: '' },
      ],
      equipmentAssignments: [{ id: 8, equipment_id: 1, start_date: '2026-03-09', end_date: '2026-03-10' }],
    });

    const updates: PendingUpdate[] = [];
    movePhasesWithProject(project, 7, updates);
    const byKey = Object.fromEntries(updates.map((u) => [`${u.type}-${u.id}`, u]));
    expect(byKey['phase-10']).toMatchObject({ start_date: '2026-03-09', end_date: '2026-03-13' });
    expect(byKey['staffAssignment-1']).toMatchObject({ start_date: '2026-03-09', allocation: 50 });
    expect(byKey['equipmentAssignment-2']).toMatchObject({ start_date: '2026-03-11', end_date: '2026-03-12' });
    expect(byKey['subphase-20']).toMatchObject({ start_date: '2026-03-09' });
    expect(byKey['staffAssignment-5']).toMatchObject({ start_date: '2026-03-09', allocation: 100 });
    expect(byKey['equipmentAssignment-7']).toMatchObject({ start_date: '2026-03-10' });
    expect(byKey['equipmentAssignment-8']).toMatchObject({ start_date: '2026-03-16' });
    for (const skipped of [
      'equipmentAssignment-3', 'equipmentAssignment-4', 'staffAssignment-6', 'staffAssignment-9',
      'staffAssignment-11', 'staffAssignment-12',
    ]) {
      expect(byKey[skipped]).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it('moveChildrenByOffset can shift backwards', () => {
    const children = [makeSubphase({ id: 1, start_date: '2026-03-10', end_date: '2026-03-12' })];
    const updates: PendingUpdate[] = [];
    moveChildrenByOffset(children, -3, updates);
    expect(children[0]).toMatchObject({ start_date: '2026-03-07', end_date: '2026-03-09' });
  });
});

describe('savePendingUpdates per type', () => {
  beforeEach(() => {
    vi.mocked(updatePhase).mockReset().mockResolvedValue({} as never);
    vi.mocked(updateSubphase).mockReset().mockResolvedValue({} as never);
    vi.mocked(updateProject).mockReset().mockResolvedValue({} as never);
    vi.mocked(updateEquipmentAssignment).mockReset().mockResolvedValue({} as never);
  });

  it('sends dependencies only when given, the full project fields, and equipment dates', async () => {
    await savePendingUpdates([
      { type: 'phase', id: 1, start_date: 'a', end_date: 'b', dependencies: [] },
      { type: 'subphase', id: 2, start_date: 'a', end_date: 'b', dependencies: [{ id: 1, type: 'SS', lag: 0 }] },
      { type: 'subphase', id: 3, start_date: 'a', end_date: 'b' },
      {
        type: 'project',
        id: 4,
        start_date: 'a',
        end_date: 'b',
        name: 'P',
        pm_id: 7,
        customer: 'C',
        sales_pm: null,
        volume: 2,
        confirmed: true,
      },
      { type: 'equipmentAssignment', id: 5, start_date: 'a', end_date: 'b' },
      { type: 'unknown' as never, id: 6, start_date: 'a', end_date: 'b' },
    ]);
    expect(updatePhase).toHaveBeenCalledWith(1, { start_date: 'a', end_date: 'b', dependencies: [] });
    expect(updateSubphase).toHaveBeenCalledWith(2, {
      start_date: 'a',
      end_date: 'b',
      dependencies: [{ id: 1, type: 'SS', lag: 0 }],
    });
    expect(updateSubphase).toHaveBeenCalledWith(3, { start_date: 'a', end_date: 'b' });
    expect(updateProject).toHaveBeenCalledWith(4, {
      name: 'P',
      start_date: 'a',
      end_date: 'b',
      pm_id: 7,
      customer: 'C',
      sales_pm: null,
      volume: 2,
      confirmed: true,
    });
    expect(updateEquipmentAssignment).toHaveBeenCalledWith(5, { start_date: 'a', end_date: 'b' });
  });
});

const seg = (id: number, start: string, end: string, over: Partial<StaffAssignment> = {}): StaffAssignment => ({
  id,
  staff_id: 4,
  allocation: 40,
  start_date: start,
  end_date: end,
  linked: false,
  ...over,
});
const linkedRow = (id: number, start: string, end: string): StaffAssignment => ({
  id,
  staff_id: 5,
  allocation: 60,
  start_date: start,
  end_date: end,
  linked: true,
});

describe('unlinked card bookings follow their card (mirror of the card PUT)', () => {
  // Locally only: the server fits a card's segments in the card PUT, so no
  // staffAssignment update is emitted for them.
  it('translates the unlinked segments of moved phases and subphases locally, writing none', () => {
    const project = makeProject({
      id: 1,
      phases: [
        makePhase({
          id: 10,
          start_date: '2026-03-02',
          end_date: '2026-03-13',
          staffAssignments: [
            linkedRow(1, '2026-03-02', '2026-03-13'),
            seg(2, '2026-03-03', '2026-03-05'),
            seg(3, '2026-03-09', '2026-03-11', { approval_status: 'pending' }),
          ],
          children: [
            makeSubphase({
              id: 20,
              start_date: '2026-03-02',
              end_date: '2026-03-06',
              staffAssignments: [seg(2, '2026-03-04', '2026-03-04')],
            }),
          ],
        }),
      ],
    });
    const updates: PendingUpdate[] = [];

    movePhasesWithProject(project, 7, updates);

    expect(updates.filter((u) => u.type === 'staffAssignment')).toEqual([]);
    expect(updates.map((u) => [u.type, u.id])).toEqual([['phase', 10], ['subphase', 20]]);
    const [linked, moved, pending] = project.phases[0].staffAssignments;
    // Linked: the card's dates. Unlinked and pending: translated.
    expect([linked.start_date, linked.end_date]).toEqual(['2026-03-09', '2026-03-20']);
    expect([moved.start_date, moved.end_date]).toEqual(['2026-03-10', '2026-03-12']);
    expect(project.phases[0].children[0].staffAssignments[0]).toMatchObject({ start_date: '2026-03-11', end_date: '2026-03-11' });
    expect([pending.start_date, pending.end_date]).toEqual(['2026-03-16', '2026-03-18']);
  });

  it('clamps the segments of a parent the cascade contracts, locally', () => {
    const project = makeProject({
      id: 1,
      start_date: '2026-03-02',
      end_date: '2026-03-13',
      phases: [
        makePhase({
          id: 10,
          start_date: '2026-03-02',
          end_date: '2026-03-13',
          staffAssignments: [seg(5, '2026-03-09', '2026-03-12')],
          children: [makeSubphase({ id: 20, start_date: '2026-03-02', end_date: '2026-03-10' })],
        }),
      ],
    });
    const updates: PendingUpdate[] = [];

    cascadeParentDatesUp(project, 20, updates);

    expect(project.phases[0].end_date).toBe('2026-03-10');
    expect(project.phases[0].staffAssignments[0]).toMatchObject({ start_date: '2026-03-09', end_date: '2026-03-10' });
    expect(updates.filter((u) => u.type === 'staffAssignment')).toEqual([]);
  });

  it('fits the phase bookings when the phase takes its children\'s dates', () => {
    const project = makeProject({
      id: 1,
      start_date: '2026-03-02',
      end_date: '2026-03-13',
      phases: [
        makePhase({
          id: 10,
          start_date: '2026-03-02',
          end_date: '2026-03-13',
          staffAssignments: [seg(5, '2026-03-02', '2026-03-03')],
          children: [makeSubphase({ id: 20, start_date: '2026-03-09', end_date: '2026-03-13' })],
        }),
      ],
    });
    const updates: PendingUpdate[] = [];

    cascadePhaseDatesFromChildren(project, 10, updates);

    // Fully before the new start: against it, length kept
    expect(project.phases[0].staffAssignments[0]).toMatchObject({ start_date: '2026-03-09', end_date: '2026-03-10' });
    expect(updates.filter((u) => u.type === 'staffAssignment')).toEqual([]);
  });

  it('fitCardBookings changes nothing when the card kept its dates', () => {
    const card = makeSubphase({ id: 20, start_date: '2026-03-02', end_date: '2026-03-06', staffAssignments: [seg(2, '2026-03-03', '2026-03-04')] });
    fitCardBookings(card, '2026-03-02', '2026-03-06');
    expect(card.staffAssignments[0]).toMatchObject({ start_date: '2026-03-03', end_date: '2026-03-04' });
  });

  it('savePendingUpdates writes the cards first, then the bookings (two waves)', async () => {
    const order: string[] = [];
    let releasePhase: () => void = () => {};
    vi.mocked(updatePhase).mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePhase = () => {
            order.push('phase done');
            resolve({} as never);
          };
        })
    );
    vi.mocked(updateStaffAssignment).mockReset().mockImplementation(async () => {
      order.push('segment');
      return {} as never;
    });
    vi.mocked(updateEquipmentAssignment).mockReset().mockImplementation(async () => {
      order.push('equipment');
      return {} as never;
    });

    // The booking is listed first: the waves, not the list order, decide.
    const saving = savePendingUpdates([
      { type: 'staffAssignment', id: 2, level: 'phase', start_date: '2026-03-10', end_date: '2026-03-12', allocation: 40 },
      { type: 'equipmentAssignment', id: 3, start_date: '2026-03-10', end_date: '2026-03-12' },
      { type: 'phase', id: 10, start_date: '2026-03-09', end_date: '2026-03-20' },
    ]);
    await Promise.resolve();
    expect(updateStaffAssignment).not.toHaveBeenCalled();
    expect(updateEquipmentAssignment).not.toHaveBeenCalled();

    releasePhase();
    await saving;

    expect(order).toEqual(['phase done', 'segment', 'equipment']);
    expect(updateStaffAssignment).toHaveBeenCalledWith(
      2,
      { start_date: '2026-03-10', end_date: '2026-03-12', allocation: 40 },
      'phase'
    );
  });

  it('a failed card still lets its bookings be attempted, and every failure is reported', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(updatePhase).mockReset().mockRejectedValue(new Error('card failed'));
    vi.mocked(updateStaffAssignment).mockReset().mockRejectedValue(new Error('segment failed'));

    await expect(
      savePendingUpdates([
        { type: 'phase', id: 10, start_date: 'a', end_date: 'b' },
        { type: 'staffAssignment', id: 2, level: 'phase', start_date: 'a', end_date: 'b', allocation: 40 },
      ])
    ).rejects.toMatchObject({ name: 'PendingUpdatesError', total: 2, failures: [
      expect.objectContaining({ update: expect.objectContaining({ type: 'phase' }) }),
      expect.objectContaining({ update: expect.objectContaining({ type: 'staffAssignment' }) }),
    ] });
  });

  it('a relink update sends null dates', async () => {
    vi.mocked(updateStaffAssignment).mockReset().mockResolvedValue({} as never);
    await savePendingUpdates([
      { type: 'staffAssignment', id: 2, level: 'subphase', start_date: '2026-03-02', end_date: '2026-03-06', allocation: 40, relink: true },
    ]);
    expect(updateStaffAssignment).toHaveBeenCalledWith(2, { start_date: null, end_date: null, allocation: 40 }, 'subphase');
  });
});
