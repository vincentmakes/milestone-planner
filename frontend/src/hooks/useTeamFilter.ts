/**
 * The current site's header team filter (viewStore.teamFilters), shared by
 * the TeamSelector and every view it narrows so they all agree.
 *
 * Only the site's active teams take part: a stored id of a team that was
 * deleted, deactivated or belongs to another site is ignored (never "exclude
 * everything"), and pruned on the next write. A filter left with no team and
 * no "(No team)" is `null`, i.e. the whole site.
 *
 * Filters are stored per tenant + site (`tagFilterKey`), like the tag filter.
 */

import { useCallback, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { tagFilterKey } from '@/utils/tags';
import {
  equipmentMatchesTeamFilter,
  normalizeTeamFilter,
  projectMatchesTeamFilter,
  staffMatchesTeamFilter,
  teamsForSite,
} from '@/utils/teams';
import type { TeamFilter } from '@/utils/teams';
import type { Equipment, Project, Staff, Team } from '@/types';

export interface SiteTeamFilter {
  siteId: number | null;
  /** Active teams of the current site. */
  siteTeams: Team[];
  /** Stored filter with stale ids pruned; `null` = whole site. */
  filter: TeamFilter | null;
  active: boolean;
  projectMatches: (p: Project) => boolean;
  staffMatches: (row: Staff) => boolean;
  equipmentMatches: (e: Equipment) => boolean;
}

export function useTeamFilter(): SiteTeamFilter {
  const siteId = useAppStore((s) => s.currentSite?.id ?? null);
  const teams = useAppStore((s) => s.teams);
  const stored = useViewStore((s) =>
    siteId === null ? undefined : s.teamFilters[tagFilterKey(siteId)]
  );

  const siteTeams = useMemo(() => teamsForSite(teams, siteId, { activeOnly: true }), [teams, siteId]);
  const filter = useMemo(() => normalizeTeamFilter(stored, siteTeams), [stored, siteTeams]);

  const projectMatches = useCallback((p: Project) => projectMatchesTeamFilter(p, filter), [filter]);
  const staffMatches = useCallback((row: Staff) => staffMatchesTeamFilter(row, filter), [filter]);
  const equipmentMatches = useCallback(
    (e: Equipment) => equipmentMatchesTeamFilter(e, filter, siteTeams),
    [filter, siteTeams]
  );

  return {
    siteId,
    siteTeams,
    filter,
    active: filter !== null,
    projectMatches,
    staffMatches,
    equipmentMatches,
  };
}

/** `projects` narrowed by the current site's team filter (same array when inactive). */
export function useTeamFilteredProjects(projects: Project[]): Project[] {
  const { filter, projectMatches } = useTeamFilter();
  return useMemo(
    () => (filter === null ? projects : projects.filter(projectMatches)),
    [projects, filter, projectMatches]
  );
}
