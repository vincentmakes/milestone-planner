/**
 * The current site's header team filter (viewStore.teamFilters), shared by
 * the TeamSelector and every view it narrows so they all agree.
 *
 * The filter's options are the site's active teams only: a stored id of a
 * team that was deleted, deactivated or belongs to another site is ignored
 * (never "exclude everything"), and pruned on the next write. A filter left
 * with no team and no "(No team)" is `null`, i.e. the whole site; so is any
 * stored filter on a site with no active team (the selector is hidden there,
 * so a leftover "(No team)" could never be cleared).
 *
 * Scoping, though, considers ALL teams of the site, active or not: equipment
 * restricted solely to an inactive team is not open to the whole site, so it
 * is hidden under any team filter (and shown under Whole site).
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
  /** Active teams of the current site (the filter's options). */
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
  const allSiteTeams = useMemo(() => teamsForSite(teams, siteId), [teams, siteId]);
  const filter = useMemo(
    () => (siteTeams.length === 0 ? null : normalizeTeamFilter(stored, siteTeams)),
    [stored, siteTeams]
  );

  const projectMatches = useCallback((p: Project) => projectMatchesTeamFilter(p, filter), [filter]);
  const staffMatches = useCallback((row: Staff) => staffMatchesTeamFilter(row, filter), [filter]);
  const equipmentMatches = useCallback(
    (e: Equipment) => equipmentMatchesTeamFilter(e, filter, allSiteTeams),
    [filter, allSiteTeams]
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
