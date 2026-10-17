/**
 * Undo/redo persistence (diffProjects → savePendingUpdates). F1-26: a
 * dependency link created or removed after a snapshot must be written back
 * on undo, not only the dates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project, Phase, Subphase, Dependency } from '@/types';

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

  it('ignores items that only exist on one side', () => {
    const before = project([phase(10, '2026-03-02', '2026-03-06')]);
    const after = project([phase(10, '2026-03-02', '2026-03-06'), phase(12, '2026-04-01', '2026-04-02', [LINK])]);
    expect(diffProjects([before], [after])).toEqual([]);
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
