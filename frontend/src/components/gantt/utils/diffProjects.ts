/**
 * diffProjects
 *
 * Compares two project trees and produces a list of `PendingUpdate` entries
 * for items whose start_date / end_date differ. Used by the undo/redo
 * subsystem to persist only the dates that actually need to change when
 * restoring a snapshot.
 */
import type { Project, Phase, Subphase } from '@/types';
import type { PendingUpdate } from './autoCalculation';

function diffSubphases(
  oldList: Subphase[],
  newList: Subphase[],
  updates: PendingUpdate[],
): void {
  const oldMap = new Map(oldList.map((s) => [s.id, s]));
  for (const next of newList) {
    const prev = oldMap.get(next.id);
    if (prev && (prev.start_date !== next.start_date || prev.end_date !== next.end_date)) {
      updates.push({
        type: 'subphase',
        id: next.id,
        start_date: next.start_date,
        end_date: next.end_date,
      });
    }
    if (next.children?.length || prev?.children?.length) {
      diffSubphases(prev?.children ?? [], next.children ?? [], updates);
    }
  }
}

function diffPhases(oldList: Phase[], newList: Phase[], updates: PendingUpdate[]): void {
  const oldMap = new Map(oldList.map((p) => [p.id, p]));
  for (const next of newList) {
    const prev = oldMap.get(next.id);
    if (prev && (prev.start_date !== next.start_date || prev.end_date !== next.end_date)) {
      updates.push({
        type: 'phase',
        id: next.id,
        start_date: next.start_date,
        end_date: next.end_date,
      });
    }
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

    const oldStaff = new Map((prev.staffAssignments ?? []).map((a) => [a.id, a]));
    for (const a of next.staffAssignments ?? []) {
      const o = oldStaff.get(a.id);
      if (o && (o.start_date !== a.start_date || o.end_date !== a.end_date)) {
        updates.push({
          type: 'staffAssignment',
          id: a.id,
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
