import { describe, it, expect } from 'vitest';
import {
  tagsForSite,
  tagsForProjectScope,
  compareTags,
  sortTags,
  indexTags,
  siteKey,
  SITE_KEY_PATTERN,
  tagFilterKey,
  TAG_FILTER_KEY_PATTERN,
  barTextColor,
  relativeLuminance,
} from '../tags';
import type { Tag } from '@/types';
import { makeTeam } from '@/test/factories';

function tag(id: number, name: string, extra: Partial<Tag> = {}): Tag {
  return {
    id,
    name,
    color: '#3b82f6',
    all_sites: true,
    site_ids: [],
    sort_order: 0,
    ...extra,
  };
}

const internal = tag(10, 'Internal', { color: '#10b981', sort_order: 1 });
const customer = tag(11, 'Customer', { color: '#f59e0b', sort_order: 0 });
const bio = tag(20, 'Bio');
const chem = tag(21, 'Chem', { all_sites: false, site_ids: [2] });
const pilot = tag(30, 'Pilot', { all_sites: false, site_ids: [1] });
const urgent = tag(31, 'Urgent');
const tags = [internal, customer, bio, chem, pilot, urgent];

describe('tagsForSite', () => {
  it('keeps all-sites tags and tags listing the site', () => {
    expect(tagsForSite(tags, 1).map((t) => t.id)).toEqual([10, 11, 20, 30, 31]);
    expect(tagsForSite(tags, 2).map((t) => t.id)).toEqual([10, 11, 20, 21, 31]);
  });

  it('keeps only all-sites tags without a site', () => {
    expect(tagsForSite(tags, null).map((t) => t.id)).toEqual([10, 11, 20, 31]);
    expect(tagsForSite(tags, undefined).map((t) => t.id)).toEqual([10, 11, 20, 31]);
  });
});

describe('tagsForProjectScope', () => {
  // Site 1 teams: 1, 2. Site 2 team: 3.
  const siteTeams = [makeTeam({ id: 1 }), makeTeam({ id: 2, name: 'Process' })];
  const open = tag(40, 'Open');
  const forTeam1 = tag(41, 'Team 1 only', { team_ids: [1] });
  const forOtherSite = tag(42, 'Other site team', { team_ids: [3] });
  const otherSiteOnly = tag(43, 'Site 2', { all_sites: false, site_ids: [2] });
  const scoped = [open, forTeam1, forOtherSite, otherSiteOnly];
  const ids = (list: Tag[]) => list.map((t) => t.id);

  it('always keeps a whole-site tag', () => {
    expect(ids(tagsForProjectScope(scoped, 1, [], siteTeams))).toContain(40);
    expect(ids(tagsForProjectScope(scoped, 1, [2], siteTeams))).toContain(40);
  });

  it('keeps a team-restricted tag only for a project sharing a team', () => {
    expect(ids(tagsForProjectScope(scoped, 1, [1, 2], siteTeams))).toContain(41);
    expect(ids(tagsForProjectScope(scoped, 1, [2], siteTeams))).not.toContain(41);
    expect(ids(tagsForProjectScope(scoped, 1, [], siteTeams))).not.toContain(41);
  });

  it('ignores a restriction to another site’s team', () => {
    expect(ids(tagsForProjectScope(scoped, 1, [], siteTeams))).toContain(42);
  });

  it('still applies the site scoping', () => {
    expect(ids(tagsForProjectScope(scoped, 1, [1], siteTeams))).toEqual([40, 41, 42]);
  });
});


describe('compareTags / sortTags', () => {
  it('orders by sort order, then name, without touching the input', () => {
    const input = [internal, urgent, customer, bio];
    expect(sortTags(input).map((t) => t.name)).toEqual(['Bio', 'Customer', 'Urgent', 'Internal']);
    expect(input[0]).toBe(internal);
    expect(compareTags(customer, internal)).toBeLessThan(0);
    expect(compareTags(bio, customer)).toBeLessThan(0);
  });
});

describe('indexTags', () => {
  it('maps ids to tags, cached per tags array', () => {
    const index = indexTags(tags);
    expect(index.get(21)).toBe(chem);
    expect(indexTags(tags)).toBe(index);
    expect(indexTags([...tags])).not.toBe(index);
  });
});

describe('siteKey', () => {
  it('prefixes the site id with the tenant slug (empty in single-tenant mode)', () => {
    expect(siteKey(3, '/t/acme')).toBe('acme:3');
    expect(siteKey(3, '')).toBe(':3');
    // Default: read from the current URL (jsdom is at "/").
    expect(siteKey(3)).toBe(':3');
    expect(SITE_KEY_PATTERN.test('acme:3')).toBe(true);
    expect(SITE_KEY_PATTERN.test(':3')).toBe(true);
    expect(SITE_KEY_PATTERN.test('3')).toBe(false);
  });

  it('keeps the former names as aliases', () => {
    expect(tagFilterKey).toBe(siteKey);
    expect(TAG_FILTER_KEY_PATTERN).toBe(SITE_KEY_PATTERN);
  });
});

describe('barTextColor', () => {
  it('picks dark text on light colours and white on dark ones', () => {
    expect(barTextColor('#ffffff')).toBe('#111827');
    expect(barTextColor('#fde047')).toBe('#111827');
    expect(barTextColor('#f59e0b')).toBe('#111827');
    expect(barTextColor('#000000')).toBe('#ffffff');
    expect(barTextColor('#1e3a8a')).toBe('#ffffff');
    expect(barTextColor('#7c3aed')).toBe('#ffffff');
  });

  it('accepts short hex and falls back to white for unparsable input', () => {
    expect(barTextColor('#fff')).toBe('#111827');
    expect(barTextColor('fff')).toBe('#111827');
    expect(barTextColor('red')).toBe('#ffffff');
    expect(relativeLuminance('nope')).toBeNull();
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1);
    expect(relativeLuminance('#000')).toBe(0);
  });
});
