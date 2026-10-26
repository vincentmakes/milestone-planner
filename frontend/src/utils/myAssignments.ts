/**
 * My Assignments — the signed-in user's bookings, derived from the loaded
 * project tree (`appStore.projects`, every visible site's projects; no list
 * endpoint).
 *
 * One row per approved booking of the user at any level: the project's own
 * staff assignments, every phase's and every subphase's (recursively).
 * Pending bookings are left out (they are requests, listed under My
 * Requests), and so are archived projects. Card rows read their effective
 * days (`bookingSpan`: own dates when unlinked, the card's when linked);
 * project rows their own. A row is `upcoming` while it has not ended
 * (`end >= today`, local calendar day). Sorted by start, then project name,
 * then row id.
 */

import { bookingSpan } from './bookingSegments';
import { isPendingAssignment } from './kanbanCards';
import { toDateOnly } from './date';
import type { Phase, Project, StaffAssignment, StaffAssignmentLevel, Subphase } from '@/types';

export interface MyAssignment {
  /** Unique across levels (row ids are unique per level only): `<level>:<id>` */
  key: string;
  level: StaffAssignmentLevel;
  /** The row, with `project_id` / `phase_id` / `subphase_id` filled from where it was found */
  assignment: StaffAssignment;
  project: Project;
  /** The phase or subphase it books; null for a project-level booking */
  card: Phase | Subphase | null;
  /** YYYY-MM-DD, effective */
  start: string;
  /** YYYY-MM-DD, effective */
  end: string;
  /** A card booking that follows its card's dates (project rows: false) */
  linked: boolean;
  /** Not ended yet: end on or after today */
  upcoming: boolean;
}

function isMine(row: StaffAssignment, userId: number): boolean {
  return row.staff_id === userId && !isPendingAssignment(row);
}

/**
 * Every approved booking of `userId` in the non-archived `projects`.
 * `today` is a local YYYY-MM-DD (`formatDateISO(new Date())`).
 */
export function collectMyAssignments(
  projects: readonly Project[],
  userId: number,
  today: string
): MyAssignment[] {
  const rows: MyAssignment[] = [];

  const push = (
    level: StaffAssignmentLevel,
    assignment: StaffAssignment,
    project: Project,
    card: Phase | Subphase | null,
    start: string,
    end: string
  ) => {
    rows.push({
      key: `${level}:${assignment.id}`,
      level,
      assignment,
      project,
      card,
      start,
      end,
      linked: card !== null && assignment.linked !== false,
      upcoming: end >= today,
    });
  };

  const visitSubphases = (project: Project, phaseId: number, subphases: readonly Subphase[]) => {
    for (const sub of subphases) {
      for (const row of sub.staffAssignments ?? []) {
        if (!isMine(row, userId)) continue;
        const span = bookingSpan(row, sub);
        push(
          'subphase',
          { ...row, project_id: project.id, phase_id: phaseId, subphase_id: sub.id },
          project,
          sub,
          span.start,
          span.end
        );
      }
      visitSubphases(project, phaseId, sub.children ?? []);
    }
  };

  for (const project of projects) {
    if (project.archived) continue;
    for (const row of project.staffAssignments ?? []) {
      if (!isMine(row, userId)) continue;
      push(
        'project',
        { ...row, project_id: project.id, phase_id: null, subphase_id: null },
        project,
        null,
        toDateOnly(row.start_date),
        toDateOnly(row.end_date)
      );
    }
    for (const phase of project.phases ?? []) {
      for (const row of phase.staffAssignments ?? []) {
        if (!isMine(row, userId)) continue;
        const span = bookingSpan(row, phase);
        push(
          'phase',
          { ...row, project_id: project.id, phase_id: phase.id, subphase_id: null },
          project,
          phase,
          span.start,
          span.end
        );
      }
      visitSubphases(project, phase.id, phase.children ?? []);
    }
  }

  return rows.sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      a.project.name.localeCompare(b.project.name) ||
      a.assignment.id - b.assignment.id
  );
}
