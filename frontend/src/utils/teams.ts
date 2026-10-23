/**
 * Team helpers: site scoping, the header team filter and the per-entity
 * team predicates.
 *
 * Pure functions, no store access. A team belongs to one site. The header
 * filter is a {@link TeamFilter}; `null` means "Whole site" (no filter).
 *
 * - Project and staff rows carry `team_ids` already restricted to their site
 *   (the project's site; one staff row per user-site pair).
 * - Equipment, tag and company-event `team_ids` are flat across sites:
 *   restrict them to the current site's teams first ({@link teamIdsOnSite});
 *   an empty result means the whole site.
 * - A project or staff row matches when its team ids intersect
 *   `filter.teamIds`, or when `filter.noTeam` is set and it has no team.
 * - Equipment, a company event or a tag matches when it is open to the whole
 *   site here or one of its teams here is in `filter.teamIds`
 *   ({@link siteScopedTeamsMatchFilter}; `noTeam` is irrelevant for them).
 *   `siteTeams` is every team of the site, inactive ones included: an entity
 *   limited solely to an inactive team is not open to the whole site.
 * - A team-restricted tag applies to a project at site S iff the tag's team
 *   ids at S are empty or intersect the project's team ids
 *   (`tagsForProjectScope` in ./tags.ts).
 * - A team-restricted closure applies to a person iff S = event sites ∩
 *   person's sites is non-empty and (T = event team ids whose site ∈ S is
 *   empty, or T ∩ person's team ids is non-empty) (`getClosureOn` in
 *   ./siteClosure.ts).
 *
 * Every helper reads `x.team_ids ?? []` (older servers omit the field).
 */

import type { CompanyEvent, Equipment, Project, Staff, Tag, Team } from '@/types';

/** Header team filter for one site; `null` (no entry) = "Whole site". */
export interface TeamFilter {
  teamIds: number[];
  /** Also show what belongs to no team. */
  noTeam: boolean;
}

// =============================================================================
// SITE SCOPING
// =============================================================================

/** Teams of `siteId` (none without a site), optionally only the active ones. */
export function teamsForSite(
  teams: Team[],
  siteId: number | null | undefined,
  opts: { activeOnly?: boolean } = {}
): Team[] {
  if (siteId == null) return [];
  return teams.filter((t) => t.site_id === siteId && (!opts.activeOnly || t.active));
}

/** The ids of `teamIds` that belong to one of `siteTeams`. */
export function teamIdsOnSite(
  teamIds: readonly number[] | undefined,
  siteTeams: readonly Team[]
): number[] {
  const onSite = new Set(siteTeams.map((t) => t.id));
  return (teamIds ?? []).filter((id) => onSite.has(id));
}

/**
 * `all` with its `siteTeams` subset replaced by `next`: ids of other sites'
 * teams are kept, the result is deduped. For editing one site's teams of a
 * flat (cross-site) list.
 */
export function replaceSiteTeamIds(
  all: readonly number[],
  siteTeams: readonly Team[],
  next: readonly number[]
): number[] {
  const onSite = new Set(siteTeams.map((t) => t.id));
  return [...new Set([...all.filter((id) => !onSite.has(id)), ...next])];
}

/** `teamIds` without the ids whose team is unknown or not at one of `siteIds`. */
export function teamIdsWithinSites(
  teamIds: readonly number[],
  teams: readonly Team[],
  siteIds: readonly number[]
): number[] {
  const siteById = new Map(teams.map((t) => [t.id, t.site_id]));
  return teamIds.filter((id) => {
    const siteId = siteById.get(id);
    return siteId !== undefined && siteIds.includes(siteId);
  });
}

// =============================================================================
// HEADER FILTER
// =============================================================================

/**
 * The stored filter with ids that are not among `siteTeams` pruned (and
 * deduped); `null` (Whole site) when no team is left and `noTeam` is off.
 */
export function normalizeTeamFilter(
  stored: TeamFilter | null | undefined,
  siteTeams: readonly Team[]
): TeamFilter | null {
  if (!stored) return null;
  const teamIds = [...new Set(teamIdsOnSite(stored.teamIds, siteTeams))];
  const noTeam = stored.noTeam === true;
  if (teamIds.length === 0 && !noTeam) return null;
  return { teamIds, noTeam };
}

/**
 * Short label of a filter for the header: 'Whole site', '<Team>', 'No team',
 * 'N teams', '<Team> + no team' or 'N teams + no team'. Ids that are not
 * among `siteTeams` are ignored.
 */
export function teamFilterLabel(filter: TeamFilter | null, siteTeams: readonly Team[]): string {
  const normalized = normalizeTeamFilter(filter, siteTeams);
  if (!normalized) return 'Whole site';
  const { teamIds, noTeam } = normalized;
  if (teamIds.length === 0) return 'No team';
  const teams =
    teamIds.length === 1
      ? // normalizeTeamFilter kept only ids of siteTeams, so the find always hits.
        siteTeams.find((t) => t.id === teamIds[0])!.name
      : `${teamIds.length} teams`;
  return noTeam ? `${teams} + no team` : teams;
}

// =============================================================================
// PREDICATES
// =============================================================================

function matchesSiteScopedTeams(teamIds: readonly number[], filter: TeamFilter): boolean {
  if (teamIds.length === 0) return filter.noTeam;
  return teamIds.some((id) => filter.teamIds.includes(id));
}

/** Does the project pass the header team filter? `null` passes everything. */
export function projectMatchesTeamFilter(
  project: Pick<Project, 'team_ids'>,
  filter: TeamFilter | null
): boolean {
  return filter === null || matchesSiteScopedTeams(project.team_ids ?? [], filter);
}

/** Does the staff row (its teams on the row's site) pass the filter? */
export function staffMatchesTeamFilter(
  row: Pick<Staff, 'team_ids'>,
  filter: TeamFilter | null
): boolean {
  return filter === null || matchesSiteScopedTeams(row.team_ids ?? [], filter);
}

/**
 * Do flat (cross-site) `teamIds` pass the filter at the site of `siteTeams`?
 * No team at this site means open to the whole site, which always passes.
 */
export function siteScopedTeamsMatchFilter(
  teamIds: readonly number[] | undefined,
  filter: TeamFilter | null,
  siteTeams: readonly Team[]
): boolean {
  if (filter === null) return true;
  const here = teamIdsOnSite(teamIds, siteTeams);
  return here.length === 0 || here.some((id) => filter.teamIds.includes(id));
}

/**
 * Does the equipment pass the filter at the site of `siteTeams`? Equipment
 * with no team at this site is open to the whole site and always passes.
 */
export function equipmentMatchesTeamFilter(
  equipment: Pick<Equipment, 'team_ids'>,
  filter: TeamFilter | null,
  siteTeams: readonly Team[]
): boolean {
  return siteScopedTeamsMatchFilter(equipment.team_ids, filter, siteTeams);
}

/**
 * Does the company event pass the filter at the site of `siteTeams`? An event
 * with no team at this site concerns the whole site and always passes.
 */
export function eventMatchesTeamFilter(
  event: Pick<CompanyEvent, 'team_ids'>,
  filter: TeamFilter | null,
  siteTeams: readonly Team[]
): boolean {
  return siteScopedTeamsMatchFilter(event.team_ids, filter, siteTeams);
}

/**
 * Is the tag offered under the filter at the site of `siteTeams`? A tag with
 * no team at this site is open to the whole site and always passes.
 */
export function tagMatchesTeamFilter(
  tag: Pick<Tag, 'team_ids'>,
  filter: TeamFilter | null,
  siteTeams: readonly Team[]
): boolean {
  return siteScopedTeamsMatchFilter(tag.team_ids, filter, siteTeams);
}
