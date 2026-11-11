/**
 * The builder's pure rules: kind rules on dimensions, percentages and Top N,
 * a measure change dropping refused dimensions, options per kind, the
 * client-side problems, the cleaned query, the filter count, the placement
 * of a new widget, grid ids and the key-order-free comparison. The gauge,
 * heatmap, treemap and sankey rules: dimension counts, the period dropped off
 * a treemap or sankey, the ratio refusal, the gauge target and size.
 */
import { describe, it, expect } from 'vitest';
import type { MetricFormula, MetricQuery, WidgetKind } from '@/types';
import {
  activeFilterCount,
  changeMeasure,
  cleanOptions,
  cleanQuery,
  comparableDraft,
  defaultQuery,
  dimensionKey,
  dropUnheld,
  gridIdOf,
  kpiWithoutDimension,
  MAX_DIMENSIONS,
  MIN_DIMENSIONS,
  NEGATIVE_PIE_PROBLEM,
  NEW_GAUGE_SIZE,
  newClientId,
  noDimensionKind,
  normaliseQuery,
  offersFormula,
  normaliseFormula,
  startFormula,
  endFormula,
  isDefaultFormula,
  exampleFormula,
  addTerm,
  cleanFormula,
  formulaHeld,
  FORMULA_EXAMPLES,
  parseTarget,
  placeNewWidget,
  queryProblem,
  RATIO_HIERARCHY_PROBLEM,
  FORMULA_KINDS,
  SUMMED_KINDS,
  sameLayout,
  savedTargets,
  stableKey,
  TARGET_KEYS,
  TARGET_KINDS,
  toDraftWidget,
} from '../widgetDraft';

const query = (extra: Partial<MetricQuery> = {}): MetricQuery => ({ ...defaultQuery(), ...extra });

describe('kind rules', () => {
  it('caps the dimensions per kind', () => {
    expect(MAX_DIMENSIONS).toEqual({
      kpi: 1,
      pie: 1,
      bar: 2,
      line: 2,
      table: 2,
      gauge: 0,
      heatmap: 2,
      treemap: 2,
      sankey: 2,
    });
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

  it('drops the Teams and People filters off a measure that is not a booking', () => {
    const filters = { team_ids: [5], person_ids: [8], tag_ids: [40], period: { relative: 'this_year' as const } };
    const q = query({ filters });
    expect(changeMeasure('bar', q, 'project_weeks').filters).toEqual({ tag_ids: [40], period: { relative: 'this_year' } });
    expect(normaliseQuery('kpi', { ...q, measure: 'phase_count' }).filters).not.toHaveProperty('team_ids');
    expect(changeMeasure('bar', q, 'people_booked').filters).toEqual(filters);
    // Nothing to drop: the filters are kept as they are.
    const plain = query({ measure: 'project_count' });
    expect(normaliseQuery('bar', plain).filters).toBe(plain.filters);
  });

  it('drops the filters a measure of another family does not take', () => {
    const filters = {
      site_ids: [1],
      team_ids: [5],
      person_ids: [8],
      project_ids: [30],
      tag_ids: [40],
      confirmed: true,
      archived: 'include' as const,
      milestones: 'only' as const,
      equipment_ids: [70],
      equipment_types: ['HPLC'],
      period: { relative: 'next_quarter' as const },
    };
    const q = query({ measure: 'phase_count', filters });
    // Capacity: Sites, Teams, People, archived and the period only.
    expect(changeMeasure('bar', q, 'capacity_days').filters).toEqual({
      site_ids: [1],
      team_ids: [5],
      person_ids: [8],
      archived: 'include',
      period: { relative: 'next_quarter' },
    });
    // Utilisation also keeps the project filters (its booked side).
    expect(changeMeasure('bar', q, 'utilisation').filters).toEqual({
      site_ids: [1],
      team_ids: [5],
      person_ids: [8],
      project_ids: [30],
      tag_ids: [40],
      confirmed: true,
      archived: 'include',
      period: { relative: 'next_quarter' },
    });
    // Equipment utilisation: the equipment's sites, Equipment, Equipment types.
    expect(changeMeasure('bar', q, 'equipment_utilisation').filters).toEqual({
      site_ids: [1],
      archived: 'include',
      equipment_ids: [70],
      equipment_types: ['HPLC'],
      period: { relative: 'next_quarter' },
    });
    // An equipment booking takes the project filters too, never the milestones.
    expect(changeMeasure('bar', q, 'equipment_booked_days').filters).not.toHaveProperty('milestones');
    expect(changeMeasure('bar', q, 'equipment_booked_days').filters).toMatchObject({ project_ids: [30], tag_ids: [40] });
    // A phase measure keeps the milestones, drops the person and the equipment.
    expect(changeMeasure('bar', q, 'phases_overdue').filters).toEqual({
      site_ids: [1],
      project_ids: [30],
      tag_ids: [40],
      confirmed: true,
      archived: 'include',
      milestones: 'only',
      period: { relative: 'next_quarter' },
    });
  });

  it('gives a KPI of a measure that takes no percentage no dimension, and no percentage at all', () => {
    for (const measure of ['utilisation', 'available_days', 'people_over_capacity', 'equipment_utilisation'] as const) {
      const q = normaliseQuery('kpi', query({ measure, dimensions: [{ kind: 'site' }], percent_of: 'total' }));
      expect(q).toMatchObject({ measure, dimensions: [], percent_of: null, top_n: null });
      expect(kpiWithoutDimension('kpi', measure)).toBe(true);
      expect(kpiWithoutDimension('bar', measure)).toBe(false);
    }
    // Other measures keep the share of the total.
    expect(normaliseQuery('kpi', query({ measure: 'capacity_days', dimensions: [{ kind: 'team' }] })).percent_of).toBe('total');
    expect(kpiWithoutDimension('kpi', 'capacity_days')).toBe(false);
    // A chart of one keeps its dimensions, never a percentage.
    const bar = normaliseQuery(
      'bar',
      query({ measure: 'utilisation', dimensions: [{ kind: 'person' }, { kind: 'period', grain: 'month' }], percent_of: 'first_dimension' })
    );
    expect(bar).toMatchObject({ dimensions: [{ kind: 'person' }, { kind: 'period', grain: 'month' }], percent_of: null });
    // A switch to a dimensionless KPI measure drops the dimension and the share.
    const kpi = normaliseQuery('kpi', query({ dimensions: [{ kind: 'site' }] }));
    expect(kpi.percent_of).toBe('total');
    expect(changeMeasure('kpi', kpi, 'utilisation')).toMatchObject({ dimensions: [], percent_of: null });
  });

  it('drops the dimensions and filters the user may not use on the measure', () => {
    const staffOnly = (key: string | null) => key === null || key === 'views.staff';
    const byPerson = query({
      measure: 'utilisation',
      dimensions: [{ kind: 'team' }, { kind: 'person' }],
      filters: { person_ids: [8], team_ids: [5], period: { relative: 'this_year' } },
    });
    // Capacity per person needs absences.view_others.
    expect(dropUnheld(byPerson, staffOnly)).toMatchObject({
      dimensions: [{ kind: 'team' }],
      filters: { team_ids: [5], period: { relative: 'this_year' } },
    });
    expect(dropUnheld(byPerson, staffOnly).filters).not.toHaveProperty('person_ids');
    // Nothing to drop: the same query back.
    const all = () => true;
    expect(dropUnheld(byPerson, all)).toBe(byPerson);
    const booking = query({ dimensions: [{ kind: 'person' }], filters: { person_ids: [8] } });
    expect(dropUnheld(booking, staffOnly)).toBe(booking);
    expect(dropUnheld(query({ dimensions: undefined, filters: undefined }), staffOnly)).toMatchObject({ measure: 'booked_weeks' });
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
    // No stack of a measure that takes no percentage (ratios, signed days, per-bucket counts).
    for (const measure of ['utilisation', 'available_days', 'people_over_capacity', 'equipment_utilisation'] as const) {
      expect(cleanOptions('bar', query({ measure }), { stacked: true, percent: true, orientation: 'horizontal' })).toEqual({
        orientation: 'horizontal',
      });
    }
    expect(cleanOptions('bar', query({ measure: 'capacity_days' }), { stacked: true })).toEqual({ stacked: true });
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
    // Available days can be negative: never a pie, whatever its dimensions.
    expect(queryProblem('pie', query({ measure: 'available_days', dimensions: [{ kind: 'team' }] }))).toBe(
      NEGATIVE_PIE_PROBLEM
    );
    expect(NEGATIVE_PIE_PROBLEM).toBe('Available days can be negative; choose a bar, line, table or KPI');
    expect(queryProblem('bar', query({ measure: 'available_days', dimensions: [{ kind: 'team' }] }))).toBeNull();
    expect(queryProblem('pie', query({ measure: 'utilisation', dimensions: [{ kind: 'team' }] }))).toBeNull();
  });
});

describe('gauge, heatmap, treemap and sankey rules', () => {
  const RATIOS = ['utilisation', 'available_days', 'people_over_capacity', 'equipment_utilisation'] as const;
  const month = { kind: 'period' as const, grain: 'month' as const };

  it('sets the fewest and the most dimensions per kind', () => {
    expect(MIN_DIMENSIONS).toEqual({
      kpi: 0,
      pie: 0,
      bar: 0,
      line: 0,
      table: 0,
      gauge: 0,
      heatmap: 2,
      treemap: 1,
      sankey: 2,
    });
    for (const kind of Object.keys(MAX_DIMENSIONS) as WidgetKind[]) {
      expect(MIN_DIMENSIONS[kind]).toBeLessThanOrEqual(MAX_DIMENSIONS[kind]);
    }
    expect([...SUMMED_KINDS].sort()).toEqual(['sankey', 'treemap']);
  });

  it('gives a gauge no dimension, whatever the measure, and a KPI none only on a ratio', () => {
    expect(noDimensionKind('gauge', 'booked_weeks')).toBe(true);
    expect(noDimensionKind('gauge', 'utilisation')).toBe(true);
    expect(noDimensionKind('kpi', 'utilisation')).toBe(true);
    expect(noDimensionKind('kpi', 'booked_weeks')).toBe(false);
    for (const kind of ['bar', 'line', 'pie', 'table', 'heatmap', 'treemap', 'sankey'] as const) {
      expect(noDimensionKind(kind, 'utilisation')).toBe(false);
    }
    // The former name is the same rule.
    expect(kpiWithoutDimension).toBe(noDimensionKind);
  });

  it('drops every dimension, the percentage and Top N on a gauge; a switch back keeps them dropped', () => {
    const two = query({ dimensions: [{ kind: 'project' }, { kind: 'team' }], percent_of: 'first_dimension', top_n: 5 });
    const gauge = normaliseQuery('gauge', two);
    expect(gauge).toMatchObject({ dimensions: [], percent_of: null, top_n: null });
    expect(normaliseQuery('bar', gauge).dimensions).toEqual([]);
    expect(normaliseQuery('gauge', query({ measure: 'utilisation', dimensions: [{ kind: 'team' }] })).dimensions).toEqual([]);
  });

  it('drops a period dimension on a treemap or a sankey, and keeps it on a heatmap', () => {
    const q = query({ dimensions: [month, { kind: 'team' }] });
    expect(normaliseQuery('treemap', q).dimensions).toEqual([{ kind: 'team' }]);
    expect(normaliseQuery('sankey', q).dimensions).toEqual([{ kind: 'team' }]);
    expect(normaliseQuery('sankey', query({ dimensions: [{ kind: 'team' }, month] })).dimensions).toEqual([{ kind: 'team' }]);
    expect(normaliseQuery('heatmap', q).dimensions).toEqual([month, { kind: 'team' }]);
    expect(normaliseQuery('bar', q).dimensions).toEqual([month, { kind: 'team' }]);
    // A percentage of the first dimension needs the second one still there.
    expect(normaliseQuery('treemap', { ...q, percent_of: 'first_dimension' }).percent_of).toBeNull();
    // A share within each first-dimension value would draw every parent the same
    // size: a treemap or a sankey keeps a share of the total only.
    const two = query({ dimensions: [{ kind: 'site' }, { kind: 'project' }], percent_of: 'first_dimension', top_n: 3 });
    expect(normaliseQuery('treemap', two)).toMatchObject({ percent_of: null, top_n: 3 });
    expect(normaliseQuery('sankey', two)).toMatchObject({ percent_of: null, top_n: 3 });
    expect(normaliseQuery('treemap', { ...two, percent_of: 'total' }).percent_of).toBe('total');
    expect(normaliseQuery('sankey', { ...two, percent_of: 'total' }).percent_of).toBe('total');
    expect(normaliseQuery('heatmap', two).percent_of).toBe('first_dimension');
    expect(normaliseQuery('bar', two).percent_of).toBe('first_dimension');
  });

  it('refuses a treemap or a sankey of a ratio measure before counting its dimensions', () => {
    expect(RATIO_HIERARCHY_PROBLEM).toBe(
      'Utilisation, available days and people over capacity cannot be added up into boxes or flows; choose a bar, line, heatmap, table or KPI'
    );
    for (const measure of RATIOS) {
      expect(queryProblem('treemap', query({ measure }))).toBe(RATIO_HIERARCHY_PROBLEM);
      expect(queryProblem('sankey', query({ measure, dimensions: [{ kind: 'site' }, { kind: 'team' }] }))).toBe(
        RATIO_HIERARCHY_PROBLEM
      );
      // A heatmap and a gauge of a ratio are fine.
      expect(queryProblem('heatmap', query({ measure, dimensions: [{ kind: 'site' }, month] }))).toBeNull();
      expect(queryProblem('gauge', query({ measure }))).toBeNull();
    }
  });

  it('names the dimensions a heatmap, a sankey and a treemap still need', () => {
    expect(queryProblem('heatmap', query())).toBe('A heatmap needs two dimensions.');
    expect(queryProblem('heatmap', query({ dimensions: [{ kind: 'team' }] }))).toBe('A heatmap needs two dimensions.');
    expect(queryProblem('heatmap', query({ dimensions: [{ kind: 'team' }, month] }))).toBeNull();
    expect(queryProblem('sankey', query({ dimensions: [{ kind: 'team' }] }))).toBe('A sankey needs two dimensions.');
    expect(queryProblem('sankey', query({ dimensions: [{ kind: 'team' }, { kind: 'project' }] }))).toBeNull();
    expect(queryProblem('treemap', { measure: 'booked_days' })).toBe('A treemap needs one or two dimensions.');
    expect(queryProblem('treemap', query({ dimensions: [{ kind: 'site' }] }))).toBeNull();
    expect(queryProblem('treemap', query({ dimensions: [{ kind: 'site' }, { kind: 'project' }] }))).toBeNull();
    expect(queryProblem('gauge', query())).toBeNull();
    // The dimensions come before the period's ends; the pie rules stay first.
    expect(queryProblem('heatmap', query({ filters: { period: { from: '', to: '' } } }))).toBe('A heatmap needs two dimensions.');
    expect(queryProblem('pie', query({ measure: 'available_days' }))).toBe(NEGATIVE_PIE_PROBLEM);
    expect(queryProblem('pie', query())).toBe('A pie chart needs one dimension.');
  });

  it('keeps a gauge target that is finite and not negative, and only on a gauge', () => {
    expect(cleanOptions('gauge', query(), { target: 85 })).toEqual({ target: 85 });
    expect(cleanOptions('gauge', query(), { target: 0 })).toEqual({ target: 0 });
    expect(cleanOptions('gauge', query(), { target: 12.5, number_format: 'decimal' })).toEqual({
      target: 12.5,
      number_format: 'decimal',
    });
    for (const target of [-5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, 2e9, 1_000_000_001]) {
      expect(cleanOptions('gauge', query(), { target })).toEqual({});
    }
    expect(cleanOptions('gauge', query(), { target: '85' as unknown as number })).toEqual({});
    // A KPI keeps a target too (2.6.0); the other kinds drop it.
    expect(cleanOptions('kpi', query(), { target: 85 })).toEqual({ target: 85 });
    for (const kind of ['bar', 'line', 'pie', 'table', 'heatmap', 'treemap', 'sankey'] as const) {
      expect(cleanOptions(kind, query(), { target: 85 })).not.toHaveProperty('target');
    }
    // A gauge takes no bar, line or pie option.
    expect(cleanOptions('gauge', query(), { stacked: true, percent: true, orientation: 'horizontal', show_legend: true })).toEqual(
      {}
    );
    expect(cleanOptions('heatmap', query(), { number_format: 'integer', stacked: true })).toEqual({ number_format: 'integer' });
  });

  it('reads a typed target only as a plain decimal number from 0 to 1e9', () => {
    expect(parseTarget('85')).toBe(85);
    expect(parseTarget(' 85 ')).toBe(85);
    expect(parseTarget('12,5')).toBe(12.5);
    expect(parseTarget('12.5')).toBe(12.5);
    expect(parseTarget('.5')).toBe(0.5);
    expect(parseTarget('0')).toBe(0);
    expect(parseTarget('1000000000')).toBe(1_000_000_000);
    for (const text of ['', '  ', '-5', 'abc', '85x', '2000000000', '1e3', '0x10', '1,2,3', 'Infinity']) {
      expect(parseTarget(text)).toBeNull();
    }
  });

  it('places a new gauge at 3 × 4 / 4 × 4 / 4 × 4, the other new kinds at the chart size', () => {
    expect(NEW_GAUGE_SIZE).toEqual({ lg: { w: 3, h: 4 }, md: { w: 4, h: 4 }, sm: { w: 4, h: 4 } });
    const above = { layout: { lg: { x: 0, y: 0, w: 6, h: 2 }, md: { x: 0, y: 0, w: 4, h: 3 }, sm: { x: 0, y: 0, w: 4, h: 4 } } };
    expect(placeNewWidget('gauge', [above])).toEqual({
      lg: { x: 0, y: 2, w: 3, h: 4 },
      md: { x: 0, y: 3, w: 4, h: 4 },
      sm: { x: 0, y: 4, w: 4, h: 4 },
    });
    for (const kind of ['heatmap', 'treemap', 'sankey'] as const) {
      expect(placeNewWidget(kind, [])).toEqual(placeNewWidget('bar', []));
    }
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

  it('keeps the equipment filters and a milestones mode, never the default `include`', () => {
    const q = cleanQuery(
      query({
        measure: 'equipment_booked_days',
        filters: { equipment_ids: [70, 71], equipment_types: ['HPLC'], period: { relative: 'next_12_months' } },
      })
    );
    expect(q.filters).toEqual({ equipment_ids: [70, 71], equipment_types: ['HPLC'], period: { relative: 'next_12_months' } });
    expect(cleanQuery(query({ filters: { equipment_ids: [], equipment_types: [] } })).filters).toEqual({
      period: { relative: 'this_year' },
    });
    expect(cleanQuery(query({ measure: 'phase_count', filters: { milestones: 'include' } })).filters).toEqual({
      period: { relative: 'this_year' },
    });
    expect(cleanQuery(query({ measure: 'phase_count', filters: { milestones: 'exclude' } })).filters).toEqual({
      milestones: 'exclude',
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
    expect(activeFilterCount({ equipment_ids: [1], equipment_types: ['HPLC'], milestones: 'only' })).toBe(3);
    expect(activeFilterCount({ equipment_ids: [], equipment_types: [], milestones: 'include' })).toBe(0);
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


describe('calculated widgets and % of target (2.6.0)', () => {
  const MONTH = { kind: 'period' as const, grain: 'month' as const };
  const calc = (extra: Partial<MetricQuery> = {}, formula: Partial<MetricFormula> = {}): MetricQuery =>
    query({
      measure: 'booked_weeks',
      filters: { period: { relative: 'this_year' } },
      formula: {
        expression: 'a / b',
        terms: [
          { name: 'a', measure: 'booked_weeks' },
          { name: 'b', measure: 'capacity_weeks' },
        ],
        ...formula,
      },
      ...extra,
    });

  it('offers a calculation on every kind whose values need not add up', () => {
    expect([...FORMULA_KINDS].sort()).toEqual(['bar', 'gauge', 'heatmap', 'kpi', 'line', 'table']);
    expect([...TARGET_KINDS].sort()).toEqual(['gauge', 'kpi']);
    expect(offersFormula('table')).toBe(true);
    expect(offersFormula('pie')).toBe(false);
    expect(offersFormula('sankey')).toBe(false);
  });

  it('keeps a dimension one term accepts, the period only when all do, and forces refusing terms to their total', () => {
    // Project: booked weeks accept it, capacity weeks do not (it uses its total).
    const q = normaliseQuery('bar', calc({ dimensions: [{ kind: 'project' }, MONTH], percent_of: 'total', top_n: 3 }));
    expect(q.dimensions).toEqual([{ kind: 'project' }, MONTH]);
    expect(q.percent_of).toBeNull();
    expect(q.top_n).toBe(3);
    expect(q.formula?.terms).toEqual([
      { name: 'a', measure: 'booked_weeks', filters: {} },
      { name: 'b', measure: 'capacity_weeks', filters: {}, total: true },
    ]);
    // Equipment: no term accepts it.
    expect(normaliseQuery('bar', calc({ dimensions: [{ kind: 'equipment' }] })).dimensions).toEqual([]);
    // A period a term refuses goes (project volume has none).
    const volume = calc({ dimensions: [MONTH] }, { terms: [{ name: 'a', measure: 'booked_weeks' }, { name: 'b', measure: 'project_volume' }] });
    expect(normaliseQuery('line', volume).dimensions).toEqual([]);
    // Top N needs a first dimension that is not a period.
    expect(normaliseQuery('bar', calc({ dimensions: [MONTH], top_n: 3 })).top_n).toBeNull();
  });

  it('has no dimension on a KPI or a gauge, and no total flag without a breakdown beyond the period', () => {
    const totalled = calc({ dimensions: [MONTH] }, {
      terms: [
        { name: 'a', measure: 'booked_weeks', total: true },
        { name: 'b', measure: 'capacity_weeks' },
      ],
    });
    expect(normaliseQuery('kpi', totalled).dimensions).toEqual([]);
    expect(normaliseQuery('gauge', totalled).dimensions).toEqual([]);
    expect(normaliseQuery('line', totalled).formula?.terms[0]).not.toHaveProperty('total');
    expect(noDimensionKind('kpi', 'booked_days', true)).toBe(true);
    expect(noDimensionKind('bar', 'booked_days', true)).toBe(false);
    // A term the user marked keeps its total while a breakdown is set.
    const byTeam = normaliseQuery('table', { ...totalled, dimensions: [{ kind: 'team' }] });
    expect(byTeam.formula?.terms[0].total).toBe(true);
  });

  it('takes the measure from the first term and keeps only the period on top; terms keep the filters they take', () => {
    const q = calc(
      { measure: 'project_count', filters: { period: { relative: 'all' }, team_ids: [1] } },
      {
        terms: [
          { name: 'a', measure: 'booked_days', filters: { team_ids: [5], equipment_ids: [9], period: { relative: 'all' } } as never },
          { name: 'b', measure: 'capacity_days', filters: { project_ids: [30], person_ids: [8] } },
        ],
      }
    );
    const n = normaliseQuery('kpi', q);
    expect(n.measure).toBe('booked_days');
    expect(n.filters).toEqual({ period: { relative: 'all' } });
    expect(n.formula?.terms.map((t) => t.filters)).toEqual([{ team_ids: [5] }, { person_ids: [8] }]);
    expect(normaliseFormula('kpi', query())).toBeNull();
    expect(normaliseFormula('pie', q)).toBeNull();
    expect(normaliseFormula('kpi', calc({}, { terms: [] }))).toBeNull();
  });

  it('turns into the plain widget of the first term on a kind that offers no calculation', () => {
    const q = calc({ dimensions: [{ kind: 'site' }] }, {
      terms: [
        { name: 'a', measure: 'booked_days', filters: { team_ids: [5] } },
        { name: 'b', measure: 'capacity_days' },
      ],
    });
    const pie = normaliseQuery('pie', q);
    expect(pie).not.toHaveProperty('formula');
    expect(pie.measure).toBe('booked_days');
    expect(pie.filters).toEqual({ team_ids: [5], period: { relative: 'this_year' } });
  });

  it('starts a calculation with nothing to type', () => {
    const plain = query({ measure: 'booked_weeks', filters: { period: { relative: 'last_year' }, has_customer: true } });
    const started = startFormula('gauge', plain, true);
    expect(started.measure).toBe('booked_weeks');
    expect(started.filters).toEqual({ period: { relative: 'last_year' } });
    expect(started.formula).toEqual({
      expression: 'a / b',
      result: 'percent',
      terms: [
        { name: 'a', measure: 'booked_weeks', filters: { has_customer: true } },
        { name: 'b', measure: 'capacity_weeks', filters: {} },
      ],
    });
    // Booked days pair with capacity days; without views.staff, or for another measure, b repeats a.
    expect(startFormula('bar', query({ measure: 'booked_days' }), true).formula?.terms[1].measure).toBe('capacity_days');
    expect(startFormula('bar', plain, false).formula?.terms[1].measure).toBe('booked_weeks');
    expect(startFormula('bar', query({ measure: 'project_count' }), true).formula?.terms[1].measure).toBe('project_count');
    // Utilisation is booked days over capacity days; another ratio starts from booked weeks.
    expect(startFormula('bar', query({ measure: 'utilisation' }), true).formula?.terms.map((t) => t.measure)).toEqual([
      'booked_days',
      'capacity_days',
    ]);
    expect(startFormula('bar', query({ measure: 'available_days' }), true).formula?.terms[0].measure).toBe('booked_weeks');
  });

  it('goes back to the plain widget of term a, and knows an untouched calculation', () => {
    const started = startFormula('bar', query({ measure: 'booked_weeks', filters: { has_customer: true } }), true);
    expect(isDefaultFormula(started, true)).toBe(true);
    const back = endFormula(started);
    expect(back).not.toHaveProperty('formula');
    expect(back.filters).toEqual({ has_customer: true });
    expect(endFormula({ ...started, filters: { period: { relative: 'all' } } }).filters).toEqual({
      has_customer: true,
      period: { relative: 'all' },
    });
    expect(endFormula(query())).toEqual(query());
    expect(endFormula(calc({ filters: {} }, { terms: [] })).measure).toBe('booked_weeks');
    // Any change counts: the expression, a term's measure or filters, a third term, the result.
    expect(isDefaultFormula({ ...started, formula: { ...started.formula!, expression: 'a / b * 2' } }, true)).toBe(false);
    expect(isDefaultFormula({ ...started, formula: addTerm(started.formula!, 'c') }, true)).toBe(false);
    expect(isDefaultFormula({ ...started, formula: { ...started.formula!, result: 'number' } }, true)).toBe(false);
    expect(isDefaultFormula(query(), true)).toBe(true);
  });

  it('builds each example on the current terms', () => {
    const current = calc({}, {
      expression: 'a * 2',
      terms: [
        { name: 'a', measure: 'booked_days', filters: { team_ids: [5] } },
        { name: 'x', measure: 'project_count' },
      ],
    });
    expect(FORMULA_EXAMPLES.map((e) => e.label)).toEqual([
      'Ratio of two measures',
      'Share of capacity',
      'Against a goal',
      'Difference',
      'Sum',
    ]);
    const ratio = exampleFormula('bar', current, 'ratio', true).formula!;
    expect(ratio.expression).toBe('a / b');
    expect(ratio.terms.map((t) => [t.name, t.measure])).toEqual([
      ['a', 'booked_days'],
      ['b', 'project_count'],
    ]);
    const goal = exampleFormula('gauge', current, 'goal', true);
    expect(goal.measure).toBe('booked_weeks');
    expect(goal.formula).toEqual({
      expression: 'a / (b * 70%)',
      result: 'percent',
      terms: [
        { name: 'a', measure: 'booked_weeks', filters: { team_ids: [5], has_customer: true } },
        { name: 'b', measure: 'capacity_weeks', filters: {} },
      ],
    });
    expect(exampleFormula('bar', current, 'capacity_share', true).formula?.terms[0].filters).toEqual({ team_ids: [5] });
    expect(exampleFormula('bar', current, 'difference', true).formula).toMatchObject({ expression: 'a - b', result: 'number' });
    expect(exampleFormula('bar', current, 'sum', true).formula).toMatchObject({ expression: 'a + b', result: 'number' });
    // From a plain query: term a is its measure, b its partner.
    const fromPlain = exampleFormula('bar', query({ measure: 'booked_days' }), 'sum', true).formula!;
    expect(fromPlain.terms.map((t) => t.measure)).toEqual(['booked_days', 'capacity_days']);
    expect(exampleFormula('bar', current, 'nope' as never, true).formula?.expression).toBe('a / b');
  });

  it('adds a term and tells whether every measure is held', () => {
    const f = calc().formula!;
    expect(addTerm(f, 'c').terms[2]).toEqual({ name: 'c', measure: 'booked_weeks', filters: {} });
    expect(addTerm({ expression: '', terms: [] }, 'a').terms[0].measure).toBe('booked_weeks');
    expect(formulaHeld(f, () => true)).toBe(true);
    expect(formulaHeld(f, (key) => key === null)).toBe(false);
  });

  it('stores the formula cleaned: empty filters, unset totals and the default result left out', () => {
    expect(cleanQuery(calc()).formula).toEqual({
      expression: 'a / b',
      terms: [
        { name: 'a', measure: 'booked_weeks' },
        { name: 'b', measure: 'capacity_weeks' },
      ],
    });
    expect(
      cleanFormula({
        expression: 'a',
        result: 'number',
        terms: [{ name: 'a', measure: 'booked_days', filters: { tag_ids: [], has_customer: true, archived: 'exclude' }, total: true }],
      })
    ).toEqual({
      expression: 'a',
      result: 'number',
      terms: [{ name: 'a', measure: 'booked_days', filters: { has_customer: true }, total: true }],
    });
    expect(cleanQuery(query({ filters: { has_customer: false } })).filters).toEqual({
      has_customer: false,
      period: { relative: 'this_year' },
    });
    expect(activeFilterCount({ has_customer: false })).toBe(1);
    expect(activeFilterCount({ has_customer: null })).toBe(0);
  });

  it("drops each term's filters the user may not use", () => {
    const q = calc({}, {
      terms: [
        { name: 'a', measure: 'booked_weeks', filters: { equipment_ids: [2] } },
        { name: 'b', measure: 'capacity_days', filters: { person_ids: [8], team_ids: [5] } },
      ],
    });
    const staffOnly = (key: string | null) => key === null || key === 'views.staff';
    // Equipment needs views.equipment, People on capacity absences.view_others.
    expect(dropUnheld(q, staffOnly).formula?.terms.map((t) => t.filters)).toEqual([{}, { team_ids: [5] }]);
    const all = () => true;
    expect(dropUnheld(q, all)).toBe(q);
  });

  it('never stacks a calculated bar', () => {
    expect(cleanOptions('bar', calc(), { stacked: true, percent: true })).toEqual({});
  });

  it('keeps % of target on a gauge or a KPI with a target above 0 only', () => {
    expect(cleanOptions('gauge', query(), { target: 70, percent_of_target: true })).toEqual({
      target: 70,
      percent_of_target: true,
    });
    expect(cleanOptions('kpi', query(), { target: 0, percent_of_target: true })).toEqual({ target: 0 });
    expect(cleanOptions('kpi', query(), { percent_of_target: true })).toEqual({});
    expect(cleanOptions('bar', query(), { target: 70, percent_of_target: true })).toEqual({});
    // Shown as a percentage, the Percent number format is kept.
    expect(cleanOptions('kpi', query(), { target: 70, percent_of_target: true, number_format: 'percent' })).toEqual({
      target: 70,
      percent_of_target: true,
      number_format: 'percent',
    });
    expect(cleanOptions('kpi', query(), { target: 70, number_format: 'percent' })).toEqual({ target: 70 });
  });
});


describe('target is a goal (2.6.0)', () => {
  it('is kept on a gauge with a target above 0 only', () => {
    expect(cleanOptions('gauge', query(), { target: 70, target_is_goal: true })).toEqual({ target: 70, target_is_goal: true });
    expect(cleanOptions('gauge', query(), { target: 0, target_is_goal: true })).toEqual({ target: 0 });
    expect(cleanOptions('gauge', query(), { target_is_goal: true })).toEqual({});
    expect(cleanOptions('kpi', query(), { target: 70, target_is_goal: true })).toEqual({ target: 70 });
    expect(cleanOptions('bar', query(), { target: 70, target_is_goal: true })).toEqual({});
  });
});
