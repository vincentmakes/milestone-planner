/**
 * Site closures
 *
 * A company event flagged `counts_as_unavailable` closes its sites: every
 * staff member on one of those sites is unavailable for the event's dates,
 * the same way an unavailable absence zeroes their capacity. Closures are
 * shown with the event's name and colour, not as absences.
 *
 * An event may be restricted to teams (`team_ids`, flat across its sites). It
 * then applies to a person iff S = event sites ∩ person's sites is non-empty
 * and either none of its teams is at a site of S (whole-site closure there) or
 * the person belongs to one of those teams.
 *
 * `buildClosureIndex` expands the flagged events into a per-day index once
 * (in the store, when the events load); `getClosureOn` answers the per-cell
 * question against it.
 */

import type { CompanyEvent } from '@/types';
import { formatDateISO } from './date';

/** Day → closing events on that day (only events flagged as closures) */
export type ClosureIndex = ReadonlyMap<string, CompanyEvent[]>;

export const EMPTY_CLOSURE_INDEX: ClosureIndex = new Map();

/** Sites an event is linked to (older servers only send site_id) */
export function closureSiteIds(event: CompanyEvent): number[] {
  return event.site_ids && event.site_ids.length > 0 ? event.site_ids : [event.site_id];
}

/** Teams an event is restricted to (empty = everyone on its sites) */
export function closureTeamIds(event: CompanyEvent): number[] {
  return event.team_ids ?? [];
}

const EMPTY_TEAM_SET: ReadonlySet<number> = new Set();
const EMPTY_TEAM_SITE_MAP: ReadonlyMap<number, number> = new Map();

/**
 * Index the closure events by day, expanding date ranges. Dates are parsed as
 * local dates (not UTC) so a `YYYY-MM-DD` string stays the same day.
 */
export function buildClosureIndex(events: readonly CompanyEvent[]): Map<string, CompanyEvent[]> {
  const index = new Map<string, CompanyEvent[]>();

  for (const event of events) {
    if (!event.counts_as_unavailable) continue;

    const startStr = event.date.slice(0, 10);
    const endStr = (event.end_date || event.date).slice(0, 10);
    const [sy, sm, sd] = startStr.split('-').map(Number);
    const [ey, em, ed] = endStr.split('-').map(Number);
    const end = new Date(ey, em - 1, ed);

    const current = new Date(sy, sm - 1, sd);
    while (current <= end) {
      const key = formatDateISO(current);
      const list = index.get(key);
      if (list) {
        list.push(event);
      } else {
        index.set(key, [event]);
      }
      current.setDate(current.getDate() + 1);
    }
  }

  return index;
}

/**
 * The closure affecting a person on one day, or null. A person is affected
 * when one of their sites is among the event's sites, and — for an event
 * restricted to teams at those shared sites — they belong to one of them.
 *
 * `staffTeamIds` are the person's teams (all sites); `teamSiteById` maps a
 * team id to its site. A team the map does not know cannot be placed on a
 * site and is ignored, so with the defaults (no team data) a caller treats a
 * team-restricted closure as a whole-site closure.
 */
export function getClosureOn(
  staffSiteIds: ReadonlySet<number>,
  dateStr: string,
  index: ClosureIndex,
  staffTeamIds: ReadonlySet<number> = EMPTY_TEAM_SET,
  teamSiteById: ReadonlyMap<number, number> = EMPTY_TEAM_SITE_MAP
): CompanyEvent | null {
  if (index.size === 0 || staffSiteIds.size === 0) return null;
  const events = index.get(dateStr.slice(0, 10));
  if (!events) return null;

  for (const event of events) {
    const shared = closureSiteIds(event).filter((siteId) => staffSiteIds.has(siteId));
    if (shared.length === 0) continue;
    const restricted = closureTeamIds(event).filter((teamId) => {
      const siteId = teamSiteById.get(teamId);
      return siteId !== undefined && shared.includes(siteId);
    });
    if (restricted.length === 0 || restricted.some((teamId) => staffTeamIds.has(teamId))) {
      return event;
    }
  }
  return null;
}
