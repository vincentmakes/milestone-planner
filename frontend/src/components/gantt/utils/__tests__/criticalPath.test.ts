/**
 * Critical path (CPM): the forward/backward passes run over a topological
 * order of the dependency graph, so a constraint propagates down a whole
 * chain even when the items are drawn out of order on the timeline (manual
 * lead/lag is allowed). Items on a dependency cycle are skipped.
 */

import { describe, it, expect } from 'vitest';
import { calculateCriticalPath } from '../criticalPath';
import type { Dependency, Phase, Project, Subphase } from '@/types';

function phase(id: number, start: string, end: string, dependencies: Dependency[] = [], children: Subphase[] = []): Phase {
  return {
    id,
    project_id: 1,
    name: `Phase ${id}`,
    start_date: start,
    end_date: end,
    color: '#000',
    order_index: id,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies,
    children,
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Phase;
}

function subphase(id: number, start: string, end: string, dependencies: Dependency[] = []): Subphase {
  return {
    id,
    project_id: 1,
    parent_phase_id: 1,
    parent_subphase_id: null,
    name: `Subphase ${id}`,
    start_date: start,
    end_date: end,
    color: '#000',
    order_index: id,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies,
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Subphase;
}

function project(phases: Phase[]): Project {
  return { id: 1, name: 'P', site_id: 1, phases } as unknown as Project;
}

const fs = (id: number, lag = 0): Dependency => ({ id, type: 'FS', lag });

describe('calculateCriticalPath', () => {
  it('reports no dependencies for an unlinked project', () => {
    const result = calculateCriticalPath(project([phase(1, '2026-03-01', '2026-03-10')]));
    expect(result.hasDependencies).toBe(false);
  });

  it('keeps a whole chain critical when successors are drawn before their predecessors finish', () => {
    // A(Mar 1-10) -> B(Mar 5-8) -> C(Mar 3-4): C is the last node of the chain
    // but starts earliest. A start-sorted pass visited C before B was pushed,
    // so C dropped off the path.
    const result = calculateCriticalPath(
      project([
        phase(1, '2026-03-01', '2026-03-10'),
        phase(2, '2026-03-05', '2026-03-08', [fs(1)]),
        phase(3, '2026-03-03', '2026-03-04', [fs(2)]),
      ])
    );

    expect(result.hasDependencies).toBe(true);
    expect(result.criticalItems).toEqual(new Set(['phase-1', 'phase-2', 'phase-3']));
  });

  it('leaves an item with slack off the path', () => {
    // A(Mar 1-10) -> B(Mar 11-20); D(Mar 1-5) -> B as well, with 5 days of slack
    const result = calculateCriticalPath(
      project([
        phase(1, '2026-03-01', '2026-03-10'),
        phase(4, '2026-03-01', '2026-03-05'),
        phase(2, '2026-03-11', '2026-03-20', [fs(1), fs(4)]),
      ])
    );

    expect(result.criticalItems).toEqual(new Set(['phase-1', 'phase-2']));
  });

  it('follows chains through subphases', () => {
    const result = calculateCriticalPath(
      project([
        phase(1, '2026-03-01', '2026-03-31', [], [
          subphase(10, '2026-03-01', '2026-03-10'),
          subphase(11, '2026-03-11', '2026-03-31', [fs(10)]),
          subphase(12, '2026-03-01', '2026-03-03'),
        ]),
      ])
    );

    expect(result.criticalItems.has('subphase-10')).toBe(true);
    expect(result.criticalItems.has('subphase-11')).toBe(true);
    expect(result.criticalItems.has('subphase-12')).toBe(false);
  });

  it('terminates on a dependency cycle and skips the cycle members', () => {
    // 1 <-> 2 is a cycle; 3 -> 4 is a normal chain
    const result = calculateCriticalPath(
      project([
        phase(1, '2026-03-01', '2026-03-05', [fs(2)]),
        phase(2, '2026-03-06', '2026-03-10', [fs(1)]),
        phase(3, '2026-03-01', '2026-03-15'),
        phase(4, '2026-03-16', '2026-03-31', [fs(3)]),
      ])
    );

    expect(result.criticalItems.has('phase-1')).toBe(false);
    expect(result.criticalItems.has('phase-2')).toBe(false);
    expect(result.criticalItems.has('phase-3')).toBe(true);
    expect(result.criticalItems.has('phase-4')).toBe(true);
  });

  it('ignores a self-dependency', () => {
    const result = calculateCriticalPath(
      project([
        phase(1, '2026-03-01', '2026-03-10', [fs(1)]),
        phase(2, '2026-03-11', '2026-03-20', [fs(1)]),
      ])
    );

    expect(result.criticalItems).toEqual(new Set(['phase-1', 'phase-2']));
  });
});

/**
 * Phase and subphase ids are separate sequences, so a subphase can share its
 * id with a phase of the same project. An entry's `entity` names the
 * predecessor's kind; legacy entries without it resolve phase-first.
 */
describe('calculateCriticalPath entity-typed dependencies', () => {
  // Phase 1 (Mar 1-20) and subphase 1 (Mar 1-5, under phase 2) share id 1.
  // Subphase 3 (Mar 6-31) depends on "1".
  const build = (dep: Dependency) =>
    project([
      phase(1, '2026-03-01', '2026-03-20'),
      phase(2, '2026-03-01', '2026-03-31', [], [
        subphase(1, '2026-03-01', '2026-03-05'),
        subphase(3, '2026-03-06', '2026-03-31', [dep]),
      ]),
    ]);

  it('links to the subphase when the entry says entity: subphase', () => {
    const { criticalItems } = calculateCriticalPath(build({ id: 1, type: 'FS', entity: 'subphase' }));
    expect(criticalItems.has('subphase-1')).toBe(true);
    expect(criticalItems.has('subphase-3')).toBe(true);
    expect(criticalItems.has('phase-1')).toBe(false);
  });

  it('keeps the phase-first lookup for a legacy entry without entity', () => {
    const { criticalItems } = calculateCriticalPath(build({ id: 1, type: 'FS' }));
    expect(criticalItems.has('phase-1')).toBe(true);
    expect(criticalItems.has('subphase-1')).toBe(false);
  });

  it('ignores an entity-typed entry whose predecessor is gone instead of falling back', () => {
    const p = project([
      phase(1, '2026-03-01', '2026-03-20'),
      phase(2, '2026-03-01', '2026-03-31', [], [subphase(3, '2026-03-06', '2026-03-31', [{ id: 1, type: 'FS', entity: 'subphase' }])]),
    ]);
    const { criticalItems } = calculateCriticalPath(p);
    expect(criticalItems.has('phase-1')).toBe(false);
  });
});

