/**
 * The sites the signed-in user may see: every site with `sites.view_all`
 * (`can_see_all_sites`), otherwise only their own (`site_ids`). The server
 * scopes every read to the same set; this is the client's view of it for the
 * site selector, the Cross-site view and the Settings site pickers.
 */

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { Site, User } from '@/types';

type VisibilityUser = Pick<User, 'site_ids' | 'can_see_all_sites'>;

/** Pure form, for code outside React (the data loader). Keeps `sites` order. */
export function visibleSitesFor(user: VisibilityUser | null | undefined, sites: readonly Site[]): Site[] {
  if (!user) return [];
  if (user.can_see_all_sites) return [...sites];
  const own = new Set(user.site_ids ?? []);
  return sites.filter((site) => own.has(site.id));
}

export function useVisibleSites(): Site[] {
  const sites = useAppStore((s) => s.sites);
  const hasUser = useAppStore((s) => s.currentUser !== null);
  const canSeeAll = useAppStore((s) => s.currentUser?.can_see_all_sites ?? false);
  const siteIds = useAppStore((s) => s.currentUser?.site_ids);
  return useMemo(
    () => (hasUser ? visibleSitesFor({ can_see_all_sites: canSeeAll, site_ids: siteIds ?? [] }, sites) : []),
    [hasUser, canSeeAll, siteIds, sites]
  );
}
