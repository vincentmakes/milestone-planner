/**
 * termSummary: the words of a calculation's terms — each filter in a few
 * words, a term's label for the read-back line and the summary on its row.
 */
import { describe, it, expect } from 'vitest';
import { filterParts, measureLabelOf, noResultReason, pillLabel } from '../termSummary';
import type { NameLookups } from '../termSummary';

const lookups: NameLookups = {
  sites: new Map([[1, 'Basel']]),
  teams: new Map([
    [5, 'Chemistry'],
    [6, 'Physics'],
    [7, 'Biology'],
  ]),
  people: new Map([[8, 'Bob Brown']]),
  projects: new Map([[30, 'Zeta']]),
  tags: new Map([[40, 'Urgent']]),
  equipment: new Map([[70, 'HPLC 1']]),
  fields: [{ id: 3, name: 'Project type', options: [{ id: 31, name: 'Internal', color: null, sort_order: 0 }] }] as never,
};

describe('filterParts', () => {
  it('says each filter in a few words, names spelled out up to two', () => {
    expect(filterParts(undefined, lookups)).toEqual([]);
    expect(
      filterParts(
        {
          has_customer: true,
          site_ids: [1],
          team_ids: [5, 6],
          project_team_ids: [5, 6, 7],
          person_ids: [8],
          project_ids: [99],
          tag_ids: [40],
          equipment_ids: [70],
          field_options: { '3': [31], '9': [1, 2, 3], '4': [] },
          equipment_types: ['HPLC'],
          confirmed: false,
          milestones: 'only',
          archived: 'include',
        },
        lookups
      )
    ).toEqual([
      'has a customer',
      'site Basel',
      'teams Chemistry or Physics',
      '3 project teams',
      'person Bob Brown',
      'project #99',
      'tag Urgent',
      'equipment HPLC 1',
      'Project type: Internal',
      'Field: 3 items',
      'type HPLC',
      'not confirmed',
      'milestones only',
      'archived included',
    ]);
    expect(
      filterParts({ has_customer: false, confirmed: true, milestones: 'exclude', archived: 'only', team_ids: [] }, lookups)
    ).toEqual(['no customer', 'confirmed', 'without milestones', 'archived only']);
    expect(filterParts({ field_options: { '3': [77] } }, lookups)).toEqual(['Project type: #77']);
  });
});

describe('pillLabel', () => {
  it('names a pill by its measure, its filters after a dot, more than two as a count', () => {
    expect(pillLabel('booked_weeks', { has_customer: true }, lookups)).toBe('Booked weeks · Has a customer');
    expect(pillLabel('booked_weeks', { has_customer: true, team_ids: [5] }, lookups)).toBe(
      'Booked weeks · Has a customer, Team Chemistry'
    );
    expect(pillLabel('booked_weeks', { has_customer: true, team_ids: [5], site_ids: [1] }, lookups)).toBe(
      'Booked weeks · 3 filters'
    );
    expect(pillLabel('capacity_weeks', undefined, lookups)).toBe('Capacity (weeks)');
    expect(measureLabelOf('nope' as never)).toBe('nope');
  });
});

describe('noResultReason', () => {
  it('names the term that is 0, then one without a value, else the size', () => {
    const labels = { a: 'Booked weeks', b: 'Capacity (weeks)' };
    expect(
      noResultReason(
        [
          { name: 'a', value: 3, unit: 'weeks' },
          { name: 'b', value: 0, unit: 'weeks' },
        ],
        labels
      )
    ).toBe('Capacity (weeks) is 0 in this period');
    // A term the labels do not name never shows its stored letter.
    expect(noResultReason([{ name: 'c', value: null, unit: 'weeks' }], labels)).toBe('A measure has no value in this period');
    expect(noResultReason([{ name: 'c', value: 0, unit: 'weeks' }], labels)).toBe('A measure is 0 in this period');
    expect(noResultReason([{ name: 'a', value: 3, unit: 'weeks' }], labels)).toBe('The result is too large to show');
  });
});
