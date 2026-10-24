/** Pure sharing helpers of the Dashboards view (2.1.0). */

import type { DashboardSummary } from '@/types';

/** A `shared` dashboard whose every target is gone (its owner and admins see it). */
export function sharedWithNoOne(dashboard: Pick<DashboardSummary, 'visibility' | 'shared_with'>): boolean {
  const s = dashboard.shared_with;
  return (
    dashboard.visibility === 'shared' &&
    s.roles.length + s.sites.length + s.teams.length + s.users.length === 0
  );
}
