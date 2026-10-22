/**
 * Local (optimistic) edits of the project tree in appStore.
 *
 * Dialogs persist an edit and then reload projects from the server. During
 * What-If mode the write is only queued and loadAllProjects() is a no-op, so
 * without a local update the edit would stay invisible until Apply. These
 * helpers apply the same change to the store: they clone the one affected
 * project (never mutate store objects in place) and replace it, the way
 * useDragAndDrop does. Outside What-If the reload that follows simply
 * overwrites the local change with server truth.
 */

import { useAppStore } from '@/stores/appStore';
import { fitCardBookingRows } from './bookingSegments';
import type { EquipmentAssignment, Phase, Project, StaffAssignment, Subphase } from '@/types';

export type AssignmentLevel = 'project' | 'phase' | 'subphase';

/** Clone project `projectId`, let `mutate` change the clone, and store it. */
export function updateProjectLocally(projectId: number, mutate: (project: Project) => void): void {
  const { projects, setProjects } = useAppStore.getState();
  const index = projects.findIndex((p) => p.id === projectId);
  if (index < 0) return;
  const copy = structuredClone(projects[index]);
  mutate(copy);
  setProjects(projects.map((p, i) => (i === index ? copy : p)));
}

export function removeProjectLocally(projectId: number): void {
  const { projects, setProjects } = useAppStore.getState();
  if (!projects.some((p) => p.id === projectId)) return;
  setProjects(projects.filter((p) => p.id !== projectId));
}

/** Every subphase of a project, at any depth. */
function allSubphases(project: Project): Subphase[] {
  const out: Subphase[] = [];
  const walk = (list: Subphase[] | undefined) => {
    for (const sp of list ?? []) {
      out.push(sp);
      walk(sp.children);
    }
  };
  for (const phase of project.phases ?? []) walk(phase.children);
  return out;
}

/**
 * Apply a patch to a card; a date change also fits the card's bookings
 * (linked rows follow, unlinked segments are translated or clamped), as the
 * server does in the card PUT -- locally only, the server fits its own rows.
 */
function patchCard(card: Phase | Subphase, patch: Partial<Phase> | Partial<Subphase>): void {
  const oldStart = card.start_date;
  const oldEnd = card.end_date;
  Object.assign(card, patch);
  if (oldStart && oldEnd && card.start_date && card.end_date) fitCardBookingRows(card, oldStart, oldEnd);
}

export function patchPhaseLocally(projectId: number, phaseId: number, patch: Partial<Phase>): void {
  updateProjectLocally(projectId, (project) => {
    const phase = project.phases?.find((ph) => ph.id === phaseId);
    if (phase) patchCard(phase, patch);
  });
}

export function removePhaseLocally(projectId: number, phaseId: number): void {
  updateProjectLocally(projectId, (project) => {
    project.phases = (project.phases ?? []).filter((ph) => ph.id !== phaseId);
  });
}

export function patchSubphaseLocally(projectId: number, subphaseId: number, patch: Partial<Subphase>): void {
  updateProjectLocally(projectId, (project) => {
    const subphase = allSubphases(project).find((sp) => sp.id === subphaseId);
    if (subphase) patchCard(subphase, patch);
  });
}

export function removeSubphaseLocally(projectId: number, subphaseId: number): void {
  const prune = (list: Subphase[] | undefined): Subphase[] =>
    (list ?? [])
      .filter((sp) => sp.id !== subphaseId)
      .map((sp) => ({ ...sp, children: prune(sp.children) }));
  updateProjectLocally(projectId, (project) => {
    for (const phase of project.phases ?? []) phase.children = prune(phase.children);
  });
}

/**
 * The staff-assignment lists of one level. Ids are only unique per level
 * (three backend tables), so a lookup must never cross levels.
 */
function staffListsAt(project: Project, level: AssignmentLevel): StaffAssignment[][] {
  if (level === 'project') return [project.staffAssignments ?? []];
  if (level === 'phase') return (project.phases ?? []).map((ph) => ph.staffAssignments ?? []);
  return allSubphases(project).map((sp) => sp.staffAssignments ?? []);
}

/** The staff assignment `id` at `level` in the project (ids are unique per level only). */
export function findStaffAssignment(
  project: Project | null | undefined,
  level: AssignmentLevel,
  id: number
): StaffAssignment | undefined {
  if (!project) return undefined;
  for (const list of staffListsAt(project, level)) {
    const found = list.find((a) => a.id === id);
    if (found) return found;
  }
  return undefined;
}

export function patchStaffAssignmentLocally(
  projectId: number,
  assignmentId: number,
  level: AssignmentLevel,
  patch: Partial<StaffAssignment>
): void {
  updateProjectLocally(projectId, (project) => {
    for (const list of staffListsAt(project, level)) {
      const assignment = list.find((a) => a.id === assignmentId);
      if (assignment) Object.assign(assignment, patch);
    }
  });
}

export function removeStaffAssignmentLocally(projectId: number, assignmentId: number, level: AssignmentLevel): void {
  updateProjectLocally(projectId, (project) => {
    for (const list of staffListsAt(project, level)) {
      const index = list.findIndex((a) => a.id === assignmentId);
      if (index >= 0) list.splice(index, 1);
    }
  });
}

/** Equipment bookings live in one table, so their ids are unique tree-wide. */
function equipmentLists(project: Project): EquipmentAssignment[][] {
  return [
    project.equipmentAssignments ?? [],
    ...(project.phases ?? []).map((ph) => ph.equipmentAssignments ?? []),
    ...allSubphases(project).map((sp) => sp.equipmentAssignments ?? []),
  ];
}

export function patchEquipmentAssignmentLocally(
  projectId: number,
  assignmentId: number,
  patch: Partial<EquipmentAssignment>
): void {
  updateProjectLocally(projectId, (project) => {
    for (const list of equipmentLists(project)) {
      const assignment = list.find((a) => a.id === assignmentId);
      if (assignment) Object.assign(assignment, patch);
    }
  });
}

export function removeEquipmentAssignmentLocally(projectId: number, assignmentId: number): void {
  updateProjectLocally(projectId, (project) => {
    for (const list of equipmentLists(project)) {
      const index = list.findIndex((a) => a.id === assignmentId);
      if (index >= 0) list.splice(index, 1);
    }
  });
}
