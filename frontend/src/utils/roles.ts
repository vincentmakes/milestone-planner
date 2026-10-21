/**
 * Role helpers for the Settings role screens and the role pickers.
 *
 * - `roleWithin` mirrors the escalation guard of the users API
 *   (app/services/user_access.py `role_within`): a role may be given by
 *   someone who holds each of its permissions at least as strongly.
 * - `roleKeyFromName` derives the immutable key of a new role
 *   (`^[a-z][a-z0-9_]{1,19}$`, unique among the existing keys).
 * - `matrixEquals` compares two permission matrices for dirty checks.
 * - `confirmRoleDelete` is the one wording of the delete confirmation (the
 *   role list and the role form both offer Delete).
 */

import type { PermissionMatrix, Role } from '@/types';
import { ADMIN_ROLE_KEY } from '@/types/permissions';
import { confirmAction } from './confirmDialog';
import { can } from './permissions';
import type { UserLike } from './permissions';

const MAX_KEY_LENGTH = 20;

/**
 * Whether `user` may give `role` to someone. An administrator (the only role
 * holding `roles.manage`) assigns any role; nobody else assigns the admin
 * role; otherwise every `allow` of the role must be held outright and every
 * `approval` in either mode.
 */
export function roleWithin(role: Pick<Role, 'key' | 'permissions'>, user: UserLike | null | undefined): boolean {
  if (!user) return false;
  if (can(user, 'roles.manage')) return true;
  if (role.key === ADMIN_ROLE_KEY) return false;
  const allowed = new Set(user.permissions ?? []);
  const approval = new Set(user.approval_required ?? []);
  return Object.entries(role.permissions).every(([key, mode]) =>
    mode === 'allow' ? allowed.has(key) : allowed.has(key) || approval.has(key)
  );
}

function trimUnderscores(value: string): string {
  return value.replace(/^_+|_+$/g, '');
}

/** The key a new role named `name` gets: slugged, never one of `takenKeys`. */
export function roleKeyFromName(name: string, takenKeys: readonly string[]): string {
  let base = trimUnderscores(
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
  );
  if (!base) base = 'role';
  if (!/^[a-z]/.test(base)) base = `role_${base}`;
  base = trimUnderscores(base.slice(0, MAX_KEY_LENGTH));
  if (base.length < 2) base = `${base}_role`;

  const taken = new Set(takenKeys);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const key = `${trimUnderscores(base.slice(0, MAX_KEY_LENGTH - suffix.length))}${suffix}`;
    if (!taken.has(key)) return key;
  }
}

/** Whether two matrices hold the same keys in the same modes. */
export function matrixEquals(a: PermissionMatrix, b: PermissionMatrix): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Ask before deleting `role` (callers take their submit guard afterwards). */
export function confirmRoleDelete(role: Pick<Role, 'name'>): Promise<boolean> {
  return confirmAction({
    title: 'Delete role',
    message: `Delete role "${role.name}"? Users holding it must be moved to another role first. This cannot be undone.`,
    confirmLabel: 'Delete',
    destructive: true,
  });
}
