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
 * Scoping, though, considers ALL teams of the site, active or not: equipment,
 * a company event or a tag restricted solely to an inactive team is not open
 * to the whole site, so it is hidden under any team filter (and shown under
 * Whole site).
 *
 * The hook narrows projects, staff rows, equipment, company events and tags
 * (`*Matches` predicates); `useTeamFilteredProjects` and
 * `useTeamFilteredCompanyEvents` apply it to the project list and to the
 * store's company events and their date set.
 *
 * Filters are stored per tenant + site (`tagFilterKey`), like the tag filter.
 */

import { useCallback, useMemo } from 'react';
import { buildEventDateSet } from '@/api';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { tagFilterKey } from '@/utils/tags';
import {
  equipmentMatchesTeamFilter,
  eventMatchesTeamFilter,
  normalizeTeamFilter,
  projectMatchesTeamFilter,
  staffMatchesTeamFilter,
  tagMatchesTeamFilter,
  teamsForSite,
} from '@/utils/teams';
import type { TeamFilter } from '@/utils/teams';
import type { CompanyEvent, Equipment, Project, Staff, Tag, Team } from '@/types';

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
  eventMatches: (e: CompanyEvent) => boolean;
  tagMatches: (t: Tag) => boolean;
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
  const eventMatches = useCallback(
    (e: CompanyEvent) => eventMatchesTeamFilter(e, filter, allSiteTeams),
    [filter, allSiteTeams]
  );
  const tagMatches = useCallback(
    (t: Tag) => tagMatchesTeamFilter(t, filter, allSiteTeams),
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
    eventMatches,
    tagMatches,
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

/**
 * The store's company events and their date set narrowed by the current
 * site's team filter: the very same array and set while the filter is
 * inactive, otherwise the matching events and a date set rebuilt from them
 * (a team-limited event's days drop out of the timeline background).
 */
export function useTeamFilteredCompanyEvents(): { events: CompanyEvent[]; eventDates: Set<string> } {
  const companyEvents = useAppStore((s) => s.companyEvents);
  const companyEventDates = useAppStore((s) => s.companyEventDates);
  const { filter, eventMatches } = useTeamFilter();
  return useMemo(() => {
    if (filter === null) return { events: companyEvents, eventDates: companyEventDates };
    const events = companyEvents.filter(eventMatches);
    return { events, eventDates: buildEventDateSet(events) };
  }, [companyEvents, companyEventDates, filter, eventMatches]);
}
