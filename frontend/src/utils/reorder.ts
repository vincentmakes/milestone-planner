/**
 * Local (optimistic) application of a phase/subphase reorder.
 *
 * The Gantt renders phases and subphases in array order, so a reorder is
 * applied by permuting the sibling array and renumbering `order_index`.
 * Used by ReorderContext before the server call, which makes the new order
 * visible immediately — including in What-If mode, where the PUT is queued
 * and no server reload happens.
 */
import type { Project, Subphase } from '@/types';

function permute<T extends { id: number; order_index: number }>(items: T[], order: number[]): T[] | null {
  const byId = new Map(items.map((it) => [it.id, it]));
  if (order.length !== items.length || order.some((id) => !byId.has(id))) return null;
  return order.map((id, idx) => ({ ...byId.get(id)!, order_index: idx }));
}

function reorderChildrenOf(children: Subphase[], parentId: number, order: number[]): Subphase[] | null {
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.id === parentId) {
      const reordered = permute(child.children ?? [], order);
      if (!reordered) return null;
      const next = [...children];
      next[i] = { ...child, children: reordered };
      return next;
    }
    if (child.children?.length) {
      const nested = reorderChildrenOf(child.children, parentId, order);
      if (nested) {
        const next = [...children];
        next[i] = { ...child, children: nested };
        return next;
      }
    }
  }
  return null;
}

/**
 * Return a new projects array with the reorder applied, or `null` when the
 * target could not be found or `order` does not match its siblings (the caller
 * then just relies on the server reload).
 */
export function applyLocalReorder(
  projects: Project[],
  type: 'phase' | 'subphase',
  projectId: number,
  order: number[],
  parentId?: number,
  parentType?: 'phase' | 'subphase'
): Project[] | null {
  const pIdx = projects.findIndex((p) => p.id === projectId);
  if (pIdx === -1) return null;
  const project = projects[pIdx];
  const phases = project.phases ?? [];
  let nextPhases: typeof phases | null = null;

  if (type === 'phase') {
    nextPhases = permute(phases, order);
  } else if (parentId != null) {
    if (parentType === 'phase') {
      const phIdx = phases.findIndex((ph) => ph.id === parentId);
      if (phIdx === -1) return null;
      const reordered = permute(phases[phIdx].children ?? [], order);
      if (reordered) {
        nextPhases = [...phases];
        nextPhases[phIdx] = { ...phases[phIdx], children: reordered };
      }
    } else {
      for (let i = 0; i < phases.length && !nextPhases; i++) {
        const nested = reorderChildrenOf(phases[i].children ?? [], parentId, order);
        if (nested) {
          nextPhases = [...phases];
          nextPhases[i] = { ...phases[i], children: nested };
        }
      }
    }
  }

  if (!nextPhases) return null;
  const next = [...projects];
  next[pIdx] = { ...project, phases: nextPhases };
  return next;
}
