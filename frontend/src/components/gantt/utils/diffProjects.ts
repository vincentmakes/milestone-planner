/**
 * diffProjects
 *
 * Compares two project trees and produces a list of `PendingUpdate` entries
 * for items whose start_date / end_date differ, and for phases/subphases
 * whose dependency links differ. Used by the undo/redo subsystem to persist
 * only what actually needs to change when restoring a snapshot (a link
 * created after the snapshot is removed on the server too, instead of
 * reappearing on the next refetch).
 */
import type { Project, Phase, Subphase, Dependency } from '@/types';
import type { PendingUpdate } from './autoCalculation';

/** Order-sensitive comparison; a missing list equals an empty one. */
function sameDependencies(a: Dependency[] | undefined, b: Dependency[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** The update for a phase/subphase whose dates and/or links changed, or null. */
function scheduleItemUpdate(
  type: 'phase' | 'subphase',
  prev: Phase | Subphase,
  next: Phase | Subphase,
): PendingUpdate | null {
  const datesChanged = prev.start_date !== next.start_date || prev.end_date !== next.end_date;
  const depsChanged = !sameDependencies(prev.dependencies, next.dependencies);
  if (!datesChanged && !depsChanged) return null;
  return {
    type,
    id: next.id,
    start_date: next.start_date,
    end_date: next.end_date,
    ...(depsChanged ? { dependencies: next.dependencies ?? [] } : {}),
  };
}

function diffSubphases(
  oldList: Subphase[],
  newList: Subphase[],
  updates: PendingUpdate[],
): void {
  const oldMap = new Map(oldList.map((s) => [s.id, s]));
  for (const next of newList) {
    const prev = oldMap.get(next.id);
    const update = prev ? scheduleItemUpdate('subphase', prev, next) : null;
    if (update) updates.push(update);
    if (next.children?.length || prev?.children?.length) {
      diffSubphases(prev?.children ?? [], next.children ?? [], updates);
    }
  }
}

function diffPhases(oldList: Phase[], newList: Phase[], updates: PendingUpdate[]): void {
  const oldMap = new Map(oldList.map((p) => [p.id, p]));
  for (const next of newList) {
    const prev = oldMap.get(next.id);
    const update = prev ? scheduleItemUpdate('phase', prev, next) : null;
    if (update) updates.push(update);
    diffSubphases(prev?.children ?? [], next.children ?? [], updates);
  }
}

export function diffProjects(oldProjects: Project[], newProjects: Project[]): PendingUpdate[] {
  const updates: PendingUpdate[] = [];
  const oldMap = new Map(oldProjects.map((p) => [p.id, p]));

  for (const next of newProjects) {
    const prev = oldMap.get(next.id);
    if (!prev) continue;

    if (
      (prev.start_date ?? '') !== (next.start_date ?? '') ||
      (prev.end_date ?? '') !== (next.end_date ?? '')
    ) {
      updates.push({
        type: 'project',
        id: next.id,
        start_date: next.start_date ?? '',
        end_date: next.end_date ?? '',
        name: next.name,
        pm_id: next.pm_id,
        customer: next.customer,
        sales_pm: next.sales_pm,
        volume: next.volume,
        confirmed: next.confirmed,
      });
    }

    diffPhases(prev.phases ?? [], next.phases ?? [], updates);

    // Project-level rows only (the only staff rows with dates of their own);
    // a pending row is a request awaiting approval, never re-PUT by undo.
    const oldStaff = new Map((prev.staffAssignments ?? []).map((a) => [a.id, a]));
    for (const a of next.staffAssignments ?? []) {
      if (a.approval_status === 'pending') continue;
      const o = oldStaff.get(a.id);
      if (o && (o.start_date !== a.start_date || o.end_date !== a.end_date)) {
        updates.push({
          type: 'staffAssignment',
          id: a.id,
          level: 'project',
          start_date: a.start_date,
          end_date: a.end_date,
          allocation: a.allocation,
        });
      }
    }

    const oldEquip = new Map((prev.equipmentAssignments ?? []).map((a) => [a.id, a]));
    for (const a of next.equipmentAssignments ?? []) {
      const o = oldEquip.get(a.id);
      if (o && (o.start_date !== a.start_date || o.end_date !== a.end_date)) {
        updates.push({
          type: 'equipmentAssignment',
          id: a.id,
          start_date: a.start_date,
          end_date: a.end_date,
        });
      }
    }
  }

  return updates;
}
