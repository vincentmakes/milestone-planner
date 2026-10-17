/**
 * Dependency entries carry an optional `entity` naming the predecessor's
 * kind, because phase and subphase ids are separate sequences and routinely
 * collide inside one project. Resolution prefers it; legacy entries (no
 * `entity`, sometimes no `type`) keep the phase-first lookup.
 */

import { describe, it, expect } from 'vitest';
import {
  dependencyMatches,
  extractDependencies,
  resolveDependencyPredecessor,
  wouldCreateDependencyCycle,
} from '../dependencies';
import type { Dependency, Phase, Project, Subphase } from '@/types';

function subphase(id: number, dependencies: Dependency[] = [], children: Subphase[] = []): Subphase {
  return {
    id,
    name: `Subphase ${id}`,
    start_date: '2026-03-01',
    end_date: '2026-03-05',
    dependencies,
    children,
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Subphase;
}

function phase(id: number, dependencies: Dependency[] = [], children: Subphase[] = []): Phase {
  return {
    id,
    name: `Phase ${id}`,
    start_date: '2026-03-01',
    end_date: '2026-03-31',
    dependencies,
    children,
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Phase;
}

function project(phases: Phase[]): Project {
  return { id: 1, name: 'P', site_id: 1, phases } as unknown as Project;
}

// Phase 5 and subphase 5 share the id; subphase 7 is the successor.
const withSuccessorDeps = (deps: Dependency[]) =>
  project([phase(5), phase(6, [], [subphase(5), subphase(7, deps)])]);

describe('resolveDependencyPredecessor', () => {
  it('resolves an entity: subphase entry to the subphase despite a phase with the same id', () => {
    const p = withSuccessorDeps([]);
    expect(resolveDependencyPredecessor(p, { id: 5, entity: 'subphase' })).toMatchObject({
      type: 'subphase',
      item: { name: 'Subphase 5' },
    });
    expect(resolveDependencyPredecessor(p, { id: 5, entity: 'phase' })).toMatchObject({
      type: 'phase',
      item: { name: 'Phase 5' },
    });
  });

  it('keeps the phase-first lookup for legacy entries', () => {
    const p = withSuccessorDeps([]);
    expect(resolveDependencyPredecessor(p, { id: 5 })?.type).toBe('phase');
    // Only a subphase has the id: legacy lookup still finds it
    expect(resolveDependencyPredecessor(p, { id: 7 })?.type).toBe('subphase');
  });

  it('does not fall back to the other kind when the named predecessor is gone', () => {
    const p = project([phase(5), phase(6, [], [subphase(7)])]);
    expect(resolveDependencyPredecessor(p, { id: 5, entity: 'subphase' })).toBeNull();
  });
});

describe('extractDependencies', () => {
  it('draws the arrow from the subphase named by entity', () => {
    const links = extractDependencies([withSuccessorDeps([{ id: 5, type: 'FS', entity: 'subphase' }])]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ fromId: 5, fromType: 'subphase', toId: 7, toType: 'subphase', type: 'FS' });
  });

  it('draws a legacy entry from the phase and defaults its type to FS', () => {
    const links = extractDependencies([withSuccessorDeps([{ id: 5 } as Dependency])]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ fromType: 'phase', type: 'FS', lag: 0 });
  });

  it('gives links from same-id predecessors of both kinds distinct keys', () => {
    const links = extractDependencies([
      withSuccessorDeps([
        { id: 5, type: 'FS', entity: 'phase' },
        { id: 5, type: 'FS', entity: 'subphase' },
        { id: 5, type: 'SS', entity: 'subphase' },
      ]),
    ]);
    expect(new Set(links.map((l) => l.id)).size).toBe(3);
  });
});

describe('dependencyMatches', () => {
  it('matches a legacy untyped entry as FS from the phase it resolves to', () => {
    const p = withSuccessorDeps([]);
    const legacy = { id: 5 } as Dependency;
    expect(dependencyMatches(p, legacy, { id: 5, type: 'phase' }, 'FS')).toBe(true);
    expect(dependencyMatches(p, legacy, { id: 5, type: 'subphase' }, 'FS')).toBe(false);
    expect(dependencyMatches(p, legacy, { id: 5, type: 'phase' }, 'SS')).toBe(false);
  });

  it('matches entity-typed entries by kind', () => {
    const p = withSuccessorDeps([]);
    const dep: Dependency = { id: 5, type: 'SS', entity: 'subphase' };
    expect(dependencyMatches(p, dep, { id: 5, type: 'subphase' }, 'SS')).toBe(true);
    expect(dependencyMatches(p, dep, { id: 5, type: 'phase' }, 'SS')).toBe(false);
  });
});

describe('wouldCreateDependencyCycle', () => {
  it('detects a cycle that runs through a phase and a subphase', () => {
    // Phase 1 already depends on subphase 10; linking phase 1 -> subphase 10
    // (subphase 10 depends on phase 1) closes the loop.
    const p = project([phase(1, [{ id: 10, type: 'FS', entity: 'subphase' }]), phase(2, [], [subphase(10)])]);
    expect(wouldCreateDependencyCycle(p, { id: 1, type: 'phase' }, { id: 10, type: 'subphase' })).toBe(true);
  });

  it('detects a cycle through legacy entries (phase-first resolution)', () => {
    // subphase 10 depends on legacy "1" = phase 1; linking subphase 10 -> phase 1 closes it
    const p = project([phase(1), phase(2, [], [subphase(10, [{ id: 1, type: 'FS' }])])]);
    expect(wouldCreateDependencyCycle(p, { id: 10, type: 'subphase' }, { id: 1, type: 'phase' })).toBe(true);
  });

  it('detects the reverse of an existing link (A -> B exists, B -> A is a cycle)', () => {
    const p = project([phase(1), phase(2, [{ id: 1, type: 'FS', entity: 'phase' }])]);
    expect(wouldCreateDependencyCycle(p, { id: 2, type: 'phase' }, { id: 1, type: 'phase' })).toBe(true);
  });

  it('allows a transitive shortcut (A -> B -> C exists, A -> C is not a cycle)', () => {
    const p = project([
      phase(1),
      phase(2, [{ id: 1, type: 'FS', entity: 'phase' }]),
      phase(3, [{ id: 2, type: 'FS', entity: 'phase' }]),
    ]);
    expect(wouldCreateDependencyCycle(p, { id: 1, type: 'phase' }, { id: 3, type: 'phase' })).toBe(false);
  });

  it('does not confuse a subphase with the phase sharing its id', () => {
    // Phase 5 depends on phase 1. Linking subphase 5 -> phase 1 is fine: the
    // cycle would only exist if it were phase 5.
    const p = project([phase(1), phase(5, [{ id: 1, type: 'FS', entity: 'phase' }]), phase(6, [], [subphase(5)])]);
    expect(wouldCreateDependencyCycle(p, { id: 5, type: 'subphase' }, { id: 1, type: 'phase' })).toBe(false);
    expect(wouldCreateDependencyCycle(p, { id: 5, type: 'phase' }, { id: 1, type: 'phase' })).toBe(true);
  });

  it('treats a self-link as a cycle', () => {
    const p = project([phase(1)]);
    expect(wouldCreateDependencyCycle(p, { id: 1, type: 'phase' }, { id: 1, type: 'phase' })).toBe(true);
  });
});
