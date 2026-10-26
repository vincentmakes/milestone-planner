/**
 * Undo/redo persistence (diffProjects → savePendingUpdates). F1-26: a
 * dependency link created or removed after a snapshot must be written back
 * on undo, not only the dates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project, Phase, Subphase, Dependency, StaffAssignment } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  updatePhase: vi.fn(async () => ({})),
  updateSubphase: vi.fn(async () => ({})),
  updateProject: vi.fn(async () => ({})),
  updateStaffAssignment: vi.fn(async () => ({})),
  updateEquipmentAssignment: vi.fn(async () => ({})),
}));

import { diffProjects } from '@/components/gantt/utils/diffProjects';
import { savePendingUpdates } from '@/components/gantt/utils/autoCalculation';
import { updatePhase, updateSubphase, updateProject } from '@/api/endpoints/projects';

function sub(id: number, start: string, end: string, deps: Dependency[] = [], children: Subphase[] = []): Subphase {
  return { id, name: `S${id}`, start_date: start, end_date: end, dependencies: deps, children } as unknown as Subphase;
}

function phase(id: number, start: string, end: string, deps: Dependency[] = [], children: Subphase[] = []): Phase {
  return { id, name: `Ph${id}`, start_date: start, end_date: end, dependencies: deps, children } as unknown as Phase;
}

function project(phases: Phase[], start = '2026-03-02', end = '2026-03-31'): Project {
  return {
    id: 1,
    name: 'P',
    site_id: 1,
    confirmed: true,
    archived: false,
    start_date: start,
    end_date: end,
    phases,
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Project;
}

const LINK: Dependency = { id: 10, type: 'FS', lag: 0, entity: 'phase' };

describe('diffProjects', () => {
  it('returns nothing for identical trees', () => {
    const tree = project([phase(10, '2026-03-02', '2026-03-06'), phase(11, '2026-03-09', '2026-03-13', [LINK])]);
    expect(diffProjects([tree], [structuredClone(tree)])).toEqual([]);
  });

  it('diffs dates of phases, nested subphases and the project', () => {
    const before = project([phase(10, '2026-03-02', '2026-03-06', [], [sub(20, '2026-03-02', '2026-03-03', [], [sub(21, '2026-03-02', '2026-03-02')])])]);
    const after = project(
      [phase(10, '2026-03-03', '2026-03-07', [], [sub(20, '2026-03-03', '2026-03-04', [], [sub(21, '2026-03-03', '2026-03-03')])])],
      '2026-03-03',
    );

    const updates = diffProjects([before], [after]);

    expect(updates.map((u) => `${u.type}:${u.id}:${u.start_date}`)).toEqual([
      'project:1:2026-03-03',
      'phase:10:2026-03-03',
      'subphase:20:2026-03-03',
      'subphase:21:2026-03-03',
    ]);
    // Date-only changes do not rewrite the dependency lists.
    expect(updates.every((u) => u.dependencies === undefined)).toBe(true);
  });

  it('emits a phase update carrying the dependencies when only the links differ', () => {
    // Undo target (snapshot) has no link; the current tree has one created later.
    const current = project([phase(10, '2026-03-02', '2026-03-06'), phase(11, '2026-03-09', '2026-03-13', [LINK])]);
    const snapshot = project([phase(10, '2026-03-02', '2026-03-06'), phase(11, '2026-03-09', '2026-03-13', [])]);

    expect(diffProjects([current], [snapshot])).toEqual([
      { type: 'phase', id: 11, start_date: '2026-03-09', end_date: '2026-03-13', dependencies: [] },
    ]);
  });

  it('restores a removed subphase link (redo direction) and treats missing as empty', () => {
    const withoutLink = project([phase(10, '2026-03-02', '2026-03-13', [], [
      { ...sub(20, '2026-03-02', '2026-03-04'), dependencies: undefined } as unknown as Subphase,
      sub(21, '2026-03-05', '2026-03-06'),
    ])]);
    const subLink: Dependency = { id: 20, type: 'SS', lag: 1, entity: 'subphase' };
    const withLink = project([phase(10, '2026-03-02', '2026-03-13', [], [
      sub(20, '2026-03-02', '2026-03-04'),
      sub(21, '2026-03-05', '2026-03-06', [subLink]),
    ])]);

    expect(diffProjects([withoutLink], [withLink])).toEqual([
      { type: 'subphase', id: 21, start_date: '2026-03-05', end_date: '2026-03-06', dependencies: [subLink] },
    ]);
  });

  it('diffs project-level staff rows with their route level and skips pending ones', () => {
    const rows = (start: string, end: string) => [
      { id: 7, staff_id: 1, allocation: 50, start_date: start, end_date: end },
      { id: 8, staff_id: 2, allocation: 30, start_date: start, end_date: end, approval_status: 'pending' as const },
    ];
    const before = project([]);
    before.staffAssignments = rows('2026-03-02', '2026-03-06');
    const after = project([]);
    after.staffAssignments = rows('2026-03-03', '2026-03-07');

    expect(diffProjects([before], [after])).toEqual([
      { type: 'staffAssignment', id: 7, level: 'project', start_date: '2026-03-03', end_date: '2026-03-07', allocation: 50 },
    ]);
  });

  it('ignores items that only exist on one side', () => {
    const before = project([phase(10, '2026-03-02', '2026-03-06')]);
    const after = project([phase(10, '2026-03-02', '2026-03-06'), phase(12, '2026-04-01', '2026-04-02', [LINK])]);
    expect(diffProjects([before], [after])).toEqual([]);
  });
});

describe('diffProjects card bookings (unlinked segments)', () => {
  const row = (over: Partial<StaffAssignment>): StaffAssignment => ({
    id: 5,
    staff_id: 4,
    allocation: 40,
    start_date: '2026-03-03',
    end_date: '2026-03-05',
    linked: false,
    ...over,
  });
  const withRows = <T extends Phase | Subphase>(card: T, rows: StaffAssignment[]): T => ({ ...card, staffAssignments: rows });

  it('restores an unlinked segment of a phase and of a subphase with its level', () => {
    const current = project([
      withRows(phase(10, '2026-03-02', '2026-03-13', [], [withRows(sub(20, '2026-03-02', '2026-03-06'), [row({ id: 6, start_date: '2026-03-04', end_date: '2026-03-04' })])]), [
        row({ start_date: '2026-03-10', end_date: '2026-03-12' }),
      ]),
    ]);
    const snapshot = project([
      withRows(phase(10, '2026-03-02', '2026-03-13', [], [withRows(sub(20, '2026-03-02', '2026-03-06'), [row({ id: 6, start_date: '2026-03-03', end_date: '2026-03-04' })])]), [
        row({}),
      ]),
    ]);

    expect(diffProjects([current], [snapshot])).toEqual([
      { type: 'staffAssignment', id: 5, level: 'phase', start_date: '2026-03-03', end_date: '2026-03-05', allocation: 40 },
      { type: 'staffAssignment', id: 6, level: 'subphase', start_date: '2026-03-03', end_date: '2026-03-04', allocation: 40 },
    ]);
  });

  it('unlinks again a row the snapshot had unlinked, and relinks one it had linked', () => {
    const current = project([
      withRows(phase(10, '2026-03-02', '2026-03-13'), [
        row({ id: 5, linked: true, start_date: '2026-03-02', end_date: '2026-03-13' }),
        row({ id: 6 }),
      ]),
    ]);
    const snapshot = project([
      withRows(phase(10, '2026-03-02', '2026-03-13'), [
        row({ id: 5 }),
        row({ id: 6, linked: true, start_date: '2026-03-02', end_date: '2026-03-13' }),
      ]),
    ]);

    expect(diffProjects([current], [snapshot])).toEqual([
      { type: 'staffAssignment', id: 5, level: 'phase', start_date: '2026-03-03', end_date: '2026-03-05', allocation: 40 },
      { type: 'staffAssignment', id: 6, level: 'phase', start_date: '2026-03-02', end_date: '2026-03-13', allocation: 40, relink: true },
    ]);
  });

  it('skips linked rows, pending rows and rows missing on one side', () => {
    const current = project([
      withRows(phase(10, '2026-03-09', '2026-03-20'), [
        row({ id: 5, linked: true, start_date: '2026-03-09', end_date: '2026-03-20' }),
        row({ id: 6, approval_status: 'pending', start_date: '2026-03-10', end_date: '2026-03-12' }),
      ]),
    ]);
    const snapshot = project([
      withRows(phase(10, '2026-03-02', '2026-03-13'), [
        row({ id: 5, linked: true, start_date: '2026-03-02', end_date: '2026-03-13' }),
        row({ id: 6, approval_status: 'pending' }),
        row({ id: 7 }),
      ]),
    ]);

    expect(diffProjects([current], [snapshot]).filter((u) => u.type === 'staffAssignment')).toEqual([]);
  });
});

describe('savePendingUpdates', () => {
  beforeEach(() => {
    vi.mocked(updatePhase).mockClear();
    vi.mocked(updateSubphase).mockClear();
    vi.mocked(updateProject).mockClear();
  });

  it('sends the dependency list for phase and subphase updates that carry one', async () => {
    await savePendingUpdates([
      { type: 'phase', id: 11, start_date: '2026-03-09', end_date: '2026-03-13', dependencies: [] },
      { type: 'subphase', id: 21, start_date: '2026-03-05', end_date: '2026-03-06', dependencies: [LINK] },
    ]);

    expect(updatePhase).toHaveBeenCalledWith(11, { start_date: '2026-03-09', end_date: '2026-03-13', dependencies: [] });
    expect(updateSubphase).toHaveBeenCalledWith(21, { start_date: '2026-03-05', end_date: '2026-03-06', dependencies: [LINK] });
  });

  it('leaves dependencies untouched for date-only updates', async () => {
    await savePendingUpdates([{ type: 'phase', id: 10, start_date: '2026-03-02', end_date: '2026-03-06' }]);
    expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-03-02', end_date: '2026-03-06' });
  });
});

describe('diffProjects card bookings: date formats', () => {
  it('reads the midnight ISO form and the calendar day as the same date', () => {
    const rowOf = (start: string, end: string) =>
      ({ id: 5, staff_id: 4, allocation: 40, start_date: start, end_date: end, linked: false }) as StaffAssignment;
    const current = project([{ ...phase(10, '2026-03-02', '2026-03-13'), staffAssignments: [rowOf('2026-03-03', '2026-03-05')] }]);
    const same = project([
      { ...phase(10, '2026-03-02', '2026-03-13'), staffAssignments: [rowOf('2026-03-03T00:00:00.000Z', '2026-03-05T00:00:00.000Z')] },
    ]);
    expect(diffProjects([current], [same])).toEqual([]);
    const moved = project([
      { ...phase(10, '2026-03-02', '2026-03-13'), staffAssignments: [rowOf('2026-03-04T00:00:00.000Z', '2026-03-06T00:00:00.000Z')] },
    ]);
    expect(diffProjects([current], [moved])).toEqual([
      { type: 'staffAssignment', id: 5, level: 'phase', start_date: '2026-03-04', end_date: '2026-03-06', allocation: 40 },
    ]);
  });
});
