/**
 * The builder's pure rules: kind rules on dimensions, percentages and Top N,
 * a measure change dropping refused dimensions, options per kind, the
 * client-side problems, the cleaned query, the filter count, the placement
 * of a new widget, grid ids and the key-order-free comparison.
 */
import { describe, it, expect } from 'vitest';
import type { MetricQuery } from '@/types';
import {
  activeFilterCount,
  changeMeasure,
  cleanOptions,
  cleanQuery,
  comparableDraft,
  defaultQuery,
  dimensionKey,
  gridIdOf,
  MAX_DIMENSIONS,
  newClientId,
  normaliseQuery,
  placeNewWidget,
  queryProblem,
  sameLayout,
  savedTargets,
  stableKey,
  TARGET_KEYS,
  toDraftWidget,
} from '../widgetDraft';

const query = (extra: Partial<MetricQuery> = {}): MetricQuery => ({ ...defaultQuery(), ...extra });

describe('kind rules', () => {
  it('caps the dimensions per kind', () => {
    expect(MAX_DIMENSIONS).toEqual({ kpi: 1, pie: 1, bar: 2, line: 2, table: 2 });
    const two = query({ dimensions: [{ kind: 'site' }, { kind: 'team' }] });
    expect(normaliseQuery('pie', two).dimensions).toEqual([{ kind: 'site' }]);
    expect(normaliseQuery('bar', two).dimensions).toHaveLength(2);
  });

  it('makes a KPI with a dimension a share of the total', () => {
    const q = normaliseQuery('kpi', query({ dimensions: [{ kind: 'confirmed' }], percent_of: null }));
    expect(q.percent_of).toBe('total');
    expect(normaliseQuery('kpi', query({ dimensions: [{ kind: 'site' }, { kind: 'team' }], percent_of: 'first_dimension' })))
      .toMatchObject({ dimensions: [{ kind: 'site' }], percent_of: 'total' });
  });

  it('drops a percentage without the dimensions it needs', () => {
    expect(normaliseQuery('bar', query({ percent_of: 'total' })).percent_of).toBeNull();
    expect(normaliseQuery('bar', query({ dimensions: [{ kind: 'site' }], percent_of: 'first_dimension' })).percent_of).toBeNull();
    expect(
      normaliseQuery('bar', query({ dimensions: [{ kind: 'site' }, { kind: 'team' }], percent_of: 'first_dimension' }))
        .percent_of
    ).toBe('first_dimension');
  });

  it('drops Top N without a dimension or on a period first dimension', () => {
    expect(normaliseQuery('bar', query({ top_n: 5 })).top_n).toBeNull();
    expect(normaliseQuery('bar', query({ dimensions: [{ kind: 'period', grain: 'month' }], top_n: 5 })).top_n).toBeNull();
    expect(normaliseQuery('bar', query({ dimensions: [{ kind: 'project' }], top_n: 5 })).top_n).toBe(5);
    expect(normaliseQuery('bar', { measure: 'booked_days' })).toMatchObject({ dimensions: [], percent_of: null, top_n: null });
  });

  it('drops the dimensions a new measure refuses', () => {
    const q = query({ dimensions: [{ kind: 'team' }, { kind: 'period', grain: 'year' }] });
    expect(changeMeasure('bar', q, 'project_count').dimensions).toEqual([{ kind: 'period', grain: 'year' }]);
    expect(changeMeasure('bar', q, 'people_booked').dimensions).toEqual([{ kind: 'team' }]);
    expect(changeMeasure('bar', q, 'booked_days').measure).toBe('booked_days');
  });

  it('drops the Teams and People filters off a booking measure', () => {
    const filters = { team_ids: [5], person_ids: [8], tag_ids: [40], period: { relative: 'this_year' as const } };
    const q = query({ filters });
    expect(changeMeasure('bar', q, 'project_weeks').filters).toEqual({ tag_ids: [40], period: { relative: 'this_year' } });
    expect(normaliseQuery('kpi', { ...q, measure: 'phase_count' }).filters).not.toHaveProperty('team_ids');
    expect(changeMeasure('bar', q, 'people_booked').filters).toEqual(filters);
    // Nothing to drop: the filters are kept as they are.
    const plain = query({ measure: 'project_count' });
    expect(normaliseQuery('bar', plain).filters).toBe(plain.filters);
  });

  it('keeps the Percent number format only on a percentage', () => {
    expect(cleanOptions('kpi', query(), { number_format: 'percent' })).toEqual({});
    expect(cleanOptions('bar', query(), { number_format: 'percent' })).toEqual({});
    expect(cleanOptions('bar', query({ dimensions: [{ kind: 'site' }], percent_of: 'total' }), { number_format: 'percent' })).toEqual({
      number_format: 'percent',
    });
    expect(cleanOptions('table', query(), { number_format: 'integer' })).toEqual({ number_format: 'integer' });
  });

  it('keeps the options a kind uses, when they differ from the default', () => {
    expect(cleanOptions('bar', query(), { percent: true, orientation: 'horizontal', show_legend: false })).toEqual({
      percent: true,
      stacked: true,
      orientation: 'horizontal',
    });
    expect(cleanOptions('bar', query(), { stacked: true, orientation: 'vertical', percent: false })).toEqual({ stacked: true });
    expect(cleanOptions('line', query(), { percent: true, show_legend: false })).toEqual({ show_legend: false });
    expect(cleanOptions('line', query(), { show_legend: true })).toEqual({});
    expect(cleanOptions('pie', query(), { show_legend: true, number_format: 'integer' })).toEqual({
      show_legend: true,
      number_format: 'integer',
    });
    expect(cleanOptions('pie', query(), { show_legend: false })).toEqual({});
    expect(cleanOptions('kpi', query({ percent_of: 'total' }), { kpi_bucket: false })).toEqual({ kpi_bucket: false });
    expect(cleanOptions('kpi', query({ percent_of: 'total' }), { kpi_bucket: null })).toEqual({});
    expect(cleanOptions('kpi', query(), { kpi_bucket: true })).toEqual({});
    expect(cleanOptions('table', query({ percent_of: 'total' }), { kpi_bucket: 3, stacked: true })).toEqual({});
  });

  it('names what blocks a query client-side', () => {
    expect(queryProblem('pie', query())).toBe('A pie chart needs one dimension.');
    expect(queryProblem('pie', query({ dimensions: [{ kind: 'site' }] }))).toBeNull();
    expect(queryProblem('kpi', query({ dimensions: [{ kind: 'site' }] }))).toBe(
      'A KPI with a dimension shows a share: set Percent of to Total.'
    );
    expect(queryProblem('kpi', query({ dimensions: [{ kind: 'site' }], percent_of: 'total' }))).toBeNull();
    expect(queryProblem('bar', query({ filters: { period: { from: '2026-01-01', to: '' } } }))).toBe(
      'Choose the start and end of the period.'
    );
    expect(queryProblem('bar', query({ filters: { period: { from: '2026-01-01', to: '2026-03-31' } } }))).toBeNull();
    expect(queryProblem('table', { measure: 'booked_days' })).toBeNull();
  });
});

describe('cleanQuery', () => {
  it('keeps only what is set', () => {
    expect(cleanQuery(query())).toEqual({ measure: 'booked_weeks', filters: { period: { relative: 'this_year' } } });
    expect(cleanQuery({ measure: 'booked_days' })).toEqual({
      measure: 'booked_days',
      filters: { period: { relative: 'this_year' } },
    });
  });

  it('keeps the filters, dimensions, percentage and Top N that are set', () => {
    const q = cleanQuery(
      query({
        dimensions: [{ kind: 'field', field_id: 4 }],
        percent_of: 'total',
        top_n: 10,
        filters: {
          site_ids: [1],
          team_ids: [],
          project_team_ids: [3],
          person_ids: [5],
          project_ids: [],
          tag_ids: [7],
          field_options: { '4': [41], '5': [] },
          confirmed: false,
          archived: 'include',
          period: { relative: 'all' },
        },
      })
    );
    expect(q).toEqual({
      measure: 'booked_weeks',
      dimensions: [{ kind: 'field', field_id: 4 }],
      percent_of: 'total',
      top_n: 10,
      filters: {
        site_ids: [1],
        project_team_ids: [3],
        person_ids: [5],
        tag_ids: [7],
        field_options: { '4': [41] },
        confirmed: false,
        archived: 'include',
        period: { relative: 'all' },
      },
    });
    expect(cleanQuery(query({ filters: { archived: 'exclude', confirmed: null } })).filters).toEqual({
      period: { relative: 'this_year' },
    });
  });

  it('counts the filters set besides the period', () => {
    expect(activeFilterCount(undefined)).toBe(0);
    expect(activeFilterCount({ period: { relative: 'all' } })).toBe(0);
    expect(
      activeFilterCount({
        site_ids: [1],
        team_ids: [],
        field_options: { '4': [1], '5': [] },
        confirmed: true,
        archived: 'only',
      })
    ).toBe(4);
    expect(activeFilterCount({ archived: 'exclude', confirmed: null })).toBe(0);
  });
});

describe('placement and ids', () => {
  const at = (y: number, h: number) => ({
    layout: { lg: { x: 0, y, w: 6, h }, md: { x: 0, y: y + 1, w: 4, h }, sm: { x: 0, y: y + 2, w: 4, h } },
  });

  it('places a new chart under every widget at 6 × 5 / 4 × 5 / 4 × 5', () => {
    expect(placeNewWidget('bar', [])).toEqual({
      lg: { x: 0, y: 0, w: 6, h: 5 },
      md: { x: 0, y: 0, w: 4, h: 5 },
      sm: { x: 0, y: 0, w: 4, h: 5 },
    });
    expect(placeNewWidget('line', [at(0, 2), at(2, 5)])).toEqual({
      lg: { x: 0, y: 7, w: 6, h: 5 },
      md: { x: 0, y: 8, w: 4, h: 5 },
      sm: { x: 0, y: 9, w: 4, h: 5 },
    });
  });

  it('places a new KPI at 3 × 2 / 4 × 2 / 4 × 2', () => {
    expect(placeNewWidget('kpi', [at(0, 2)])).toEqual({
      lg: { x: 0, y: 2, w: 3, h: 2 },
      md: { x: 0, y: 3, w: 4, h: 2 },
      sm: { x: 0, y: 4, w: 4, h: 2 },
    });
  });

  it('gives saved widgets their id and new ones a negative grid id', () => {
    const saved = toDraftWidget({
      id: 12,
      kind: 'bar',
      title: 'T',
      query: query(),
      options: {},
      layout: at(0, 2).layout,
      sort_order: 0,
    });
    expect(saved.clientId).toBe('w12');
    expect(gridIdOf(saved)).toBe(12);
    const a = newClientId();
    const b = newClientId();
    expect(a).not.toBe(b);
    expect(gridIdOf({ ...saved, id: undefined, clientId: a })).toBe(-Number(a.slice(1)));
  });

  it('compares layouts and drafts whatever the key order', () => {
    const a = at(0, 2).layout;
    expect(sameLayout(a, { ...a, lg: { h: 2, w: 6, y: 0, x: 0 } })).toBe(true);
    expect(sameLayout(a, { ...a, sm: { ...a.sm, x: 1 } })).toBe(false);
    expect(stableKey({ b: 1, a: { d: [2, 1], c: null } })).toBe(stableKey({ a: { c: null, d: [2, 1] }, b: 1 }));
    expect(
      comparableDraft({
        name: 'N',
        description: undefined as unknown as null,
        visibility: 'shared',
        role_ids: [3, 1],
        site_ids: [9, 2],
        team_ids: [5, 4],
        user_ids: [7, 6],
        widgets: [],
      })
    ).toEqual({
      name: 'N',
      description: null,
      visibility: 'shared',
      role_ids: [1, 3],
      site_ids: [2, 9],
      team_ids: [4, 5],
      user_ids: [6, 7],
      widgets: [],
    });
  });

  it('sends the targets only for a shared dashboard, as copies', () => {
    const meta = { visibility: 'shared' as const, role_ids: [1], site_ids: [2], team_ids: [3], user_ids: [4] };
    const sent = savedTargets(meta);
    expect(sent).toEqual({ role_ids: [1], site_ids: [2], team_ids: [3], user_ids: [4] });
    expect(sent.site_ids).not.toBe(meta.site_ids);
    expect(savedTargets({ ...meta, visibility: 'everyone' })).toEqual({
      role_ids: [],
      site_ids: [],
      team_ids: [],
      user_ids: [],
    });
    expect(savedTargets({ ...meta, visibility: 'private' }).user_ids).toEqual([]);
    expect(TARGET_KEYS).toEqual(['role_ids', 'site_ids', 'team_ids', 'user_ids']);
  });

  it('identifies a dimension for the pickers', () => {
    expect(dimensionKey({ kind: 'field', field_id: 4 })).toBe('field:4');
    expect(dimensionKey({ kind: 'period', grain: 'week' })).toBe('period');
    expect(dimensionKey({ kind: 'site' })).toBe('site');
  });
});
