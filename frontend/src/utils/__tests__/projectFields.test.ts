/**
 * Project field helpers: item scoping (the tag rules, twin of
 * tagsForProjectScope) and the project dialog's draft ↔ value conversion.
 */
import { describe, it, expect } from 'vitest';
import {
  FIELD_TYPE_LABELS,
  acceptsNumberText,
  draftFromValue,
  fieldNumberInputText,
  formatFieldNumber,
  isDropdownField,
  isEmptyFieldValue,
  normalizeStoredValue,
  optionsForProjectScope,
  optionsForSite,
  roundFieldNumber,
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

// (value, decimals, expected). Mirror of ROUNDING_CASES in
// tests/test_project_field_rules.py, case for case: change one, change both.
// Half-up away from zero on the shortest decimal string, never toFixed on the
// binary double (which gives 1.00 for 1.005).
const ROUNDING_CASES: [number, number | null, number][] = [
  [0.125, 2, 0.13],
  [1.005, 2, 1.01],
  [2.5, 0, 3],
  [-2.5, 0, -3],
  [-0.125, 2, -0.13],
  [1.45, 1, 1.5],
  [0.0005, 3, 0.001],
  [12.3456, 3, 12.346],
  [123456789.125, 2, 123456789.13],
  [-0.004, 2, 0],
  [0.0000001, 3, 0],
  [7, 2, 7],
  [7.1, 3, 7.1],
  [0.5, null, 0.5],
  [1e300, 2, 1e300],
];

describe('number decimals', () => {
  it.each(ROUNDING_CASES)('rounds %s to %s decimals as %s (the server table)', (value, decimals, expected) => {
    const rounded = roundFieldNumber(value, decimals);
    expect(rounded).toBe(expected);
    expect(Object.is(rounded, -0)).toBe(false);
  });

  it('carries a round-up across the decimal point', () => {
    expect(roundFieldNumber(9.995, 2)).toBe(10);
    expect(roundFieldNumber(-9.5, 0)).toBe(-10);
    expect(roundFieldNumber(0.999, 0)).toBe(1);
  });

  it('formats for display with exactly the field decimals', () => {
    expect(formatFieldNumber(1234.5, 2)).toBe(new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 }).format(1234.5));
    expect(formatFieldNumber(0.125, 2)).toBe(new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 }).format(0.13));
    expect(formatFieldNumber(2.5, 0)).toBe(new Intl.NumberFormat().format(3));
    expect(formatFieldNumber(0.12345, null)).toBe(
      new Intl.NumberFormat(undefined, { maximumFractionDigits: 20 }).format(0.12345)
    );
  });

  it('gives the input text rounded and padded, or as typed', () => {
    expect(fieldNumberInputText(12.5, 2)).toBe('12.50');
    expect(fieldNumberInputText(0.125, 2)).toBe('0.13');
    expect(fieldNumberInputText(2.5, 0)).toBe('3');
    expect(fieldNumberInputText(0.125, null)).toBe('0.125');
    expect(fieldNumberInputText(1e300, 2)).toBe('1e+300');
  });

  it('drafts a stored value rounded and sends a typed one rounded, as the server stores it', () => {
    const cost = makeProjectField({ id: 11, name: 'Cost', field_type: 'number', decimals: 2 });
    expect(draftFromValue(cost, 0.125)).toBe('0.13');
    expect(valueFromDraft(cost, '1.005')).toBe(1.01);
    expect(valueFromDraft(cost, 'abc')).toBeUndefined();
    // A stored value left untouched compares equal to its rounded draft: not re-sent.
    expect(sameFieldValue(normalizeStoredValue(cost, 0.125), valueFromDraft(cost, draftFromValue(cost, 0.125))!)).toBe(true);
    // Without decimals, as typed.
    expect(draftFromValue(num, 0.125)).toBe('0.125');
    expect(valueFromDraft(num, '0.125')).toBe(0.125);
  });
});

// The number input's typing gate: [text, decimals, accepted].
const TYPING_CASES: [string, number | null, boolean][] = [
  ['', 1, true],
  ['-', 1, true],
  ['12', 1, true],
  ['12.', 1, true],
  ['12.3', 1, true],
  ['-12.3', 1, true],
  ['.5', 1, true],
  ['12.34', 1, false],
  ['1e5', 1, false],
  ['1,5', 1, false],
  ['+1', 1, false],
  ['12', 0, true],
  ['-7', 0, true],
  ['12.', 0, false],
  ['12.3', 0, false],
  ['12.34', 2, true],
  ['12.345', 2, false],
  ['0.125', 3, true],
  ['0.1255', 3, false],
  ['12.3456', null, true],
  ['1e5', null, true],
];

describe('acceptsNumberText', () => {
  it.each(TYPING_CASES)('takes %j at %s decimals: %s', (text, decimals, accepted) => {
    expect(acceptsNumberText(text, decimals)).toBe(accepted);
  });

  it('treats undefined decimals as typed', () => {
    expect(acceptsNumberText('1.23456', undefined)).toBe(true);
  });
});
