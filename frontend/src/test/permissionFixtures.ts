/**
 * The shipped default permissions of the system roles, mirroring the
 * `defaults` column of app/services/permissions.py (admin = every key).
 *
 * `makeUser` derives `permissions` from `role` with these, so a fixture that
 * says `role: 'user'` or `role: 'superuser'` behaves like a fresh tenant's
 * role of that name. Pass `permissions` explicitly to test a custom matrix.
 */
import { PERMISSION_KEYS } from '@/types/permissions';
import type { PermissionKey } from '@/types/permissions';

export const ALL_PERMISSIONS: readonly PermissionKey[] = PERMISSION_KEYS;

export const USER_DEFAULTS: readonly PermissionKey[] = [
  'absences.manage_own',
  'absences.view_others',
  'assignments.self_create',
  'assignments.self_remove',
  'assignments.self_update',
  'custom_columns.set_values',
  'kanban.comment',
  'kanban.move_assigned',
  'projects.manage_as_pm',
  'projects.view',
  'todos.manage_own',
  'views.archived',
  'views.crosssite',
  'views.equipment',
  'views.kanban',
  'views.staff',
];

export const SUPERUSER_DEFAULTS: readonly PermissionKey[] = [
  ...USER_DEFAULTS,
  'absences.manage_others',
  'assignments.manage_others',
  'bank_holidays.manage',
  'company_events.manage',
  'equipment.manage',
  'equipment_blocks.manage',
  'equipment_bookings.manage',
  'equipment_types.manage',
  'kanban.moderate_comments',
  'kanban.move_any',
  'predefined_phases.manage',
  'projects.archive',
  'projects.create',
  'projects.delete',
  'projects.edit_any',
  'projects.export',
  'projects.import',
  'sites.export',
  'skills.assign',
  'skills.manage',
  'staff_notes.manage',
  'teams.manage',
  'todos.assign_others',
  'users.edit',
  'users.view',
  'whatif.use',
];

const ROLE_NAMES: Record<string, string> = { admin: 'Admin', superuser: 'Superuser', user: 'User' };

/** The default allow keys of a system role; an unknown (custom) role holds none. */
export function permissionsForRole(role: string): PermissionKey[] {
  if (role === 'admin') return [...ALL_PERMISSIONS];
  if (role === 'superuser') return [...SUPERUSER_DEFAULTS];
  if (role === 'user') return [...USER_DEFAULTS];
  return [];
}

/** The display name of a system role; a custom role key is shown as is. */
export function roleNameFor(role: string): string {
  return ROLE_NAMES[role] ?? role;
}

/**
 * `user` as /auth/me would return it: its role's default permissions (unless
 * it carries `permissions`), name and site visibility. For fixtures that are
 * also user-list rows (no permission fields) and become the signed-in user.
 */
export function asSignedIn<T extends { role: string; permissions?: string[] }>(
  user: T
): T & { role_name: string; permissions: string[]; approval_required: string[]; can_see_all_sites: boolean } {
  const permissions = user.permissions ?? permissionsForRole(user.role);
  return {
    ...user,
    role_name: roleNameFor(user.role),
    permissions,
    approval_required: [],
    can_see_all_sites: permissions.includes('sites.view_all'),
  };
}
