/**
 * useRoles - the tenant's roles (appStore.roles), loaded on first use.
 *
 * Roles are configuration that only a few screens read (Settings → Roles,
 * the Users panel's role pickers, the SSO default role), so they are not
 * part of the initial data load: the first component that asks fetches them
 * once (concurrent mounts share the request), and the `roles` WebSocket
 * slice keeps them current afterwards. A failed fetch leaves the list empty
 * (callers fall back to what they have) and is retried on the next mount.
 *
 * Returns the stored array itself, so it is stable between renders.
 */

import { useEffect } from 'react';
import { rolesApi } from '@/api/endpoints/roles';
import { clearMentionableUsersCache } from '@/api/endpoints/mentionableCache';
import { useAppStore } from '@/stores/appStore';
import type { Role } from '@/types';

let inFlight: Promise<void> | null = null;

function loadOnce(): Promise<void> {
  if (!inFlight) {
    inFlight = rolesApi
      .getAll()
      .catch((err) => {
        console.error('[useRoles] Failed to load roles', err);
        return [] as Role[];
      })
      .then((roles) => {
        // Only fill an empty store: a refresh may have landed meanwhile.
        if (useAppStore.getState().roles.length === 0) useAppStore.getState().setRoles(roles);
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export function useRoles(): Role[] {
  const roles = useAppStore((s) => s.roles);
  const loaded = roles.length > 0;
  useEffect(() => {
    if (!loaded) void loadOnce();
  }, [loaded]);
  return roles;
}

/** Refetch the roles into the store (after a role or user write). Throws on failure. */
export async function refreshRoles(): Promise<void> {
  // A role edit can change who sees every site, so who can be @-mentioned
  // (the broadcast excludes this user, so the WS refresh never clears it here).
  clearMentionableUsersCache();
  useAppStore.getState().setRoles(await rolesApi.getAll());
}
