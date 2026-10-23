/**
 * A company event flagged `counts_as_unavailable` closes its sites: staff on
 * one of them are off for the event's dates. The index expands the flagged
 * events per day; the lookup matches a person through any of their sites.
 */

import { describe, it, expect } from 'vitest';
import {
  buildClosureIndex,
  getClosureOn,
  closureSiteIds,
  closureTeamIds,
  EMPTY_CLOSURE_INDEX,
} from '../siteClosure';
import type { CompanyEvent } from '@/types';

const closure: CompanyEvent = {
  id: 1,
  site_id: 1,
  site_ids: [1, 2],
  date: '2026-03-02',
  end_date: '2026-03-04',
  name: 'Site shutdown',
  color: '#f97316',
  counts_as_unavailable: true,
};
const plainEvent: CompanyEvent = {
  id: 2,
  site_id: 1,
  site_ids: [1],
  date: '2026-03-03',
  name: 'ISO Audit',
  counts_as_unavailable: false,
};

describe('buildClosureIndex', () => {
  it('expands flagged events over their range and ignores plain events', () => {
    const index = buildClosureIndex([closure, plainEvent]);
    expect(Array.from(index.keys()).sort()).toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
    expect(index.get('2026-03-03')).toEqual([closure]);
  });

  it('handles single-day events and ISO timestamps', () => {
    const index = buildClosureIndex([
      { ...closure, id: 3, date: '2026-05-01T00:00:00.000Z', end_date: null },
    ]);
    expect(Array.from(index.keys())).toEqual(['2026-05-01']);
  });

  it('is empty without flagged events', () => {
    expect(buildClosureIndex([plainEvent]).size).toBe(0);
  });
});

describe('getClosureOn', () => {
  const index = buildClosureIndex([closure]);

  it('returns the event when one of the person’s sites is closed', () => {
    expect(getClosureOn(new Set([2, 9]), '2026-03-03', index)).toBe(closure);
  });

  it('returns null for a person on other sites', () => {
    expect(getClosureOn(new Set([3]), '2026-03-03', index)).toBeNull();
  });

  it('returns null outside the dates, with no sites, or with an empty index', () => {
    expect(getClosureOn(new Set([1]), '2026-03-05', index)).toBeNull();
    expect(getClosureOn(new Set(), '2026-03-03', index)).toBeNull();
    expect(getClosureOn(new Set([1]), '2026-03-03', EMPTY_CLOSURE_INDEX)).toBeNull();
  });

  it('accepts a timestamp for the day', () => {
    expect(getClosureOn(new Set([1]), '2026-03-02T08:00:00', index)).toBe(closure);
  });
});

describe('getClosureOn with team-restricted closures', () => {
  // Teams 5 (site 1) and 6 (site 2); team 7 is unknown.
  const teamSiteById = new Map([[5, 1], [6, 2]]);
  const teamClosure: CompanyEvent = { ...closure, id: 10, name: 'Lab 1 shutdown', team_ids: [5, 6] };
  const site1TeamClosure: CompanyEvent = { ...closure, id: 11, name: 'Team 5 offsite', team_ids: [5] };

  it('hits everyone on the site for a whole-site event', () => {
    const index = buildClosureIndex([closure]);
    expect(getClosureOn(new Set([1]), '2026-03-03', index, new Set(), teamSiteById)).toBe(closure);
    expect(getClosureOn(new Set([1]), '2026-03-03', index, new Set([5]), teamSiteById)).toBe(closure);
  });

  it('hits members of a restricted team only', () => {
    const index = buildClosureIndex([teamClosure]);
    expect(getClosureOn(new Set([1]), '2026-03-03', index, new Set([5]), teamSiteById)).toBe(teamClosure);
    expect(getClosureOn(new Set([2]), '2026-03-03', index, new Set([6]), teamSiteById)).toBe(teamClosure);
  });

  it('leaves a non-member on the same site unaffected', () => {
    const index = buildClosureIndex([teamClosure]);
    expect(getClosureOn(new Set([1]), '2026-03-03', index, new Set(), teamSiteById)).toBeNull();
    expect(getClosureOn(new Set([1]), '2026-03-03', index, new Set([6]), teamSiteById)).toBeNull();
  });

  it('ignores a team of a site the person does not share with the event', () => {
    const index = buildClosureIndex([site1TeamClosure]);
    // Site 2 has no restricted team, so the closure covers all of site 2.
    expect(getClosureOn(new Set([2]), '2026-03-03', index, new Set(), teamSiteById)).toBe(site1TeamClosure);
    // An unknown team id cannot be placed on a site and is ignored too.
    const unknown = buildClosureIndex([{ ...closure, id: 12, team_ids: [7] }]);
    expect(getClosureOn(new Set([1]), '2026-03-03', unknown, new Set(), teamSiteById)?.id).toBe(12);
  });

  it('keeps looking past a closure that does not apply', () => {
    const index = buildClosureIndex([site1TeamClosure, closure]);
    expect(getClosureOn(new Set([1]), '2026-03-03', index, new Set(), teamSiteById)).toBe(closure);
  });

  it('treats a team-restricted closure as whole-site without team data', () => {
    const index = buildClosureIndex([teamClosure]);
    expect(getClosureOn(new Set([1]), '2026-03-03', index)).toBe(teamClosure);
  });
});

describe('closureTeamIds', () => {
  it('reads team_ids, empty when absent', () => {
    expect(closureTeamIds({ ...closure, team_ids: [5] })).toEqual([5]);
    expect(closureTeamIds(closure)).toEqual([]);
  });
});

describe('closureSiteIds', () => {
  it('falls back to site_id when a server sends no site_ids', () => {
    expect(closureSiteIds({ ...closure, site_ids: undefined })).toEqual([1]);
    expect(closureSiteIds({ ...closure, site_ids: [] })).toEqual([1]);
    expect(closureSiteIds(closure)).toEqual([1, 2]);
  });
});
