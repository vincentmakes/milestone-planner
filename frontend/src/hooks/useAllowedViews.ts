/**
 * Which views the signed-in user may open.
 *
 * The Gantt is always available, and My Work to anyone signed in (everyone
 * has bookings and requests of their own). Every other view needs its `views.*` key:
 * without it the view is hidden (a permission gate hides). Cross-site is
 * also disabled, with the reason, while only one site is visible (a
 * situational gate disables and says why). The server enforces the same keys
 * on the views' reads.
 */

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { can } from '@/utils/permissions';
import { useVisibleSites } from './useVisibleSites';
import type { CurrentView } from '@/types';
import type { PermissionKey } from '@/types/permissions';

/** The key each view needs (null = always available), in navigation order. */
export const VIEW_PERMISSIONS: Readonly<Record<CurrentView, PermissionKey | null>> = {
  gantt: null,
  kanban: 'views.kanban',
  work: null,
  staff: 'views.staff',
  equipment: 'views.equipment',
  crosssite: 'views.crosssite',
  archived: 'views.archived',
};

export const CROSS_SITE_DISABLED_REASON = 'Cross-site needs access to more than one site';

export interface AllowedViews {
  /** Views the navigation lists, in order */
  visible: readonly CurrentView[];
  /** Why a listed view cannot be opened right now */
  disabledReason: Partial<Record<CurrentView, string>>;
  /** Listed and not disabled */
  isAllowed: (view: CurrentView) => boolean;
}

export function useAllowedViews(): AllowedViews {
  const currentUser = useAppStore((s) => s.currentUser);
  const visibleSiteCount = useVisibleSites().length;

  return useMemo(() => {
    const visible = (Object.keys(VIEW_PERMISSIONS) as CurrentView[]).filter((view) => {
      const key = VIEW_PERMISSIONS[view];
      if (key === null) return view === 'gantt' || currentUser !== null;
      return can(currentUser, key);
    });
    const disabledReason: Partial<Record<CurrentView, string>> = {};
    if (visible.includes('crosssite') && visibleSiteCount <= 1) {
      disabledReason.crosssite = CROSS_SITE_DISABLED_REASON;
    }
    return {
      visible,
      disabledReason,
      isAllowed: (view: CurrentView) => visible.includes(view) && !disabledReason[view],
    };
  }, [currentUser, visibleSiteCount]);
}
