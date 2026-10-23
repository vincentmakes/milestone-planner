/**
 * toOption: a metric result → an ECharts option per kind. Category axis from
 * the first dimension in server order (never a time axis), series from the
 * second with missing points as 0, stacked / 100 %, horizontal bars, pie
 * slices, colours (own, palette, "Other" muted), legend and tooltip values.
 */
import { describe, it, expect } from 'vitest';
import { toOption } from '../toOption';
import type { ChartTheme } from '../echartsTheme';
import type { MetricKey, MetricResult, MetricRow } from '@/types';

const theme: ChartTheme = { palette: ['p0', 'p1', 'p2'], textMuted: 'muted', textSecondary: 'secondary' };

const k = (key: MetricKey['key'], label: string, color?: string): MetricKey => ({ key, label, ...(color ? { color } : {}) });
const row = (keys: MetricKey[], value: number): MetricRow => ({ keys, value });

function result(rows: MetricRow[], dims: number, extra: Partial<MetricResult> = {}): MetricResult {
  const kinds = ['team', 'confirmed'] as const;
  return {
    unit: 'weeks',
    dimensions: kinds.slice(0, dims).map((kind) => ({ kind, label: kind })),
    rows,
    total: rows.reduce((sum, r) => sum + r.value, 0),
    truncated: false,
    warnings: [],
    ...extra,
  };
}

type AnyOption = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const A = k(1, 'Alpha');
const B = k(2, 'Beta');
const yes = k(true, 'Confirmed');
const no = k(false, 'Not confirmed');

describe('toOption — bar and line, one dimension', () => {
  const single = result([row([A], 3), row([B], 5)], 1);

  it('puts the first dimension on a category axis, one series, one colour', () => {
    const option = toOption('bar', single, {}, theme) as AnyOption;
    expect(option.xAxis).toMatchObject({ type: 'category', data: ['Alpha', 'Beta'] });
    expect(option.yAxis).toMatchObject({ type: 'value' });
    expect(option.series).toHaveLength(1);
    expect(option.series[0]).toMatchObject({ type: 'bar', name: 'weeks', data: [3, 5], itemStyle: { color: 'p0' } });
    expect(option.legend).toEqual({ show: false });
    expect(option.aria).toEqual({ show: true, decal: { show: true } });
  });

  it('colours each bar by the value’s own colour when values have one', () => {
    const coloured = result([row([k(1, 'Team A', '#aaa')], 3), row([k(2, 'Team B')], 5)], 1);
    const option = toOption('bar', coloured, {}, theme) as AnyOption;
    expect(option.series[0].data).toEqual([
      { value: 3, itemStyle: { color: '#aaa' } },
      { value: 5, itemStyle: { color: 'p1' } },
    ]);
  });

  it('swaps the axes for horizontal bars, first category on top', () => {
    const option = toOption('bar', single, { orientation: 'horizontal' }, theme) as AnyOption;
    expect(option.xAxis).toMatchObject({ type: 'value' });
    expect(option.yAxis).toMatchObject({ type: 'category', inverse: true, data: ['Alpha', 'Beta'] });
  });

  it('draws a line on a category axis without a gap at the ends', () => {
    const months = result([row([k('2026-01', 'Jan 2026')], 1), row([k('2026-02', 'Feb 2026')], 2)], 1);
    const option = toOption('line', months, null, theme) as AnyOption;
    expect(option.xAxis).toMatchObject({ type: 'category', boundaryGap: false, data: ['Jan 2026', 'Feb 2026'] });
    expect(option.series[0]).toMatchObject({ type: 'line', data: [1, 2], lineStyle: { color: 'p0' }, showSymbol: true });
    expect(option.tooltip).toMatchObject({ trigger: 'axis', axisPointer: { type: 'line' } });
  });

  it('formats tooltip values with the unit and the number format', () => {
    const option = toOption('bar', single, { number_format: 'integer' }, theme) as AnyOption;
    expect(option.tooltip.valueFormatter(12.4)).toBe('12');
    expect(toOption('bar', single, {}, theme).tooltip).toBeDefined();
    expect((toOption('bar', single, {}, theme) as AnyOption).tooltip.valueFormatter(12.4)).toBe('12.4');
  });

  it('labels value-axis ticks compactly', () => {
    const option = toOption('bar', single, {}, theme) as AnyOption;
    expect(option.yAxis.axisLabel.formatter(10)).toBe('10');
    expect(option.yAxis.axisLabel.formatter(2.5)).toBe('2.5');
  });

  it('shows a dimensionless result as one "Total" category', () => {
    const option = toOption('bar', result([row([], 7)], 0), {}, theme) as AnyOption;
    expect(option.xAxis.data).toEqual(['Total']);
    expect(option.series[0].data).toEqual([7]);
  });

  it('normalises a single series to 100 % when asked', () => {
    const option = toOption('bar', single, { percent: true }, theme) as AnyOption;
    expect(option.series[0].data).toEqual([37.5, 62.5]);
    expect(option.series[0].name).toBe('Value');
    expect(option.yAxis.axisLabel.formatter(50)).toBe('50 %');
    expect(option.tooltip.valueFormatter(37.5)).toBe('37.5 %');
  });

  it('normalises a single series against the server’s distinct total, not the sum of its rows', () => {
    // A project tagged Alpha and Beta counts in both: rows 3 + 5, distinct total 6.
    const multi = result([row([A], 3), row([B], 5)], 1, { total: 6, note: 'counted in each tag' });
    expect((toOption('bar', multi, { percent: true }, theme) as AnyOption).series[0].data).toEqual([50, 83.33]);
  });

  it('shows every category label and tilts them past six on a vertical chart', () => {
    const few = toOption('bar', single, {}, theme) as AnyOption;
    expect(few.xAxis.axisLabel.interval).toBe(0);
    expect(few.xAxis.axisLabel.rotate).toBeUndefined();
    expect(few.xAxis.axisLabel.hideOverlap).toBeUndefined();
    const seven = result(
      Array.from({ length: 7 }, (_, i) => row([k(i, `Project ${i}`)], i + 1)),
      1
    );
    const many = toOption('bar', seven, {}, theme) as AnyOption;
    expect(many.xAxis.axisLabel).toMatchObject({ interval: 0, rotate: 30 });
    expect((toOption('line', seven, {}, theme) as AnyOption).xAxis.axisLabel.rotate).toBe(30);
    // Horizontal bars keep their labels level.
    const horizontal = toOption('bar', seven, { orientation: 'horizontal' }, theme) as AnyOption;
    expect(horizontal.yAxis.axisLabel.interval).toBe(0);
    expect(horizontal.yAxis.axisLabel.rotate).toBeUndefined();
  });

  it('keeps an all-zero series at 0 when normalising', () => {
    const zero = result([row([A], 0), row([B], 0)], 1);
    expect((toOption('bar', zero, { percent: true }, theme) as AnyOption).series[0].data).toEqual([0, 0]);
  });
});

describe('toOption — two dimensions', () => {
  // Beta has no "Not confirmed" point: the server omits it.
  const two = result(
    [row([A, yes], 4), row([A, no], 1), row([B, yes], 2)],
    2
  );

  it('makes the second dimension the series, filling missing points with 0', () => {
    const option = toOption('bar', two, {}, theme) as AnyOption;
    expect(option.xAxis.data).toEqual(['Alpha', 'Beta']);
    expect(option.series.map((s: AnyOption) => s.name)).toEqual(['Confirmed', 'Not confirmed']);
    expect(option.series[0].data).toEqual([4, 2]);
    expect(option.series[1].data).toEqual([1, 0]);
    expect(option.series.map((s: AnyOption) => s.itemStyle.color)).toEqual(['p0', 'p1']);
    expect(option.series[0].stack).toBeUndefined();
  });

  it('shows the legend unless turned off', () => {
    expect((toOption('bar', two, {}, theme) as AnyOption).legend).toMatchObject({ show: true, type: 'scroll' });
    expect((toOption('bar', two, {}, theme) as AnyOption).grid.top).toBe(36);
    expect((toOption('bar', two, { show_legend: false }, theme) as AnyOption).legend).toEqual({ show: false });
  });

  it('stacks the series', () => {
    const option = toOption('bar', two, { stacked: true }, theme) as AnyOption;
    expect(option.series.every((s: AnyOption) => s.stack === 'total')).toBe(true);
    expect(option.yAxis.max).toBeUndefined();
  });

  it('stacks to 100 %, normalising each category when the server sent amounts', () => {
    const option = toOption('bar', two, { stacked: true, percent: true }, theme) as AnyOption;
    expect(option.series[0].data).toEqual([80, 100]);
    expect(option.series[1].data).toEqual([20, 0]);
    expect(option.yAxis.max).toBe(100);
  });

  it('lets a 100 % stack exceed 100 when a fact counted in several values', () => {
    const noted = result([row([A, yes], 4), row([A, no], 1)], 2, { unit: 'percent', note: 'counted twice' });
    expect((toOption('bar', noted, { stacked: true }, theme) as AnyOption).yAxis.max).toBeUndefined();
  });

  it('takes the server’s percentages as they are', () => {
    const shares = result([row([A, yes], 75), row([A, no], 25), row([B, yes], 100)], 2, { unit: 'percent' });
    const option = toOption('bar', shares, { stacked: true }, theme) as AnyOption;
    expect(option.series[0].data).toEqual([75, 100]);
    expect(option.yAxis.max).toBe(100);
    expect(option.tooltip.valueFormatter(75)).toBe('75 %');
  });

  it('puts empty buckets, then "Other", last', () => {
    const other = k('__other__', 'Other');
    const none = k(null, 'No team');
    const rows = [row([other, yes], 1), row([none, yes], 2), row([A, yes], 3)];
    const option = toOption('bar', result(rows, 2), {}, theme) as AnyOption;
    expect(option.xAxis.data).toEqual(['Alpha', 'No team', 'Other']);
    expect(option.series[0].data).toEqual([3, 2, 1]);
  });

  it('colours an "Other" series in the muted text colour', () => {
    const rows = [row([A, yes], 1), row([A, k('__other__', 'Other')], 2)];
    const option = toOption('line', result(rows, 2), { stacked: true }, theme) as AnyOption;
    expect(option.series[1].itemStyle.color).toBe('muted');
    expect(option.series[1].areaStyle).toEqual({ opacity: 0.25 });
  });

  it('matches keys across rows whatever their JSON type', () => {
    const rows = [row([k(1, 'Alpha'), yes], 1), row([k('1', 'Alpha'), no], 2)];
    const option = toOption('bar', result(rows, 2), {}, theme) as AnyOption;
    expect(option.xAxis.data).toEqual(['Alpha']);
  });

  it('skips rows that miss a series key', () => {
    const rows = [row([A, yes], 1), row([B], 9)];
    const option = toOption('bar', result(rows, 2), {}, theme) as AnyOption;
    expect(option.series).toHaveLength(1);
    expect(option.series[0].data).toEqual([1, 0]);
  });
});

describe('toOption — pie', () => {
  it('slices the first dimension with its colours, "Other" last and muted', () => {
    const rows = [row([k('__other__', 'Other')], 1), row([k(3, 'Basel', '#123')], 4), row([k(4, 'Zurich')], 5)];
    const option = toOption('pie', result(rows, 1, { unit: 'projects' }), {}, theme) as AnyOption;
    expect(option.series[0].type).toBe('pie');
    expect(option.series[0].data).toEqual([
      { name: 'Basel', value: 4, itemStyle: { color: '#123' } },
      { name: 'Zurich', value: 5, itemStyle: { color: 'p1' } },
      { name: 'Other', value: 1, itemStyle: { color: 'muted' } },
    ]);
    expect(option.tooltip).toMatchObject({ trigger: 'item' });
    expect(option.tooltip.valueFormatter(4)).toBe('4 projects');
    expect(option.legend).toEqual({ show: false });
    expect(option.aria).toEqual({ show: true, decal: { show: true } });
  });

  it('sums a second dimension into the first dimension’s slices', () => {
    const rows = [row([A, yes], 1), row([A, no], 2), row([B, yes], 3)];
    const option = toOption('pie', result(rows, 2), {}, theme) as AnyOption;
    expect(option.series[0].data.map((d: AnyOption) => d.value)).toEqual([3, 3]);
  });

  it('names the slices in a legend only when asked', () => {
    const rows = [row([A], 1), row([B], 2)];
    expect((toOption('pie', result(rows, 1), { show_legend: true }, theme) as AnyOption).legend).toEqual({
      show: true,
      type: 'scroll',
      top: 0,
    });
    expect((toOption('pie', result(rows, 1), { show_legend: false }, theme) as AnyOption).legend).toEqual({ show: false });
  });

  it('gives the tooltip the unit word, never after a percentage', () => {
    const rows = [row([A], 3), row([B], 2)];
    expect((toOption('pie', result(rows, 1), {}, theme) as AnyOption).tooltip.valueFormatter(3)).toBe('3.0 weeks');
    const shares = result(rows, 1, { unit: 'percent' });
    expect((toOption('pie', shares, {}, theme) as AnyOption).tooltip.valueFormatter(60)).toMatch(/^60\s%$/);
    const asPercent = toOption('pie', result(rows, 1), { number_format: 'percent' }, theme) as AnyOption;
    expect(asPercent.tooltip.valueFormatter(60)).toMatch(/^60\s%$/);
  });

  it('shows a dimensionless result as one "Total" slice', () => {
    const option = toOption('pie', result([row([], 7)], 0), undefined, theme) as AnyOption;
    expect(option.series[0].data).toEqual([{ name: 'Total', value: 7, itemStyle: { color: 'p0' } }]);
  });
});
