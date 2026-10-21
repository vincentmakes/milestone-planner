/**
 * Permission hooks over the signed-in user (appStore.currentUser).
 *
 * - `useHasPermission(key)` — one key, a primitive selector (safe under
 *   Zustand 5, re-renders only when the answer changes).
 * - `useNeedsApproval(key)` — whether an own-booking key is in approval mode.
 * - `useCan()` — a checker for components that test several keys or need the
 *   project-manager bundle on a project; stable until the user changes.
 *
 * The rules themselves live in utils/permissions.ts.
 */

import { useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { can, needsApproval } from '@/utils/permissions';
import type { ProjectLike } from '@/utils/permissions';
import type { ApprovableKey, PermissionKey } from '@/types/permissions';

export function useHasPermission(key: PermissionKey): boolean {
  return useAppStore((s) => can(s.currentUser, key));
}

export function useNeedsApproval(key: ApprovableKey): boolean {
  return useAppStore((s) => needsApproval(s.currentUser, key));
}

export type CanCheck = (key: PermissionKey, project?: ProjectLike | null) => boolean;

export function useCan(): CanCheck {
  const currentUser = useAppStore((s) => s.currentUser);
  return useCallback<CanCheck>((key, project) => can(currentUser, key, project), [currentUser]);
}
