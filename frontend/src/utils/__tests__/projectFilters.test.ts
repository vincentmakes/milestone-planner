import { describe, it, expect } from 'vitest';
import {
  EMPTY_PROJECT_FILTER,
  fieldsForSite,
  filterSelectionCount,
  indexOptions,
  isFilterActive,
  normalizeSiteFilter,
  optionsForSite,
  projectBarColor,
  projectOptionIds,
  projectPassesFilter,
  selectableFields,
} from '../projectFilters';
import type { ProjectFilter } from '../projectFilters';
import type { Project, ProjectFieldValue } from '@/types';
import { makeProjectField, makeProjectFieldOption, makeTag } from '@/test/factories';

// Type (select): Internal / Customer — Customer only at site 1
// Area (multiselect): Bio / Chem / Pharma
// Notes (text) and Budget (number): never selectable
const internal = makeProjectFieldOption({ id: 10, name: 'Internal', color: '#10b981' });
const customer = makeProjectFieldOption({ id: 11, name: 'Customer', color: '#f59e0b', all_sites: false, site_ids: [1] });
const TYPE = makeProjectField({ id: 1, name: 'Type', field_type: 'select', sort_order: 1, options: [internal, customer] });

const bio = makeProjectFieldOption({ id: 20, name: 'Bio', color: '#22c55e' });
const chem = makeProjectFieldOption({ id: 21, name: 'Chem', color: '#ef4444' });
const pharma = makeProjectFieldOption({ id: 22, name: 'Pharma', color: '#3b82f6', all_sites: false, site_ids: [2] });
const AREA = makeProjectField({ id: 2, name: 'Area', field_type: 'multiselect', sort_order: 0, options: [bio, chem, pharma] });

const NOTES = makeProjectField({ id: 3, name: 'Notes', field_type: 'text', sort_order: 0 });
const BUDGET = makeProjectField({ id: 4, name: 'Budget', field_type: 'number', sort_order: 2 });

const fields = [TYPE, NOTES, AREA, BUDGET];

const pilot = makeTag({ id: 30, name: 'Pilot', color: '#a855f7', sort_order: 1 });
const urgent = makeTag({ id: 31, name: 'Urgent', color: '#f97316', sort_order: 0 });
const alpha = makeTag({ id: 32, name: 'Alpha', color: '#0ea5e9', sort_order: 1 });
const tags = [pilot, urgent, alpha];

function project(values: Record<number, ProjectFieldValue> = {}, tagIds: number[] = []): Pick<Project, 'field_values' | 'tags'> {
  // Inline tag refs deliberately carry stale names and colours.
  return { field_values: values, tags: tagIds.map((id) => ({ id, name: 'stale', color: '#000000' })) };
}

function filter(patch: Partial<ProjectFilter>): ProjectFilter {
  return { optionIds: [], noneFieldIds: [], tagIds: [], ...patch };
}

const site1 = fieldsForSite(fields, 1);

describe('selectableFields / fieldsForSite / optionsForSite', () => {
  it('keeps the dropdown fields in display order', () => {
    expect(selectableFields(fields).map((f) => f.id)).toEqual([2, 1]);
    expect(fields.map((f) => f.id)).toEqual([1, 3, 2, 4]);
  });

  it('breaks sort-order ties by name', () => {
    const b = makeProjectField({ id: 7, name: 'Beta', sort_order: 0 });
    const a = makeProjectField({ id: 8, name: 'Alpha', sort_order: 0 });
    expect(selectableFields([b, a]).map((f) => f.name)).toEqual(['Alpha', 'Beta']);
  });

  it('narrows each field to the items of the site and drops fields left empty', () => {
    expect(site1.map((f) => [f.id, f.options.map((o) => o.id)])).toEqual([
      [2, [20, 21]],
      [1, [10, 11]],
    ]);
    expect(fieldsForSite(fields, 2).map((f) => [f.id, f.options.map((o) => o.id)])).toEqual([
      [2, [20, 21, 22]],
      [1, [10]],
    ]);
    const siteOnly = makeProjectField({ id: 9, options: [customer] });
    expect(fieldsForSite([siteOnly], 2)).toEqual([]);
    expect(fieldsForSite([siteOnly], null)).toEqual([]);
    expect(optionsForSite(TYPE, null).map((o) => o.id)).toEqual([10]);
  });
});

describe('projectOptionIds', () => {
  it('lists the chosen items that exist, in item order', () => {
    expect(projectOptionIds(project({ 2: [21, 20] }), AREA)).toEqual([20, 21]);
    expect(projectOptionIds(project({ 1: 11 }), TYPE)).toEqual([11]);
    expect(projectOptionIds(project({ 2: [21, 999] }), AREA)).toEqual([21]);
  });

  it('is empty without a value, for a value of another shape or without field_values', () => {
    expect(projectOptionIds(project(), AREA)).toEqual([]);
    expect(projectOptionIds(project({ 1: 'Internal' }), TYPE)).toEqual([]);
    expect(projectOptionIds({}, TYPE)).toEqual([]);
  });

  it('only sees the items of the field it is given (site-narrowed)', () => {
    const area1 = site1.find((f) => f.id === 2)!;
    expect(projectOptionIds(project({ 2: [22] }), area1)).toEqual([]);
  });
});

describe('indexOptions', () => {
  it('maps item ids to the item, its field and rank, cached per fields array', () => {
    const index = indexOptions(fields);
    expect(index.get(21)).toEqual({ option: chem, field: AREA, rank: 1 });
    expect(index.get(999)).toBeUndefined();
    expect(indexOptions(fields)).toBe(index);
    expect(indexOptions([...fields])).not.toBe(index);
  });
});

describe('projectPassesFilter', () => {
  const pass = (p: ReturnType<typeof project>, f: ProjectFilter | null | undefined) =>
    projectPassesFilter(p, f, site1, tags);

  it('passes everything for an empty or missing filter', () => {
    expect(pass(project(), EMPTY_PROJECT_FILTER)).toBe(true);
    expect(pass(project(), null)).toBe(true);
    expect(pass(project(), undefined)).toBe(true);
  });

  it('ORs the items of one field', () => {
    const f = filter({ optionIds: [20, 21] });
    expect(pass(project({ 2: [20] }), f)).toBe(true);
    expect(pass(project({ 2: [21] }), f)).toBe(true);
    expect(pass(project({ 2: [20, 21] }), f)).toBe(true);
    expect(pass(project({ 1: 10 }), f)).toBe(false);
  });

  it('ANDs across fields', () => {
    const f = filter({ optionIds: [20, 10] });
    expect(pass(project({ 2: [20], 1: 10 }), f)).toBe(true);
    expect(pass(project({ 2: [20], 1: 11 }), f)).toBe(false);
    expect(pass(project({ 1: 10 }), f)).toBe(false);
  });

  it('"(None)" matches projects without an item of that field, OR-ed with its items', () => {
    const none = filter({ noneFieldIds: [1] });
    expect(pass(project(), none)).toBe(true);
    expect(pass(project({ 1: 10 }), none)).toBe(false);
    const noneOrCustomer = filter({ noneFieldIds: [1], optionIds: [11] });
    expect(pass(project(), noneOrCustomer)).toBe(true);
    expect(pass(project({ 1: 11 }), noneOrCustomer)).toBe(true);
    expect(pass(project({ 1: 10 }), noneOrCustomer)).toBe(false);
  });

  it('a value holding only unknown items counts as no item', () => {
    expect(pass(project({ 2: [999] }), filter({ noneFieldIds: [2] }))).toBe(true);
  });

  it('treats the tags as one OR bucket AND-ed with the fields', () => {
    const tagsOnly = filter({ tagIds: [30, 31] });
    expect(pass(project({}, [30]), tagsOnly)).toBe(true);
    expect(pass(project({}, [31, 32]), tagsOnly)).toBe(true);
    expect(pass(project({}, [32]), tagsOnly)).toBe(false);
    expect(pass(project(), tagsOnly)).toBe(false);

    const combined = filter({ tagIds: [30], optionIds: [10] });
    expect(pass(project({ 1: 10 }, [30]), combined)).toBe(true);
    expect(pass(project({ 1: 10 }), combined)).toBe(false);
    expect(pass(project({}, [30]), combined)).toBe(false);
  });

  it('combines several fields, "(None)" and tags', () => {
    const f = filter({ optionIds: [20], noneFieldIds: [1], tagIds: [31] });
    expect(pass(project({ 2: [20, 21] }, [31]), f)).toBe(true);
    expect(pass(project({ 2: [20], 1: 10 }, [31]), f)).toBe(false);
    expect(pass(project({ 2: [21] }, [31]), f)).toBe(false);
    expect(pass(project({ 2: [20] }, [30]), f)).toBe(false);
  });

  it('ignores stale item, field and tag ids instead of excluding everything', () => {
    expect(pass(project(), filter({ optionIds: [999], noneFieldIds: [999], tagIds: [999] }))).toBe(true);
    // A non-dropdown field id is stale too
    expect(pass(project({ 1: 10 }), filter({ noneFieldIds: [3] }))).toBe(true);
    // A stale id next to a live one: only the live one counts
    expect(pass(project({ 2: [21] }), filter({ optionIds: [999, 21] }))).toBe(true);
  });

  it('scopes items by site: an item of another site is stale here', () => {
    // Pharma (22) only applies at site 2
    expect(pass(project({ 2: [21] }), filter({ optionIds: [22] }))).toBe(true);
    expect(projectPassesFilter(project({ 2: [21] }), filter({ optionIds: [22] }), fieldsForSite(fields, 2), tags)).toBe(false);
  });

  it('resolves tags by id, ignoring project tag ids that no longer exist', () => {
    expect(pass(project({}, [555]), filter({ tagIds: [30] }))).toBe(false);
  });
});

describe('isFilterActive', () => {
  it('is active only while something effective remains', () => {
    expect(isFilterActive(null, site1, tags)).toBe(false);
    expect(isFilterActive(EMPTY_PROJECT_FILTER, site1, tags)).toBe(false);
    expect(isFilterActive(filter({ optionIds: [999], tagIds: [999] }), site1, tags)).toBe(false);
    expect(isFilterActive(filter({ optionIds: [20] }), site1, tags)).toBe(true);
    expect(isFilterActive(filter({ noneFieldIds: [1] }), site1, tags)).toBe(true);
    expect(isFilterActive(filter({ tagIds: [30] }), site1, tags)).toBe(true);
  });
});

describe('normalizeSiteFilter', () => {
  it('prunes ids the site does not offer and dedupes the rest', () => {
    const stored = filter({ optionIds: [20, 20, 22, 999], noneFieldIds: [1, 1, 3, 999], tagIds: [31, 31, 999] });
    expect(normalizeSiteFilter(stored, site1, [urgent])).toEqual({
      optionIds: [20],
      noneFieldIds: [1],
      tagIds: [31],
    });
  });

  it('keeps "(None)" only for a field the dropdown shows', () => {
    const siteOnly = makeProjectField({ id: 9, options: [customer] });
    expect(normalizeSiteFilter(filter({ noneFieldIds: [9] }), fieldsForSite([siteOnly], 2), [])).toEqual(
      filter({})
    );
  });

  it('returns a fresh empty filter for nothing stored and tolerates missing lists', () => {
    expect(normalizeSiteFilter(undefined, site1, tags)).toEqual(filter({}));
    expect(normalizeSiteFilter({} as ProjectFilter, site1, tags)).toEqual(filter({}));
  });

  it('counts the selections', () => {
    expect(filterSelectionCount(filter({ optionIds: [1, 2], noneFieldIds: [3], tagIds: [4] }))).toBe(4);
    expect(filterSelectionCount(EMPTY_PROJECT_FILTER)).toBe(0);
  });
});

describe('projectBarColor', () => {
  it('colours by the project item of the chosen field, from the store', () => {
    expect(projectBarColor(project({ 1: 11 }), site1, tags, 1)).toBe('#f59e0b');
    expect(projectBarColor(project({ 2: [21] }), site1, tags, 2)).toBe('#ef4444');
  });

  it('takes the first item in item order when the project has several', () => {
    expect(projectBarColor(project({ 2: [21, 20] }), site1, tags, 2)).toBe('#22c55e');
  });

  it('colours by the first tag in tag order (sort order, then name) for "tags"', () => {
    expect(projectBarColor(project({}, [30, 31]), site1, tags, 'tags')).toBe('#f97316');
    // Same sort order: name decides (Alpha before Pilot)
    expect(projectBarColor(project({}, [30, 32]), site1, tags, 'tags')).toBe('#0ea5e9');
    expect(projectBarColor(project({}, [555]), site1, tags, 'tags')).toBeNull();
    expect(projectBarColor({}, site1, tags, 'tags')).toBeNull();
  });

  it('returns null without a choice, for an unknown field or without an item', () => {
    expect(projectBarColor(project({ 1: 10 }), site1, tags, null)).toBeNull();
    expect(projectBarColor(project({ 1: 10 }), site1, tags, undefined)).toBeNull();
    expect(projectBarColor(project({ 1: 10 }), site1, tags, 999)).toBeNull();
    expect(projectBarColor(project({ 2: [20] }), site1, tags, 1)).toBeNull();
    // An item outside the site's items gives no colour
    expect(projectBarColor(project({ 2: [22] }), site1, tags, 2)).toBeNull();
  });
});
