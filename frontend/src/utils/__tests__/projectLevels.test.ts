import { describe, it, expect } from 'vitest';
import { makePhase, makeProject, makeSubphase } from '@/test/factories';
import {
  expansionLevelOf,
  getCurrentExpansionLevel,
  getProjectLevelItems,
} from '../projectLevels';

const nested = makeSubphase({ id: 31, children: [] });
const direct = makeSubphase({ id: 21, children: [nested] });
const project = makeProject({
  id: 1,
  phases: [
    makePhase({ id: 11, children: [direct] }),
    makePhase({ id: 12, is_milestone: true, children: [] }),
  ],
});

describe('getProjectLevelItems', () => {
  it('maps phases, direct subphases and nested subphases to levels 1, 2, 3 (milestones excluded)', () => {
    const { levels, maxLevel } = getProjectLevelItems(project);
    expect(maxLevel).toBe(3);
    expect(levels[1]).toEqual([{ type: 'phase', id: 11, hasChildren: true }]);
    expect(levels[2]).toEqual([{ type: 'subphase', id: 21, hasChildren: true }]);
    expect(levels[3]).toEqual([{ type: 'subphase', id: 31, hasChildren: false }]);
  });

  it('allows level 1 for a project without phases', () => {
    expect(getProjectLevelItems(makeProject({ id: 2, phases: [] })).maxLevel).toBe(1);
  });
});

describe('expansionLevelOf', () => {
  const items = getProjectLevelItems(project);

  it('steps through the levels as phases and subphases expand', () => {
    expect(expansionLevelOf(items, new Set(), new Set())).toBe(1);
    expect(expansionLevelOf(items, new Set([11]), new Set())).toBe(2);
    expect(expansionLevelOf(items, new Set([11]), new Set([21]))).toBe(3);
  });

  it('is level 1 for a project without phases', () => {
    const empty = getProjectLevelItems(makeProject({ id: 2, phases: [] }));
    expect(expansionLevelOf(empty, new Set(), new Set())).toBe(1);
  });

  it('matches getCurrentExpansionLevel, which is 0 while the project is collapsed', () => {
    const phases = new Set([11]);
    const subs = new Set([21]);
    expect(getCurrentExpansionLevel(project, new Set(), phases, subs)).toBe(0);
    expect(getCurrentExpansionLevel(project, new Set([1]), phases, subs)).toBe(
      expansionLevelOf(items, phases, subs)
    );
  });
});
