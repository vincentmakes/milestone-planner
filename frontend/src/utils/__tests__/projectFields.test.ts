/**
 * Project field helpers: item scoping (the tag rules, twin of
 * tagsForProjectScope) and the project dialog's draft ↔ value conversion.
 */
import { describe, it, expect } from 'vitest';
import {
  FIELD_TYPE_LABELS,
  draftFromValue,
  isDropdownField,
  isEmptyFieldValue,
  normalizeStoredValue,
  optionsForProjectScope,
  optionsForSite,
  sameFieldValue,
  valueFromDraft,
  valueOptionIds,
} from '../projectFields';
import { makeProjectField, makeProjectFieldOption, makeTeam } from '@/test/factories';

const internal = makeProjectFieldOption({ id: 1, name: 'Internal', sort_order: 0 });
const basel = makeProjectFieldOption({ id: 2, name: 'Basel only', all_sites: false, site_ids: [1], sort_order: 1 });
const analytics = makeProjectFieldOption({ id: 3, name: 'Analytics only', team_ids: [10, 20], sort_order: 2 });
const area = makeProjectField({ id: 5, name: 'Area', field_type: 'multiselect', options: [internal, basel, analytics] });
const type = makeProjectField({ id: 6, name: 'Type', field_type: 'select', options: [internal, basel] });
const text = makeProjectField({ id: 7, name: 'Notes', field_type: 'text' });
const num = makeProjectField({ id: 8, name: 'Budget', field_type: 'number' });
const toggle = makeProjectField({ id: 9, name: 'Regulated', field_type: 'toggle' });

const baselTeam = makeTeam({ id: 10, site_id: 1, name: 'Analytics' });
const zurichTeam = makeTeam({ id: 20, site_id: 2, name: 'Zurich lab' });

describe('item scoping', () => {
  it('knows the dropdown types', () => {
    expect([area, type, text, num, toggle].map(isDropdownField)).toEqual([true, true, false, false, false]);
    expect(FIELD_TYPE_LABELS.multiselect).toBe('Multi-select dropdown');
  });

  it('offers all-sites items and items listing the site; no site → all-sites only', () => {
    expect(optionsForSite(area, 1).map((o) => o.id)).toEqual([1, 2, 3]);
    expect(optionsForSite(area, 2).map((o) => o.id)).toEqual([1, 3]);
    expect(optionsForSite(area, null).map((o) => o.id)).toEqual([1, 3]);
  });

  it("offers a team-limited item only to a project sharing one of its teams at the site", () => {
    // At Basel only team 10 counts; the project is in neither team
    expect(optionsForProjectScope(area, 1, [], [baselTeam]).map((o) => o.id)).toEqual([1, 2]);
    expect(optionsForProjectScope(area, 1, [10], [baselTeam]).map((o) => o.id)).toEqual([1, 2, 3]);
    // At Zurich the item is limited to team 20; at a site without its teams it is whole-site
    expect(optionsForProjectScope(area, 2, [], [zurichTeam]).map((o) => o.id)).toEqual([1]);
    expect(optionsForProjectScope(area, 3, [], []).map((o) => o.id)).toEqual([1, 3]);
  });
});

describe('values', () => {
  it('reads the item ids of a dropdown value', () => {
    expect(valueOptionIds([3, 1])).toEqual([3, 1]);
    expect(valueOptionIds(4)).toEqual([4]);
    expect(valueOptionIds('4')).toEqual([]);
    expect(valueOptionIds(null)).toEqual([]);
    expect(valueOptionIds(undefined)).toEqual([]);
    expect(valueOptionIds(1.5)).toEqual([]);
  });

  it('treats null, blank text and [] as no value; false and 0 are values', () => {
    expect([null, undefined, '', '  ', []].map(isEmptyFieldValue)).toEqual([true, true, true, true, true]);
    expect([false, 0, 'x', [1]].map(isEmptyFieldValue)).toEqual([false, false, false, false]);
  });

  it('turns stored values into dialog drafts', () => {
    expect(draftFromValue(text, 'Pilot')).toBe('Pilot');
    expect(draftFromValue(text, 5)).toBe('');
    expect(draftFromValue(num, 1250.5)).toBe('1250.5');
    expect(draftFromValue(num, 'x')).toBe('');
    expect(draftFromValue(toggle, true)).toBe(true);
    expect(draftFromValue(toggle, undefined)).toBe(false);
    expect(draftFromValue(type, 2)).toBe('2');
    expect(draftFromValue(type, [2])).toBe('2');
    expect(draftFromValue(type, null)).toBe('');
    expect(draftFromValue(area, [3, 1])).toEqual([3, 1]);
    expect(draftFromValue(area, undefined)).toEqual([]);
  });

  it('turns drafts into the values to send', () => {
    expect(valueFromDraft(text, '  Pilot ')).toBe('Pilot');
    expect(valueFromDraft(text, '   ')).toBeNull();
    expect(valueFromDraft(num, ' 12.5 ')).toBe(12.5);
    expect(valueFromDraft(num, '')).toBeNull();
    expect(valueFromDraft(num, 'abc')).toBeUndefined();
    expect(valueFromDraft(toggle, true)).toBe(true);
    expect(valueFromDraft(toggle, false)).toBeNull();
    expect(valueFromDraft(type, '2')).toBe(2);
    expect(valueFromDraft(type, '')).toBeNull();
    expect(valueFromDraft(type, undefined)).toBeNull();
    // Multi-select: item order, unknown ids dropped, none = null
    expect(valueFromDraft(area, [3, 1, 99])).toEqual([1, 3]);
    expect(valueFromDraft(area, [])).toBeNull();
    expect(valueFromDraft(area, 'x')).toBeNull();
  });

  it('drops items outside the allowed set (no longer applying to the project)', () => {
    const allowed = new Set([1]);
    expect(valueFromDraft(type, '2', allowed)).toBeNull();
    expect(valueFromDraft(type, '1', allowed)).toBe(1);
    expect(valueFromDraft(area, [1, 2, 3], allowed)).toEqual([1]);
  });

  it('normalises stored values for the change check', () => {
    expect(normalizeStoredValue(area, [3, 1])).toEqual([1, 3]);
    expect(normalizeStoredValue(toggle, false)).toBeNull();
    expect(normalizeStoredValue(text, undefined)).toBeNull();
    expect(normalizeStoredValue(num, 7)).toBe(7);
  });

  it('compares values, arrays element by element', () => {
    expect(sameFieldValue([1, 3], [1, 3])).toBe(true);
    expect(sameFieldValue([1, 3], [3, 1])).toBe(false);
    expect(sameFieldValue([1], [1, 2])).toBe(false);
    expect(sameFieldValue([1], null)).toBe(false);
    expect(sameFieldValue(null, null)).toBe(true);
    expect(sameFieldValue('a', 'a')).toBe(true);
    expect(sameFieldValue(1, 2)).toBe(false);
  });
});
