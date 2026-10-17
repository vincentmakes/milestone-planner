import { describe, it, expect } from 'vitest';
import { applyLocalReorder } from '../reorder';
import type { Phase, Project, Subphase } from '@/types';

const sub = (id: number, children: Subphase[] = []): Subphase =>
  ({ id, order_index: 0, children, name: `S${id}` }) as unknown as Subphase;
const phase = (id: number, children: Subphase[] = []): Phase =>
  ({ id, order_index: 0, children, name: `P${id}` }) as unknown as Phase;

function tree(): Project[] {
  return [
    {
      id: 1, name: 'P', site_id: 1, confirmed: true, archived: false,
      staffAssignments: [], equipmentAssignments: [],
      phases: [phase(10, [sub(20), sub(21, [sub(30), sub(31), sub(32)])]), phase(11)],
    },
  ];
}

describe('applyLocalReorder', () => {
  it('reorders phases and renumbers order_index without mutating the input', () => {
    const input = tree();
    const out = applyLocalReorder(input, 'phase', 1, [11, 10])!;
    expect(out[0].phases.map((p) => [p.id, p.order_index])).toEqual([[11, 0], [10, 1]]);
    expect(input[0].phases.map((p) => p.id)).toEqual([10, 11]);
  });

  it('reorders the subphases of a phase', () => {
    const out = applyLocalReorder(tree(), 'subphase', 1, [21, 20], 10, 'phase')!;
    expect(out[0].phases[0].children.map((s) => s.id)).toEqual([21, 20]);
  });

  it('reorders nested subphases of a subphase', () => {
    const out = applyLocalReorder(tree(), 'subphase', 1, [32, 30, 31], 21, 'subphase')!;
    expect(out[0].phases[0].children[1].children.map((s) => [s.id, s.order_index])).toEqual([
      [32, 0], [30, 1], [31, 2],
    ]);
  });

  it('returns null when the order does not match the siblings', () => {
    expect(applyLocalReorder(tree(), 'phase', 1, [10])).toBeNull();
    expect(applyLocalReorder(tree(), 'phase', 99, [10, 11])).toBeNull();
    expect(applyLocalReorder(tree(), 'subphase', 1, [1, 2], 777, 'subphase')).toBeNull();
  });
});
