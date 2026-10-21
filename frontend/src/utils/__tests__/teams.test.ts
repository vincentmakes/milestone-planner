import { describe, it, expect } from 'vitest';
import {
  teamsForSite,
  teamIdsOnSite,
  replaceSiteTeamIds,
  teamIdsWithinSites,
  normalizeTeamFilter,
  teamFilterLabel,
  projectMatchesTeamFilter,
  staffMatchesTeamFilter,
  equipmentMatchesTeamFilter,
  eventMatchesTeamFilter,
  tagMatchesTeamFilter,
  siteScopedTeamsMatchFilter,
  type TeamFilter,
} from '../teams';
import { makeTeam } from '@/test/factories';

// Site 1: Analytics (1), Process (2), Archive (3, inactive). Site 2: Pilot plant (4).
const analytics = makeTeam({ id: 1, site_id: 1, name: 'Analytics' });
const processDev = makeTeam({ id: 2, site_id: 1, name: 'Process' });
const archive = makeTeam({ id: 3, site_id: 1, name: 'Archive', active: false });
const pilot = makeTeam({ id: 4, site_id: 2, name: 'Pilot plant' });
const allTeams = [analytics, processDev, archive, pilot];
const site1 = [analytics, processDev, archive];

const filter = (teamIds: number[], noTeam = false): TeamFilter => ({ teamIds, noTeam });

describe('teamsForSite', () => {
  it('keeps the teams of the site', () => {
    expect(teamsForSite(allTeams, 1)).toEqual([analytics, processDev, archive]);
    expect(teamsForSite(allTeams, 2)).toEqual([pilot]);
  });

  it('drops inactive teams when asked', () => {
    expect(teamsForSite(allTeams, 1, { activeOnly: true })).toEqual([analytics, processDev]);
  });

  it('returns nothing without a site', () => {
    expect(teamsForSite(allTeams, null)).toEqual([]);
    expect(teamsForSite(allTeams, undefined)).toEqual([]);
  });
});

describe('teamIdsOnSite', () => {
  it('keeps only the ids of the site teams', () => {
    expect(teamIdsOnSite([1, 4, 3], site1)).toEqual([1, 3]);
  });

  it('treats a missing list as empty', () => {
    expect(teamIdsOnSite(undefined, site1)).toEqual([]);
  });
});

describe('replaceSiteTeamIds', () => {
  it("swaps the site's subset and keeps other sites' ids", () => {
    expect(replaceSiteTeamIds([1, 4, 2], site1, [3])).toEqual([4, 3]);
  });

  it('dedupes', () => {
    expect(replaceSiteTeamIds([4, 4, 1], site1, [2, 2])).toEqual([4, 2]);
  });

  it('clears the site subset with an empty next', () => {
    expect(replaceSiteTeamIds([1, 4], site1, [])).toEqual([4]);
  });
});

describe('teamIdsWithinSites', () => {
  it('drops teams of other sites and unknown ids', () => {
    expect(teamIdsWithinSites([1, 4, 99], allTeams, [1])).toEqual([1]);
    expect(teamIdsWithinSites([1, 4, 99], allTeams, [1, 2])).toEqual([1, 4]);
    expect(teamIdsWithinSites([1, 4], allTeams, [])).toEqual([]);
  });
});

describe('normalizeTeamFilter', () => {
  it('prunes ids not on the site and dedupes', () => {
    expect(normalizeTeamFilter(filter([1, 4, 1, 99], true), site1)).toEqual(filter([1], true));
  });

  it('returns null when nothing is left', () => {
    expect(normalizeTeamFilter(filter([4]), site1)).toBeNull();
    expect(normalizeTeamFilter(filter([]), site1)).toBeNull();
    expect(normalizeTeamFilter(null, site1)).toBeNull();
    expect(normalizeTeamFilter(undefined, site1)).toBeNull();
  });

  it('keeps a noTeam-only filter', () => {
    expect(normalizeTeamFilter(filter([4], true), site1)).toEqual(filter([], true));
  });
});

describe('teamFilterLabel', () => {
  it.each([
    ['whole site', null, 'Whole site'],
    ['one team', filter([1]), 'Analytics'],
    ['no team', filter([], true), 'No team'],
    ['several teams', filter([1, 2]), '2 teams'],
    ['one team + no team', filter([2], true), 'Process + no team'],
    ['several teams + no team', filter([1, 2, 3], true), '3 teams + no team'],
  ] as const)('%s', (_name, f, label) => {
    expect(teamFilterLabel(f, site1)).toBe(label);
  });

  it('ignores ids that are not on the site', () => {
    expect(teamFilterLabel(filter([1, 4]), site1)).toBe('Analytics');
    expect(teamFilterLabel(filter([4]), site1)).toBe('Whole site');
  });
});

describe('projectMatchesTeamFilter / staffMatchesTeamFilter', () => {
  const cases = [
    ['null filter matches a team project', [1], null, true],
    ['null filter matches a team-less project', [], null, true],
    ['shared team matches', [1, 2], filter([2]), true],
    ['no shared team fails', [1], filter([2]), false],
    ['team-less fails a team filter', [], filter([1]), false],
    ['noTeam matches team-less', [], filter([], true), true],
    ['noTeam alone fails a team project', [1], filter([], true), false],
    ['combined matches the team', [1], filter([1], true), true],
    ['combined matches team-less', [], filter([1], true), true],
    ['combined fails another team', [2], filter([1], true), false],
  ] as const;

  it.each(cases)('project: %s', (_name, teamIds, f, expected) => {
    expect(projectMatchesTeamFilter({ team_ids: [...teamIds] }, f)).toBe(expected);
  });

  it.each(cases)('staff: %s', (_name, teamIds, f, expected) => {
    expect(staffMatchesTeamFilter({ team_ids: [...teamIds] }, f)).toBe(expected);
  });

  it('treats a missing team_ids as no team', () => {
    expect(projectMatchesTeamFilter({}, filter([], true))).toBe(true);
    expect(staffMatchesTeamFilter({}, filter([1]))).toBe(false);
  });
});

describe('equipmentMatchesTeamFilter', () => {
  it('matches everything with a null filter', () => {
    expect(equipmentMatchesTeamFilter({ team_ids: [1] }, null, site1)).toBe(true);
  });

  it('matches equipment open to the whole site', () => {
    expect(equipmentMatchesTeamFilter({ team_ids: [] }, filter([1]), site1)).toBe(true);
    expect(equipmentMatchesTeamFilter({}, filter([1]), site1)).toBe(true);
  });

  it('matches restricted equipment only for a shared team', () => {
    expect(equipmentMatchesTeamFilter({ team_ids: [1] }, filter([1, 2]), site1)).toBe(true);
    expect(equipmentMatchesTeamFilter({ team_ids: [1] }, filter([2]), site1)).toBe(false);
  });

  it('treats equipment restricted at another site as whole-site here', () => {
    expect(equipmentMatchesTeamFilter({ team_ids: [4] }, filter([2]), site1)).toBe(true);
    expect(equipmentMatchesTeamFilter({ team_ids: [4, 1] }, filter([2]), site1)).toBe(false);
  });

  it('ignores noTeam', () => {
    expect(equipmentMatchesTeamFilter({ team_ids: [] }, filter([], true), site1)).toBe(true);
    expect(equipmentMatchesTeamFilter({ team_ids: [1] }, filter([], true), site1)).toBe(false);
  });
});

describe('siteScopedTeamsMatchFilter', () => {
  it('applies the per-site "no team here = whole site" rule to bare ids', () => {
    expect(siteScopedTeamsMatchFilter([1], null, site1)).toBe(true);
    expect(siteScopedTeamsMatchFilter(undefined, filter([1]), site1)).toBe(true);
    expect(siteScopedTeamsMatchFilter([4], filter([1]), site1)).toBe(true);
    expect(siteScopedTeamsMatchFilter([4, 2], filter([1]), site1)).toBe(false);
    expect(siteScopedTeamsMatchFilter([4, 2], filter([2]), site1)).toBe(true);
  });
});

describe('eventMatchesTeamFilter / tagMatchesTeamFilter', () => {
  // Archive (3) is inactive but still scopes: it is in site1.
  const cases = [
    ['null filter matches a team-limited entity', [1], null, true],
    ['no team ids is whole site', [], filter([1]), true],
    ['teams only of another site is whole site here', [4], filter([1]), true],
    ['a selected team of this site matches', [1, 4], filter([1]), true],
    ['an unselected team of this site fails', [2], filter([1]), false],
    ['a selected inactive team of this site matches', [3], filter([3]), true],
    ['an unselected inactive team of this site fails', [3], filter([1]), false],
    ['noTeam alone fails a team-limited entity', [1], filter([], true), false],
    ['noTeam alone passes a whole-site entity', [], filter([], true), true],
  ] as const;

  it.each(cases)('event: %s', (_name, teamIds, f, expected) => {
    expect(eventMatchesTeamFilter({ team_ids: [...teamIds] }, f, site1)).toBe(expected);
  });

  it.each(cases)('tag: %s', (_name, teamIds, f, expected) => {
    expect(tagMatchesTeamFilter({ team_ids: [...teamIds] }, f, site1)).toBe(expected);
  });

  it('treats a missing team_ids as whole site', () => {
    expect(eventMatchesTeamFilter({}, filter([1]), site1)).toBe(true);
    expect(tagMatchesTeamFilter({}, filter([1]), site1)).toBe(true);
  });

  it('leaves equipment behaving as before (regression)', () => {
    expect(equipmentMatchesTeamFilter({ team_ids: [3] }, filter([1]), site1)).toBe(false);
    expect(equipmentMatchesTeamFilter({ team_ids: [4] }, filter([1]), site1)).toBe(true);
  });
});
