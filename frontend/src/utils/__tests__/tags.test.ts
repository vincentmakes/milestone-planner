import { describe, it, expect } from 'vitest';
import {
  tagsForSite,
  groupedTags,
  violatesSingleSelect,
  applyTagSelection,
  projectPassesTagFilter,
  isTagFilterActive,
  normalizeTagFilter,
  normalizeSiteTagFilter,
  tagFilterKey,
  TAG_FILTER_KEY_PATTERN,
  projectBarColor,
  barTextColor,
  indexTags,
  relativeLuminance,
  EMPTY_TAG_FILTER,
} from '../tags';
import type { Tag, TagGroup, Project } from '@/types';

function tag(id: number, name: string, extra: Partial<Tag> = {}): Tag {
  return {
    id,
    name,
    color: '#3b82f6',
    group_id: null,
    all_sites: true,
    site_ids: [],
    sort_order: 0,
    ...extra,
  };
}

function group(id: number, name: string, extra: Partial<TagGroup> = {}): TagGroup {
  return { id, name, single_select: false, sort_order: 0, ...extra };
}

// Type (single-select): Internal / Customer
// Area (multi): Bio / Chem
// Ungrouped: Pilot, Urgent
const TYPE = group(1, 'Type', { single_select: true, sort_order: 0 });
const AREA = group(2, 'Area', { sort_order: 1 });
const groups = [AREA, TYPE];
const internal = tag(10, 'Internal', { group_id: 1, color: '#10b981', sort_order: 1 });
const customer = tag(11, 'Customer', { group_id: 1, color: '#f59e0b', sort_order: 0 });
const bio = tag(20, 'Bio', { group_id: 2 });
const chem = tag(21, 'Chem', { group_id: 2, all_sites: false, site_ids: [2] });
const pilot = tag(30, 'Pilot', { all_sites: false, site_ids: [1] });
const urgent = tag(31, 'Urgent');
const tags = [internal, customer, bio, chem, pilot, urgent];

function project(tagIds: number[]): Pick<Project, 'tags'> {
  // Inline refs deliberately carry stale names/colours/groups.
  return { tags: tagIds.map((id) => ({ id, name: 'stale', color: '#000000', group_id: 999 })) };
}

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

describe('groupedTags', () => {
  it('orders groups and tags by sort order then name, ungrouped last', () => {
    const sections = groupedTags(tags, groups);
    expect(sections.map((s) => s.group?.name ?? 'Other')).toEqual(['Type', 'Area', 'Other']);
    expect(sections[0].tags.map((t) => t.name)).toEqual(['Customer', 'Internal']);
    expect(sections[1].tags.map((t) => t.name)).toEqual(['Bio', 'Chem']);
    expect(sections[2].tags.map((t) => t.name)).toEqual(['Pilot', 'Urgent']);
  });

  it('breaks sort-order ties by name', () => {
    const sections = groupedTags(
      [tag(1, 'b'), tag(2, 'a')],
      [group(5, 'Zed'), group(6, 'Alpha')].map((g) => ({ ...g }))
    );
    expect(sections).toEqual([{ group: null, tags: [tag(2, 'a'), tag(1, 'b')] }]);
    const withGroups = groupedTags(
      [tag(1, 'x', { group_id: 5 }), tag(2, 'y', { group_id: 6 })],
      [group(5, 'Zed'), group(6, 'Alpha')]
    );
    expect(withGroups.map((s) => s.group?.name)).toEqual(['Alpha', 'Zed']);
  });

  it('omits empty sections and applies the optional site filter', () => {
    const sections = groupedTags(tags, groups, 2);
    expect(sections.map((s) => s.group?.name ?? 'Other')).toEqual(['Type', 'Area', 'Other']);
    expect(sections[2].tags.map((t) => t.name)).toEqual(['Urgent']);

    const noArea = groupedTags([internal, urgent], groups);
    expect(noArea.map((s) => s.group?.name ?? 'Other')).toEqual(['Type', 'Other']);
    expect(groupedTags([], groups)).toEqual([]);
  });

  it('null site keeps only all-sites tags; omitted site keeps everything', () => {
    expect(groupedTags([pilot, chem], groups, null)).toEqual([]);
    expect(groupedTags([pilot, chem], groups).flatMap((s) => s.tags.map((t) => t.id))).toEqual([21, 30]);
  });

  it('treats a tag whose group no longer exists as ungrouped', () => {
    const orphan = tag(40, 'Orphan', { group_id: 77 });
    const sections = groupedTags([orphan], groups);
    expect(sections).toEqual([{ group: null, tags: [orphan] }]);
  });
});

describe('single-select groups', () => {
  it('detects two tags of one single-select group', () => {
    expect(violatesSingleSelect([10, 11], tags, groups)).toBe(true);
    expect(violatesSingleSelect(new Set([10, 20, 21, 30]), tags, groups)).toBe(false);
    expect(violatesSingleSelect([], tags, groups)).toBe(false);
  });

  it('replaces the group selection when adding a single-select tag', () => {
    const next = applyTagSelection(new Set([10, 20]), 11, tags, groups);
    expect([...next].sort()).toEqual([11, 20]);
  });

  it('adds freely in multi-select groups and ungrouped tags', () => {
    expect([...applyTagSelection(new Set([20]), 21, tags, groups)].sort()).toEqual([20, 21]);
    expect([...applyTagSelection(new Set([30]), 31, tags, groups)].sort()).toEqual([30, 31]);
  });

  it('removes an already-selected tag and never mutates the input', () => {
    const input = new Set([10, 20]);
    const next = applyTagSelection(input, 10, tags, groups);
    expect([...next]).toEqual([20]);
    expect([...input]).toEqual([10, 20]);
  });
});

describe('projectPassesTagFilter', () => {
  it('passes everything for an empty filter', () => {
    expect(projectPassesTagFilter(project([]), EMPTY_TAG_FILTER, tags, groups)).toBe(true);
    expect(projectPassesTagFilter(project([10]), null, tags, groups)).toBe(true);
    expect(projectPassesTagFilter({}, { tagIds: [], noneGroupIds: [] }, tags, groups)).toBe(true);
  });

  it('ORs within a group', () => {
    const f = { tagIds: [10, 11], noneGroupIds: [] };
    expect(projectPassesTagFilter(project([10]), f, tags, groups)).toBe(true);
    expect(projectPassesTagFilter(project([11]), f, tags, groups)).toBe(true);
    expect(projectPassesTagFilter(project([20]), f, tags, groups)).toBe(false);
  });

  it('ANDs across groups, with ungrouped tags as their own bucket', () => {
    const f = { tagIds: [10, 20, 30], noneGroupIds: [] };
    expect(projectPassesTagFilter(project([10, 20, 30]), f, tags, groups)).toBe(true);
    expect(projectPassesTagFilter(project([10, 20]), f, tags, groups)).toBe(false);
    expect(projectPassesTagFilter(project([10, 30]), f, tags, groups)).toBe(false);
    // Other bucket is OR inside itself
    const g = { tagIds: [30, 31], noneGroupIds: [] };
    expect(projectPassesTagFilter(project([31]), g, tags, groups)).toBe(true);
  });

  it('"(No tag)" matches projects without a tag of that group, OR-ed with its ticked tags', () => {
    const none = { tagIds: [], noneGroupIds: [1] };
    expect(projectPassesTagFilter(project([]), none, tags, groups)).toBe(true);
    expect(projectPassesTagFilter(project([20]), none, tags, groups)).toBe(true);
    expect(projectPassesTagFilter(project([10]), none, tags, groups)).toBe(false);

    const noneOrInternal = { tagIds: [10], noneGroupIds: [1] };
    expect(projectPassesTagFilter(project([]), noneOrInternal, tags, groups)).toBe(true);
    expect(projectPassesTagFilter(project([10]), noneOrInternal, tags, groups)).toBe(true);
    expect(projectPassesTagFilter(project([11]), noneOrInternal, tags, groups)).toBe(false);

    // AND with another group
    const combined = { tagIds: [10, 20], noneGroupIds: [1] };
    expect(projectPassesTagFilter(project([20]), combined, tags, groups)).toBe(true);
    expect(projectPassesTagFilter(project([]), combined, tags, groups)).toBe(false);
  });

  it('resolves groups from the store, not the stale inline refs', () => {
    // Inline group_id is 999 everywhere; Internal is really in Type.
    expect(projectPassesTagFilter(project([10]), { tagIds: [], noneGroupIds: [1] }, tags, groups)).toBe(false);
    // A tag moved to another group since: the filter buckets by its current group.
    const moved = [...tags.filter((t) => t.id !== 20), { ...bio, group_id: 1 }];
    const f = { tagIds: [10, 20], noneGroupIds: [] };
    expect(projectPassesTagFilter(project([20]), f, moved, groups)).toBe(true);
    expect(projectPassesTagFilter(project([20]), f, tags, groups)).toBe(false);
  });

  it('ignores stale filter ids instead of excluding everything', () => {
    const stale = { tagIds: [999], noneGroupIds: [888] };
    expect(projectPassesTagFilter(project([]), stale, tags, groups)).toBe(true);
    const partlyStale = { tagIds: [999, 10], noneGroupIds: [] };
    expect(projectPassesTagFilter(project([10]), partlyStale, tags, groups)).toBe(true);
    expect(projectPassesTagFilter(project([11]), partlyStale, tags, groups)).toBe(false);
  });

  it('ignores project tag ids that no longer exist', () => {
    expect(projectPassesTagFilter(project([555]), { tagIds: [], noneGroupIds: [1] }, tags, groups)).toBe(true);
  });
});

describe('isTagFilterActive / normalizeTagFilter', () => {
  it('is active only while something effective remains', () => {
    expect(isTagFilterActive(EMPTY_TAG_FILTER, tags, groups)).toBe(false);
    expect(isTagFilterActive(undefined, tags, groups)).toBe(false);
    expect(isTagFilterActive({ tagIds: [999], noneGroupIds: [888] }, tags, groups)).toBe(false);
    expect(isTagFilterActive({ tagIds: [10], noneGroupIds: [] }, tags, groups)).toBe(true);
    expect(isTagFilterActive({ tagIds: [], noneGroupIds: [2] }, tags, groups)).toBe(true);
  });

  it('prunes and dedupes stale ids', () => {
    expect(normalizeTagFilter({ tagIds: [10, 999, 10], noneGroupIds: [2, 888] }, tags, groups)).toEqual({
      tagIds: [10],
      noneGroupIds: [2],
    });
    expect(normalizeTagFilter(null, tags, groups)).toEqual({ tagIds: [], noneGroupIds: [] });
  });
});

describe('normalizeSiteTagFilter', () => {
  it('keeps "(No tag)" only for groups with a tag at the site (what the dropdown shows)', () => {
    // At a site where only Type's tags and Pilot apply, Area has no checkbox.
    const siteTags = [internal, customer, pilot];
    expect(
      normalizeSiteTagFilter({ tagIds: [10, 20], noneGroupIds: [1, 2, 888] }, siteTags, groups)
    ).toEqual({ tagIds: [10], noneGroupIds: [1] });
    expect(normalizeSiteTagFilter(undefined, siteTags, groups)).toEqual({ tagIds: [], noneGroupIds: [] });
  });
});

describe('tagFilterKey', () => {
  it('prefixes the site id with the tenant slug (empty in single-tenant mode)', () => {
    expect(tagFilterKey(3, '/t/acme')).toBe('acme:3');
    expect(tagFilterKey(3, '')).toBe(':3');
    // Default: read from the current URL (jsdom is at "/").
    expect(tagFilterKey(3)).toBe(':3');
    expect(TAG_FILTER_KEY_PATTERN.test('acme:3')).toBe(true);
    expect(TAG_FILTER_KEY_PATTERN.test(':3')).toBe(true);
    expect(TAG_FILTER_KEY_PATTERN.test('3')).toBe(false);
  });
});

describe('projectBarColor', () => {
  const tagById = indexTags(tags);

  it('uses the colour of the project tag in the chosen group, from the store', () => {
    expect(projectBarColor(project([20, 10]), tagById, TYPE)).toBe('#10b981');
    expect(projectBarColor(project([11]), tagById, TYPE)).toBe('#f59e0b');
    // Any group can colour, single-select or not
    expect(projectBarColor(project([10, 20]), tagById, AREA)).toBe('#3b82f6');
  });

  it('returns null without a chosen group or a project tag in it', () => {
    expect(projectBarColor(project([10]), tagById, null)).toBeNull();
    expect(projectBarColor(project([20, 30]), tagById, TYPE)).toBeNull();
    expect(projectBarColor({}, tagById, TYPE)).toBeNull();
    expect(projectBarColor(project([555]), tagById, TYPE)).toBeNull();
  });

  it('takes the first tag in group order when the project has several of the group', () => {
    const red = tag(40, 'Zeta', { group_id: 2, color: '#ef4444', sort_order: 0 });
    const green = tag(41, 'Alpha', { group_id: 2, color: '#22c55e', sort_order: 0 });
    const blue = tag(42, 'Early', { group_id: 2, color: '#3b82f6', sort_order: -1 });
    const index = indexTags([red, green, blue]);
    // Same sort_order → name decides, whatever the project's tag order
    expect(projectBarColor(project([40, 41]), index, AREA)).toBe('#22c55e');
    expect(projectBarColor(project([41, 40]), index, AREA)).toBe('#22c55e');
    // sort_order before name
    expect(projectBarColor(project([40, 41, 42]), index, AREA)).toBe('#3b82f6');
  });

  it('caches the index per tags array', () => {
    expect(indexTags(tags)).toBe(tagById);
    expect(indexTags([...tags])).not.toBe(tagById);
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
