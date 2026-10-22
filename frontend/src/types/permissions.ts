/**
 * Permission keys the client gates on.
 *
 * The catalogue is server-owned (app/services/permissions.py, served by
 * GET /api/permissions); this list mirrors its keys one to one and
 * src/utils/__tests__/permissions.catalogue.test.ts fails on drift against
 * shared/permission-keys.json, which a backend test regenerates.
 *
 * The signed-in user's role arrives resolved from /auth/me: `permissions`
 * holds the keys allowed outright (the admin role: every key) and
 * `approval_required` the own-booking keys in approval mode.
 */

export const PERMISSION_KEYS = [
  'absence_types.manage',
  'absences.manage_others',
  'absences.manage_own',
  'absences.view_others',
  'approvals.view_all',
  'assignments.manage_others',
  'assignments.self_create',
  'assignments.self_remove',
  'assignments.self_update',
  'bank_holidays.manage',
  'company_events.manage',
  'custom_columns.manage',
  'custom_columns.set_values',
  'equipment.manage',
  'equipment_blocks.manage',
  'equipment_bookings.manage',
  'equipment_types.manage',
  'kanban.comment',
  'kanban.moderate_comments',
  'kanban.move_any',
  'kanban.move_assigned',
  'predefined_phases.manage',
  'projects.archive',
  'projects.create',
  'projects.delete',
  'projects.edit_any',
  'projects.export',
  'projects.import',
  'projects.manage_as_pm',
  'projects.view',
  'roles.manage',
  'settings.general',
  'settings.sso',
  'sites.export',
  'sites.manage',
  'sites.view_all',
  'skills.assign',
  'skills.manage',
  'staff_notes.manage',
  'system.api_docs',
  'system.ws_debug',
  'tags.manage',
  'teams.manage',
  'todos.assign_others',
  'todos.manage_own',
  'users.change_role',
  'users.create',
  'users.delete',
  'users.edit',
  'users.edit_admins',
  'users.edit_credentials',
  'users.toggle_active',
  'users.view',
  'views.archived',
  'views.crosssite',
  'views.equipment',
  'views.kanban',
  'views.staff',
  'whatif.use',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/** Own-booking keys that a role may hold in approval mode. */
export const APPROVABLE_KEYS = [
  'assignments.self_create',
  'assignments.self_remove',
  'assignments.self_update',
] as const satisfies readonly PermissionKey[];

export type ApprovableKey = (typeof APPROVABLE_KEYS)[number];

/**
 * Keys a role holding `projects.manage_as_pm` gets on the projects it manages
 * (`project.pm_id === user.id`). Never delete, create, import or export.
 */
export const PM_BUNDLE: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  'assignments.manage_others',
  'custom_columns.set_values',
  'equipment_bookings.manage',
  'kanban.move_any',
  'projects.archive',
  'projects.edit_any',
  'todos.assign_others',
]);

/**
 * Keys an instance switch can take away from everyone, admins included
 * (mirror of DISABLEABLE_KEYS in app/services/permissions.py): `views.kanban`
 * while the Kanban board is turned off. /auth/me then omits them, though the
 * roles' matrices still hold them.
 */
export const DISABLEABLE_KEYS: readonly PermissionKey[] = ['views.kanban'];

/**
 * The key of the one administrator role, which always holds every permission.
 * Compare a *target* user's role with it (e.g. "is this account an admin?");
 * never gate the signed-in user on it — read their permissions instead.
 */
export const ADMIN_ROLE_KEY = 'admin';
