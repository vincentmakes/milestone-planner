/**
 * Permission checks, the one place the frontend decides what a user may do.
 *
 * Mirrors app/services/permissions.py (`PermissionSet.can`): a key is held
 * when the signed-in user's role allows it (`user.permissions`, from
 * /auth/me — the admin role holds every key), or when it belongs to the
 * project-manager bundle and the user manages the project (`pm_id`) with
 * `projects.manage_as_pm`. Own bookings may also run in approval mode
 * (`user.approval_required`): the server then answers 202 and files a request,
 * so the client only mirrors the mode for labels.
 *
 * Never gate on the role key: roles are editable and custom roles exist.
 * The per-project wrappers below keep the shapes their call sites use.
 *
 * All helpers are null-safe: a missing user or project means "no".
 */

import type { Project, User } from '@/types';
import { PM_BUNDLE } from '@/types/permissions';
import type { ApprovableKey, PermissionKey } from '@/types/permissions';

/** The parts of a project a permission check needs. */
export type ProjectLike = Pick<Project, 'pm_id'>;

/** The parts of a user a permission check needs. */
export type UserLike = Pick<User, 'id'> & Partial<Pick<User, 'permissions' | 'approval_required'>>;

function holds(user: UserLike | null | undefined, key: PermissionKey): boolean {
  return Boolean(user?.permissions?.includes(key));
}

/**
 * Whether the user may do `key` — on `project` when given, which adds the
 * project-manager bundle on a project the user manages.
 */
export function can(
  user: UserLike | null | undefined,
  key: PermissionKey,
  project?: ProjectLike | null
): boolean {
  if (!user) return false;
  if (holds(user, key)) return true;
  return (
    PM_BUNDLE.has(key) &&
    project?.pm_id !== null &&
    project?.pm_id !== undefined &&
    project.pm_id === user.id &&
    holds(user, 'projects.manage_as_pm')
  );
}

/** Whether the user's role holds an own-booking key in approval mode. */
export function needsApproval(user: UserLike | null | undefined, key: ApprovableKey): boolean {
  return Boolean(user?.approval_required?.includes(key));
}

/**
 * Whether the user may book their own time this way at all: allowed outright,
 * or in approval mode (the server then files a request).
 */
export function canSelf(user: UserLike | null | undefined, key: ApprovableKey): boolean {
  return can(user, key) || needsApproval(user, key);
}

/** Whether `staffId` is the user's own id. */
export function isSelf(user: UserLike | null | undefined, staffId: number | null | undefined): boolean {
  return Boolean(user) && staffId !== null && staffId !== undefined && user!.id === staffId;
}

/**
 * Whether the user may edit the project itself and everything inside it
 * (phases, subphases, dates, dependencies, completion): `projects.edit_any`,
 * or managing the project. Deleting the project is NOT covered
 * (`projects.delete`, never in the manager bundle).
 */
export function canEditProject(
  user: UserLike | null | undefined,
  project: ProjectLike | null | undefined
): boolean {
  return can(user, 'projects.edit_any', project);
}

/**
 * Same as `canEditProject`, for callers that only hold a project id.
 */
export function canEditProjectById(
  user: UserLike | null | undefined,
  projects: readonly (ProjectLike & { id: number })[],
  projectId: number | null | undefined
): boolean {
  if (can(user, 'projects.edit_any')) return true;
  if (projectId === null || projectId === undefined) return false;
  return canEditProject(user, projects.find((p) => p.id === projectId));
}

/**
 * Whether the user may create, change or remove a staff assignment on the
 * project: whoever manages others' bookings there touches anyone's (and their
 * own, without approval); everyone else only their own, when their role
 * holds `selfKey` (allow or approval mode).
 */
export function canEditAssignment(
  user: UserLike | null | undefined,
  project: ProjectLike | null | undefined,
  staffId: number | null | undefined,
  selfKey: ApprovableKey = 'assignments.self_update'
): boolean {
  if (can(user, 'assignments.manage_others', project)) return true;
  return isSelf(user, staffId) && canSelf(user, selfKey);
}

/**
 * Whether the user may book equipment on the project and move, resize or
 * remove its equipment bookings: `equipment_bookings.manage`, or managing the
 * project (the key is in the manager bundle). Independent of
 * `projects.edit_any`.
 */
export function canBookEquipment(
  user: UserLike | null | undefined,
  project: ProjectLike | null | undefined
): boolean {
  return can(user, 'equipment_bookings.manage', project);
}

/** Same as `canBookEquipment`, for callers that only hold a project id. */
export function canBookEquipmentById(
  user: UserLike | null | undefined,
  projects: readonly (ProjectLike & { id: number })[],
  projectId: number | null | undefined
): boolean {
  if (can(user, 'equipment_bookings.manage')) return true;
  if (projectId === null || projectId === undefined) return false;
  return canBookEquipment(user, projects.find((p) => p.id === projectId));
}

/** Whether the user may book equipment on at least one of the projects. */
export function canBookEquipmentOnAny(
  user: UserLike | null | undefined,
  projects: readonly ProjectLike[] | null | undefined
): boolean {
  if (can(user, 'equipment_bookings.manage')) return true;
  return (projects ?? []).some((p) => canBookEquipment(user, p));
}

/**
 * Whether the user may add, edit or delete `staffId`'s absences: anyone's with
 * `absences.manage_others` (at the visible sites), their own with
 * `absences.manage_own`.
 */
export function canManageAbsencesOf(
  user: UserLike | null | undefined,
  staffId: number | null | undefined
): boolean {
  if (can(user, 'absences.manage_others')) return true;
  return isSelf(user, staffId) && can(user, 'absences.manage_own');
}

/**
 * Whether the user manages at least one of the given projects. Used for the
 * resource overview panels and resource dragging, which only make sense when
 * there is a project to drop onto.
 */
export function canManageAnyProject(
  user: UserLike | null | undefined,
  projects: readonly ProjectLike[] | null | undefined
): boolean {
  if (can(user, 'projects.edit_any')) return true;
  return (projects ?? []).some((p) => canEditProject(user, p));
}
