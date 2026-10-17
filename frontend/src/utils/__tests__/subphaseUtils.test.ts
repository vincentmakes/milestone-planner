import { describe, it, expect } from 'vitest';
import { findParentSubphase, findPhaseContainingSubphase, findSubphaseById } from '../subphaseUtils';
import { makePhase, makeSubphase } from '@/test/factories';
import type { Phase } from '@/types';

function phases(): Phase[] {
  const deep = makeSubphase({ id: 103, name: 'Deep', parent_subphase_id: 102 });
  const mid = makeSubphase({ id: 102, name: 'Mid', parent_subphase_id: null, children: [deep] });
  const sibling = makeSubphase({ id: 101, name: 'Sibling', children: [] });
  return [
    makePhase({ id: 1, name: 'Empty phase', children: undefined as never }),
    makePhase({ id: 2, name: 'Phase 2', children: [sibling, mid] }),
  ];
}

describe('subphaseUtils', () => {
  it('finds a subphase at any depth', () => {
    expect(findSubphaseById(phases(), 101)?.name).toBe('Sibling');
    expect(findSubphaseById(phases(), 103)?.name).toBe('Deep');
    expect(findSubphaseById(phases(), 999)).toBeNull();
  });

  it('finds the top-level phase that contains a subphase', () => {
    expect(findPhaseContainingSubphase(phases(), 103)?.id).toBe(2);
    expect(findPhaseContainingSubphase(phases(), 999)).toBeNull();
  });

  it('finds the immediate parent subphase, or null for direct children of a phase', () => {
    expect(findParentSubphase(phases(), 103)?.id).toBe(102);
    expect(findParentSubphase(phases(), 102)).toBeNull();
    expect(findParentSubphase(phases(), 999)).toBeNull();
  });
});
