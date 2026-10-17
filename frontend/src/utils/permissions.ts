/**
 * Per-project permission checks.
 *
 * Mirrors app/services/project_access.py on the backend: a project's manager
 * (project.pm_id === user.id) can do everything a superuser can on that one
 * project except delete it, and anyone may create, change or remove staff
 * assignments that book their own time.
 *
 * Every per-project gate in the frontend goes through these helpers. Global
 * gates (new project, import, settings, custom-column definitions) stay
 * role-based and read the user's role directly.
 *
 * All helpers are null-safe: a missing user or project means "no".
 */

import type { Project, User } from '@/types';

/** The parts of a project a permission check needs. */
export type ProjectLike = Pick<Project, 'pm_id'>;

/** The parts of a user a permission check needs. */
export type UserLike = Pick<User, 'id' | 'role'>;

/** Admins and superusers: every per-project rule starts with them. */
export function isPrivileged(user: UserLike | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'superuser';
}

/** Whether `staffId` is the user's own id. */
export function isSelf(user: UserLike | null | undefined, staffId: number | null | undefined): boolean {
  return Boolean(user) && staffId !== null && staffId !== undefined && user!.id === staffId;
}

/**
 * Whether the user may edit the project itself and everything inside it
 * (phases, subphases, dates, dependencies, completion, assignments, kanban).
 * Deleting the project is NOT covered: that stays with `isPrivileged`.
 */
export function canEditProject(
  user: UserLike | null | undefined,
  project: ProjectLike | null | undefined
): boolean {
  if (!user) return false;
  if (isPrivileged(user)) return true;
  if (!project) return false;
  return project.pm_id !== null && project.pm_id !== undefined && project.pm_id === user.id;
}

/**
 * Same as `canEditProject`, for callers that only hold a project id.
 */
export function canEditProjectById(
  user: UserLike | null | undefined,
  projects: readonly (ProjectLike & { id: number })[],
  projectId: number | null | undefined
): boolean {
  if (!user) return false;
  if (isPrivileged(user)) return true;
  if (projectId === null || projectId === undefined) return false;
  return canEditProject(user, projects.find((p) => p.id === projectId));
}

/**
 * Whether the user may create, change or remove a staff assignment on the
 * project: project editors may touch anyone's, everyone may touch their own.
 */
export function canEditAssignment(
  user: UserLike | null | undefined,
  project: ProjectLike | null | undefined,
  staffId: number | null | undefined
): boolean {
  return canEditProject(user, project) || isSelf(user, staffId);
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
  if (!user) return false;
  if (isPrivileged(user)) return true;
  return (projects ?? []).some((p) => canEditProject(user, p));
}
