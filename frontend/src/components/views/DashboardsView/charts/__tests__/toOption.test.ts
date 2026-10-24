/**
 * toOption: a metric result → an ECharts option per kind. Category axis from
 * the first dimension in server order (never a time axis), series from the
 * second with missing points as 0, stacked / 100 %, horizontal bars, pie
 * slices, colours (own, palette, "Other" muted), legend and tooltip values.
 */
import { describe, it, expect } from 'vitest';
import {
  categoryCount,
  escapeHtml,
  GAUGE_BANDS,
  gaugeScale,
  hasDrawableData,
  gaugeTarget,
  MAX_GAUGE_TARGET,
  heatmapAxes,
  heatmapCounts,
  heatmapLabelsFit,
  isNarrow,
  LABEL_WIDTH,
  NARROW_LABEL_WIDTH,
  niceCeil,
  toOption,
} from '../toOption';
import type { ChartTheme } from '../echartsTheme';
import type { MetricKey, MetricResult, MetricRow } from '@/types';

const theme: ChartTheme = { palette: ['p0', 'p1', 'p2'], textMuted: 'muted', textSecondary: 'secondary' };

const k = (key: MetricKey['key'], label: string, color?: string): MetricKey => ({ key, label, ...(color ? { color } : {}) });
const row = (keys: MetricKey[], value: number | null): MetricRow => ({ keys, value });

function result(rows: MetricRow[], dims: number, extra: Partial<MetricResult> = {}): MetricResult {
  const kinds = ['team', 'confirmed'] as const;
  return {
    unit: 'weeks',
    dimensions: kinds.slice(0, dims).map((kind) => ({ kind, label: kind })),
    rows,
    total: rows.reduce((sum, r) => sum + (r.value ?? 0), 0),
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
    expect(option.series[0]).toMatchObject({ type: 'bar', name: 'Value', data: [3, 5], itemStyle: { color: 'p0' } });
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

  it('ticks a count axis in whole steps, never a days, weeks or percentage one', () => {
    for (const unit of ['count', 'people', 'projects', 'phases', 'equipment'] as const) {
      const counts = result([row([A], 0), row([B], 1)], 1, { unit });
      expect((toOption('bar', counts, {}, theme) as AnyOption).yAxis.minInterval).toBe(1);
      // Horizontal bars: the value axis is the x axis.
      expect((toOption('bar', counts, { orientation: 'horizontal' }, theme) as AnyOption).xAxis.minInterval).toBe(1);
      expect((toOption('line', counts, {}, theme) as AnyOption).yAxis.minInterval).toBe(1);
      // As a 100 % bar the axis is a percentage.
      expect((toOption('bar', counts, { stacked: true, percent: true }, theme) as AnyOption).yAxis).not.toHaveProperty('minInterval');
    }
    expect((toOption('bar', single, {}, theme) as AnyOption).yAxis).not.toHaveProperty('minInterval');
    expect((toOption('bar', result([row([A], 1)], 1, { unit: 'days' }), {}, theme) as AnyOption).yAxis).not.toHaveProperty('minInterval');
    expect((toOption('bar', result([row([A], 1)], 1, { unit: 'percent' }), {}, theme) as AnyOption).yAxis).not.toHaveProperty('minInterval');
  });

  it('formats tooltip values with the number format, followed by the unit word', () => {
    const option = toOption('bar', single, { number_format: 'integer' }, theme) as AnyOption;
    expect(option.tooltip.valueFormatter(12.4)).toBe('12 weeks');
    expect(toOption('bar', single, {}, theme).tooltip).toBeDefined();
    expect((toOption('bar', single, {}, theme) as AnyOption).tooltip.valueFormatter(70.1)).toBe('70.1 weeks');
    // One of a count reads singular ("1 phase"); "1.0 weeks" stays plural.
    const phases = toOption('bar', { ...single, unit: 'phases' }, {}, theme) as AnyOption;
    expect(phases.tooltip.valueFormatter(1)).toBe('1 phase');
    expect(phases.tooltip.valueFormatter(3)).toBe('3 phases');
    expect((toOption('bar', single, {}, theme) as AnyOption).tooltip.valueFormatter(1)).toBe('1.0 weeks');
    const asPercent = toOption('line', single, { number_format: 'percent' }, theme) as AnyOption;
    expect(asPercent.tooltip.valueFormatter(60)).toMatch(/^60\s%$/);
  });

  it('names a single series after the measure, two series after the second dimension', () => {
    const option = toOption('bar', single, {}, theme, 'Booked weeks') as AnyOption;
    expect(option.series[0].name).toBe('Booked weeks');
    expect((toOption('line', single, null, theme, 'Booked weeks') as AnyOption).series[0].name).toBe('Booked weeks');
    const two = result([row([A, yes], 4), row([A, no], 1)], 2);
    const named = toOption('bar', two, {}, theme, 'Booked weeks') as AnyOption;
    expect(named.series.map((s: AnyOption) => s.name)).toEqual(['Confirmed', 'Not confirmed']);
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

  it('tilts and shortens the labels of a narrow vertical chart, never a horizontal one', () => {
    const level = toOption('bar', single, {}, theme) as AnyOption;
    expect(level.xAxis.axisLabel.width).toBe(LABEL_WIDTH);
    const narrow = toOption('bar', single, {}, theme, undefined, { narrow: true }) as AnyOption;
    expect(narrow.xAxis.axisLabel).toMatchObject({ interval: 0, rotate: 30, width: NARROW_LABEL_WIDTH });
    expect(NARROW_LABEL_WIDTH).toBe(72);
    expect((toOption('line', single, null, theme, 'W', { narrow: true }) as AnyOption).xAxis.axisLabel.rotate).toBe(30);
    const horizontal = toOption('bar', single, { orientation: 'horizontal' }, theme, undefined, { narrow: true }) as AnyOption;
    expect(horizontal.yAxis.axisLabel.rotate).toBeUndefined();
    expect(horizontal.yAxis.axisLabel.width).toBe(120);
  });

  it('is narrow below 90 px per category, never unmeasured', () => {
    expect(categoryCount(single)).toBe(single.rows.length);
    expect(isNarrow(300, 4)).toBe(true);
    expect(isNarrow(360, 4)).toBe(false);
    expect(isNarrow(0, 4)).toBe(false);
    expect(isNarrow(50, 0)).toBe(false);
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

describe('toOption — values over nothing (null)', () => {
  // Utilisation of a week with booked time but no capacity: the server sends null.
  const weeks = result([row([k('2026-W01', 'W01')], 40), row([k('2026-W02', 'W02')], null), row([k('2026-W03', 'W03')], 110)], 1, {
    unit: 'percent',
    total: null,
  });

  it('leaves a gap in a bar or line, never a 0, and draws values over 100 % as they are', () => {
    expect((toOption('bar', weeks, {}, theme) as AnyOption).series[0].data).toEqual([40, null, 110]);
    const line = toOption('line', weeks, {}, theme) as AnyOption;
    expect(line.series[0].data).toEqual([40, null, 110]);
    expect(line.yAxis.max).toBeUndefined();
    expect(line.tooltip.valueFormatter(null)).toBe('–');
    expect(line.tooltip.valueFormatter(110)).toMatch(/^110\s%$/);
  });

  it('keeps a null point beside the colours of its values', () => {
    const coloured = result([row([k(1, 'Ann', '#aaa')], null), row([k(2, 'Bob', '#bbb')], 50)], 1, { unit: 'percent' });
    expect((toOption('bar', coloured, {}, theme) as AnyOption).series[0].data).toEqual([
      { value: null, itemStyle: { color: '#aaa' } },
      { value: 50, itemStyle: { color: '#bbb' } },
    ]);
  });

  it('keeps a null point null across two dimensions, a missing one 0, and adds a number to a null', () => {
    const rows = [row([A, yes], null), row([B, yes], 20), row([B, yes], null), row([A, no], 5)];
    const option = toOption('bar', result(rows, 2, { unit: 'days' }), {}, theme) as AnyOption;
    expect(option.series[0].data).toEqual([null, 20]);
    expect(option.series[1].data).toEqual([5, 0]);
    expect(option.tooltip.valueFormatter(null)).toBe('–');
  });

  it('keeps null points null when normalising to 100 %', () => {
    const rows = [row([A, yes], null), row([A, no], 5), row([B, yes], 3), row([B, no], 1)];
    const stacked = toOption('bar', result(rows, 2, { unit: 'days' }), { stacked: true, percent: true }, theme) as AnyOption;
    expect(stacked.series[0].data).toEqual([null, 75]);
    expect(stacked.series[1].data).toEqual([100, 25]);
    const single = result([row([A], null), row([B], 4)], 1, { unit: 'days', total: null });
    expect((toOption('bar', single, { percent: true }, theme) as AnyOption).series[0].data).toEqual([null, 0]);
  });

  it('leaves a null slice out of a pie, the others keeping their colours', () => {
    const rows = [row([A], null), row([B], 2), row([k(3, 'Gamma')], 4)];
    const option = toOption('pie', result(rows, 1, { unit: 'percent' }), {}, theme) as AnyOption;
    expect(option.series[0].data).toEqual([
      { name: 'Beta', value: 2, itemStyle: { color: 'p1' } },
      { name: 'Gamma', value: 4, itemStyle: { color: 'p2' } },
    ]);
    expect(option.tooltip.valueFormatter(null)).toBe('–');
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

const QUIET_ARIA = { enabled: true, decal: { show: false } };

describe('gaugeScale — percentages', () => {
  const fractionsOf = (scale: ReturnType<typeof gaugeScale>) => scale.stops.map(([fraction]) => fraction);
  const wellFormed = (scale: ReturnType<typeof gaugeScale>) => {
    const fractions = fractionsOf(scale);
    fractions.forEach((f, i) => {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      if (i > 0) expect(f).toBeGreaterThanOrEqual(fractions[i - 1]);
    });
    expect(fractions[fractions.length - 1]).toBe(1);
  };

  it('ends at 120 and turns amber at the target 85, red past 100', () => {
    const scale = gaugeScale(70, 85, 'percent');
    expect(scale.min).toBe(0);
    expect(scale.max).toBe(120);
    expect(scale.stops).toEqual([
      [85 / 120, 'good'],
      [100 / 120, 'warn'],
      [1, 'bad'],
    ]);
    wellFormed(scale);
    expect(scale.band(70)).toBe('good');
    expect(scale.band(84.9)).toBe('good');
    expect(scale.band(85)).toBe('warn');
    expect(scale.band(100)).toBe('warn');
    expect(scale.band(100.1)).toBe('bad');
  });

  it('has no amber band when the target is 100 % or more', () => {
    const hundred = gaugeScale(70, 100, 'percent');
    expect(hundred.max).toBe(120);
    const [[t], [a]] = hundred.stops;
    expect(a).toBe(t);
    wellFormed(hundred);
    expect(hundred.band(99)).toBe('good');
    expect(hundred.band(101)).toBe('bad');

    const above = gaugeScale(70, 150, 'percent');
    expect(above.max).toBe(150);
    expect(above.max).toBeGreaterThanOrEqual(150);
    expect(above.stops).toEqual([
      [1, 'good'],
      [1, 'warn'],
      [1, 'bad'],
    ]);
    wellFormed(above);
    expect(above.band(120)).toBe('good');
  });

  it('stretches past 120 for a value or a target beyond it, rounded up to ten', () => {
    expect(gaugeScale(131, 85, 'percent').max).toBe(140);
    expect(gaugeScale(10, 155, 'percent').max).toBe(160);
    wellFormed(gaugeScale(131, 85, 'percent'));
  });

  it('is one plain band without a target', () => {
    const scale = gaugeScale(40, null, 'percent');
    expect(scale.max).toBe(120);
    expect(scale.stops).toEqual([[1, 'plain']]);
    expect(scale.band(40)).toBe('plain');
    expect(gaugeScale(40, undefined, 'percent').stops).toEqual([[1, 'plain']]);
  });

  it('paints with the colours it is given', () => {
    const colours = { good: 'g', warn: 'w', bad: 'b', plain: 'p' };
    expect(gaugeScale(90, 85, 'percent', colours).band(90)).toBe('w');
    expect(gaugeScale(90, null, 'percent', colours).stops).toEqual([[1, 'p']]);
    expect(GAUGE_BANDS).toEqual({ good: 'good', warn: 'warn', bad: 'bad', plain: 'plain' });
  });
});

describe('gaugeScale — other units', () => {
  it('ends at a nice number past 125 % of the target and 110 % of the value', () => {
    expect(gaugeScale(20, null, 'days').max).toBe(50); // 22 → 50
    expect(gaugeScale(7, null, 'days').max).toBe(10); // 7.7 → 10
    expect(gaugeScale(1000, null, 'weeks').max).toBe(2000); // 1100 → 2000
    expect(gaugeScale(10, 16, 'days').max).toBe(20); // 20 → 20
    expect(gaugeScale(0, null, 'count').max).toBe(1);
    expect(gaugeScale(0.5, 0.2, 'volume').max).toBe(1);
  });

  it('turns amber at the target and red past 115 % of it', () => {
    const scale = gaugeScale(10, 20, 'days');
    expect(scale.max).toBe(50);
    expect(scale.stops).toEqual([
      [20 / 50, 'good'],
      [(20 * 1.15) / 50, 'warn'],
      [1, 'bad'],
    ]);
    expect(scale.band(19)).toBe('good');
    expect(scale.band(22)).toBe('warn');
    expect(scale.band(23.5)).toBe('bad');
  });

  it('starts below 0 for a negative value, every band staying at its value', () => {
    const scale = gaugeScale(-12, 10, 'days');
    expect(scale.min).toBe(-12);
    expect(scale.min).toBeLessThan(0);
    expect(scale.max).toBe(20);
    // From -12 to 20: the target 10 sits at 22 / 32 of the track.
    expect(scale.stops[0][0]).toBeCloseTo(22 / 32);
    expect(scale.stops[1][0]).toBeCloseTo(23.5 / 32);
    expect(scale.band(-12)).toBe('good');
    expect(gaugeScale(-3, null, 'percent')).toMatchObject({ min: -3, max: 120 });
  });

  it('a target of 0 leaves no green band', () => {
    const scale = gaugeScale(3, 0, 'count');
    expect(scale.stops.slice(0, 2)).toEqual([
      [0, 'good'],
      [0, 'warn'],
    ]);
    expect(scale.band(3)).toBe('bad');
  });

  it('rounds up to 1, 2 or 5 × 10ⁿ', () => {
    expect([1, 1.5, 2, 2.1, 5, 6, 100, 101, 0.15].map(niceCeil)).toEqual([1, 2, 2, 5, 5, 10, 100, 200, 0.2]);
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-3)).toBe(1);
    expect(niceCeil(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('takes a target only when it is a finite number ≥ 0', () => {
    expect(gaugeTarget(85)).toBe(85);
    expect(gaugeTarget(0)).toBe(0);
    expect(gaugeTarget(-1)).toBeNull();
    expect(gaugeTarget(Number.NaN)).toBeNull();
    expect(gaugeTarget(null)).toBeNull();
    expect(gaugeTarget('85' as unknown as number)).toBeNull();
  });

  it('refuses a target past the server cap (1e9)', () => {
    expect(MAX_GAUGE_TARGET).toBe(1_000_000_000);
    expect(gaugeTarget(MAX_GAUGE_TARGET)).toBe(MAX_GAUGE_TARGET);
    expect(gaugeTarget(MAX_GAUGE_TARGET + 1)).toBeNull();
    expect(gaugeTarget(2e9)).toBeNull();
    expect(gaugeTarget(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('toOption — gauge', () => {
  const full: ChartTheme = {
    palette: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
    textPrimary: 'primary',
    textSecondary: 'secondary',
    good: 'green',
    warn: 'orange',
    bad: 'red',
  };
  const utilisation = (total: number | null): MetricResult => ({ ...result([row([], total)], 0), unit: 'percent', total });

  it('draws the total on a 210° arc, the track in bands around the target', () => {
    const option = toOption('gauge', utilisation(70), { target: 85 }, full) as AnyOption;
    expect(option.aria).toEqual(QUIET_ARIA);
    const [series] = option.series;
    expect(series).toMatchObject({
      type: 'gauge',
      min: 0,
      max: 120,
      startAngle: 210,
      endAngle: -30,
      progress: { show: true, width: 12, itemStyle: { color: 'green' } },
      axisLine: { lineStyle: { width: 12 } },
      pointer: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      title: { show: true, offsetCenter: [0, '70%'], color: 'secondary' },
      detail: { valueAnimation: false, offsetCenter: [0, '20%'], color: 'primary' },
    });
    expect(series.axisLine.lineStyle.color).toEqual([
      [85 / 120, 'green'],
      [100 / 120, 'orange'],
      [1, 'red'],
    ]);
    expect(series.data).toHaveLength(1);
    expect(series.data[0].value).toBe(70);
    expect(series.data[0].name).toMatch(/^Target 85\s%$/);
    expect(series.detail.formatter(70)).toMatch(/^70\s%$/);
  });

  it('paints the progress in the value’s band', () => {
    expect((toOption('gauge', utilisation(95), { target: 85 }, full) as AnyOption).series[0].progress.itemStyle.color).toBe('orange');
    expect((toOption('gauge', utilisation(110), { target: 85 }, full) as AnyOption).series[0].progress.itemStyle.color).toBe('red');
  });

  it('falls back to the palette for the bands', () => {
    const plain = { ...full, good: undefined, warn: undefined, bad: undefined };
    const series = (toOption('gauge', utilisation(70), { target: 85 }, plain) as AnyOption).series[0];
    expect(series.axisLine.lineStyle.color.map(([, c]: [number, string]) => c)).toEqual(['p1', 'p2', 'p7']);
    // A short palette: red falls back to its first colour
    const short = (toOption('gauge', utilisation(110), { target: 85 }, theme) as AnyOption).series[0];
    expect(short.axisLine.lineStyle.color.map(([, c]: [number, string]) => c)).toEqual(['p1', 'p2', 'p0']);
    expect(short.progress.itemStyle.color).toBe('p0');
  });

  it('is one plain band and no title without a target', () => {
    const series = (toOption('gauge', utilisation(40), {}, full) as AnyOption).series[0];
    expect(series.axisLine.lineStyle.color).toEqual([[1, 'p0']]);
    expect(series.progress.itemStyle.color).toBe('p0');
    expect(series.title.show).toBe(false);
    expect(series.data[0].name).toBe('');
    // A stored negative target is no target
    expect((toOption('gauge', utilisation(40), { target: -5 }, full) as AnyOption).series[0].title.show).toBe(false);
  });

  it('gives other units their word, after the value and the target', () => {
    const days: MetricResult = { ...result([row([], 1)], 0), unit: 'days', total: 1 };
    const series = (toOption('gauge', days, { target: 20 }, full) as AnyOption).series[0];
    expect(series.max).toBe(50);
    expect(series.data[0].name).toBe('Target 20.0 days');
    expect(series.detail.formatter(1)).toBe('1.0 days');
    const people = (toOption('gauge', { ...days, unit: 'people' }, { target: 1 }, full) as AnyOption).series[0];
    expect(people.data[0].name).toBe('Target 1 person');
    expect(people.detail.formatter(3)).toBe('3 people');
  });

  it('reads the total of a result with dimensions (only the API sends one)', () => {
    const teams = result([row([A], 30), row([B], 12)], 1, { unit: 'percent', total: 42 });
    expect((toOption('gauge', teams, { target: 85 }, full) as AnyOption).series[0].data[0].value).toBe(42);
  });
});

describe('toOption — heatmap', () => {
  const jan = k('2026-01', 'Jan 2026');
  const feb = k('2026-02', 'Feb 2026');
  const mar = k('2026-03', 'Mar 2026');
  const heat = (rows: MetricRow[], dims: { kind: 'team' | 'period' | 'project'; label: string }[], extra: Partial<MetricResult> = {}): MetricResult => ({
    ...result(rows, 0),
    dimensions: dims,
    ...extra,
  });
  const TEAM = { kind: 'team' as const, label: 'Team' };
  const MONTH = { kind: 'period' as const, label: 'Month' };
  const PROJECT = { kind: 'project' as const, label: 'Project' };
  const colours: ChartTheme = { ...theme, heatLow: 'low', heatHigh: 'high', background: 'card', textPrimary: 'primary' };

  it('runs a period along x and the other dimension down y, first row on top', () => {
    const byTeam = heat([row([A, jan], 1), row([A, feb], 2), row([B, jan], 3)], [TEAM, MONTH]);
    const option = toOption('heatmap', byTeam, {}, colours) as AnyOption;
    expect(option.aria).toEqual(QUIET_ARIA);
    expect(option.xAxis).toMatchObject({ type: 'category', boundaryGap: true, data: ['Jan 2026', 'Feb 2026'] });
    expect(option.yAxis).toMatchObject({ type: 'category', boundaryGap: true, inverse: true, data: ['Alpha', 'Beta'] });
    expect(option.series[0].type).toBe('heatmap');
    expect(option.series[0].data).toEqual([
      [0, 0, 1],
      [1, 0, 2],
      [0, 1, 3],
    ]);
    // The period first: still along x
    const byMonth = heat([row([jan, A], 1), row([jan, B], 3), row([feb, A], 2)], [MONTH, TEAM]);
    const flipped = toOption('heatmap', byMonth, {}, colours) as AnyOption;
    expect(flipped.xAxis.data).toEqual(['Jan 2026', 'Feb 2026']);
    expect(flipped.yAxis.data).toEqual(['Alpha', 'Beta']);
    expect(flipped.series[0].data).toEqual([
      [0, 0, 1],
      [0, 1, 3],
      [1, 0, 2],
    ]);
  });

  it('puts the first dimension down y and the second along x without a period', () => {
    const p1 = k(11, 'Apollo');
    const p2 = k(12, 'Borealis');
    const option = toOption('heatmap', heat([row([A, p1], 4), row([B, p2], 5)], [TEAM, PROJECT]), {}, colours) as AnyOption;
    expect(option.yAxis.data).toEqual(['Alpha', 'Beta']);
    expect(option.xAxis.data).toEqual(['Apollo', 'Borealis']);
    expect(option.series[0].data).toEqual([
      [0, 0, 4],
      [1, 1, 5],
    ]);
  });

  it('keeps the months in time order when the first row lacks the earliest', () => {
    // The server sorts by team, then month: Beta's January comes after Alpha's months.
    const rows = [row([A, feb], 1), row([A, mar], 2), row([B, jan], 3), row([k('__other__', 'Other'), jan], 1)];
    const option = toOption('heatmap', heat(rows, [TEAM, MONTH]), {}, colours) as AnyOption;
    expect(option.xAxis.data).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026']);
    expect(option.yAxis.data).toEqual(['Alpha', 'Beta', 'Other']);
    expect(option.series[0].data).toContainEqual([0, 1, 3]);
  });

  it('leaves a null cell out (no point, no tooltip)', () => {
    const rows = [row([A, jan], null), row([A, feb], 80), row([B, jan], 40)];
    const option = toOption('heatmap', heat(rows, [TEAM, MONTH], { unit: 'percent' }), {}, colours) as AnyOption;
    expect(option.series[0].data).toEqual([
      [1, 0, 80],
      [0, 1, 40],
    ]);
    expect(option.xAxis.data).toEqual(['Jan 2026', 'Feb 2026']);
  });

  it('scales the colours from 0 (or the lowest value) to the highest, percentages to 100 at least', () => {
    const vm = (rows: MetricRow[], unit: MetricResult['unit'] = 'weeks') =>
      (toOption('heatmap', heat(rows, [TEAM, MONTH], { unit }), {}, colours) as AnyOption).visualMap;
    expect(vm([row([A, jan], 2), row([B, jan], 10)])).toMatchObject({
      type: 'continuous',
      min: 0,
      max: 10,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemWidth: 10,
      itemHeight: 120,
      inRange: { color: ['low', 'high'] },
      textStyle: { color: 'secondary' },
    });
    expect(vm([row([A, jan], 2), row([B, jan], 10)]).text).toEqual(['10.0', '0.0']);
    // All zero: the scale still spans one unit
    expect(vm([row([A, jan], 0)])).toMatchObject({ min: 0, max: 1 });
    expect(vm([row([A, jan], null)])).toMatchObject({ min: 0, max: 1 });
    // A negative value lowers the start
    expect(vm([row([A, jan], -5), row([B, jan], 3)], 'days')).toMatchObject({ min: -5, max: 3 });
    expect(vm([row([A, jan], -5), row([B, jan], -4)], 'days')).toMatchObject({ min: -5, max: -4 });
    // Percentages: 100 at least, more when a value exceeds it
    expect(vm([row([A, jan], 40), row([B, jan], 80)], 'percent')).toMatchObject({ min: 0, max: 100 });
    expect(vm([row([A, jan], 130)], 'percent')).toMatchObject({ max: 130 });
    expect(vm([row([A, jan], 40)], 'percent').text[0]).toMatch(/^100\s%$/);
  });

  it('falls back to the card surface and the first palette colour for the scale', () => {
    const plain = { ...colours, heatLow: undefined, heatHigh: undefined };
    const option = toOption('heatmap', heat([row([A, jan], 1)], [TEAM, MONTH]), {}, plain) as AnyOption;
    expect(option.visualMap.inRange.color).toEqual(['card', 'p0']);
  });

  it('shows a value in each cell only when they fit, without the unit word', () => {
    const byTeam = heat([row([A, jan], 1.25)], [TEAM, MONTH]);
    expect((toOption('heatmap', byTeam, {}, colours) as AnyOption).series[0].label.show).toBe(false);
    const fits = toOption('heatmap', byTeam, { number_format: 'decimal' }, colours, 'Booked weeks', { labelsFit: true }) as AnyOption;
    expect(fits.series[0].label.show).toBe(true);
    expect(fits.series[0].label.formatter({ value: [0, 0, 1.25] })).toBe('1.25');
    expect(fits.series[0].label.formatter({})).toBe('–');
    expect(fits.series[0].emphasis).toEqual({ itemStyle: { borderColor: 'primary', borderWidth: 1 } });
    expect(fits.series[0].itemStyle).toEqual({ borderColor: 'card', borderWidth: 1 });
  });

  it('names the row, the column and the value with its unit in the tooltip, escaped', () => {
    const rows = [row([k(1, 'R&D <lab>'), jan], 3)];
    const option = toOption('heatmap', heat(rows, [TEAM, MONTH]), {}, colours) as AnyOption;
    expect(option.tooltip.trigger).toBe('item');
    expect(option.tooltip.formatter({ value: [0, 0, 3] })).toBe('R&amp;D &lt;lab&gt; · Jan 2026: 3.0 weeks');
    expect(escapeHtml(`"Tom's"`)).toBe('&quot;Tom&#39;s&quot;');
  });

  it('truncates the row labels and tilts the column labels when narrow', () => {
    const byTeam = heat([row([A, jan], 1)], [TEAM, MONTH]);
    const level = toOption('heatmap', byTeam, {}, colours) as AnyOption;
    expect(level.yAxis.axisLabel).toEqual({ interval: 0, overflow: 'truncate', width: 120 });
    expect(level.xAxis.axisLabel).toEqual({ interval: 0, overflow: 'truncate', width: LABEL_WIDTH });
    const narrow = toOption('heatmap', byTeam, {}, colours, undefined, { narrow: true }) as AnyOption;
    expect(narrow.xAxis.axisLabel).toEqual({ interval: 0, overflow: 'truncate', width: NARROW_LABEL_WIDTH, rotate: 30 });
    expect(level.grid).toMatchObject({ bottom: 56, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' });
  });

  it('draws one dimension as a single column named after the measure (only the API sends one)', () => {
    const single = result([row([A], 3), row([B], 5)], 1);
    const option = toOption('heatmap', single, {}, colours, 'Booked weeks') as AnyOption;
    expect(option.xAxis.data).toEqual(['Booked weeks']);
    expect(option.yAxis.data).toEqual(['Alpha', 'Beta']);
    expect(option.series[0].data).toEqual([
      [0, 0, 3],
      [0, 1, 5],
    ]);
    expect((toOption('heatmap', single, {}, colours) as AnyOption).xAxis.data).toEqual(['Value']);
    // No dimension at all: one cell
    expect((toOption('heatmap', result([row([], 7)], 0), {}, colours) as AnyOption).series[0].data).toEqual([[0, 0, 7]]);
    expect(heatmapAxes(single).y.map((key) => key.label)).toEqual(['Alpha', 'Beta']);
  });

  it('skips a row missing a key and adds up rows of one cell', () => {
    const rows = [row([A, jan], 1), row([A], 9), row([A, jan], 2)];
    expect((toOption('heatmap', heat(rows, [TEAM, MONTH]), {}, colours) as AnyOption).series[0].data).toEqual([[0, 0, 3]]);
  });

  it('counts its columns and rows', () => {
    const rows = [row([A, jan], 1), row([A, feb], 2), row([B, jan], 3)];
    expect(heatmapCounts(heat(rows, [TEAM, MONTH]))).toEqual({ x: 2, y: 2 });
    expect(heatmapCounts(result([row([A], 1), row([B], 1)], 1))).toEqual({ x: 1, y: 2 });
  });

  it('fits a value in a cell from 44 px wide and 20 px high, beside the labels and the scale', () => {
    // 144 px across for the row labels and the grid, 88 px down for the scale and the column labels
    expect(heatmapLabelsFit(144 + 88, 88 + 40, 2, 2)).toBe(true);
    expect(heatmapLabelsFit(144 + 87.9, 88 + 40, 2, 2)).toBe(false);
    expect(heatmapLabelsFit(144 + 88, 88 + 39.9, 2, 2)).toBe(false);
    expect(heatmapLabelsFit(144 + 44, 88 + 20, 0, 0)).toBe(true);
    expect(heatmapLabelsFit(0, 0, 1, 1)).toBe(false);
    // Regression: 14 weekly columns on a 640 px card left 35 px cells — "116.7 %" overflowed
    expect(heatmapLabelsFit(640, 400, 14, 7)).toBe(false);
    // The demo's 12 months × 4 teams at 1440 px still show their values
    expect(heatmapLabelsFit(839, 265, 12, 4)).toBe(true);
  });
});

const SITE = { kind: 'site' as const, label: 'Site' };
const PROJ = { kind: 'project' as const, label: 'Project' };
const MON = { kind: 'period' as const, label: 'Month' };
const withDims = (rows: MetricRow[], dims: { kind: 'site' | 'project' | 'period'; label: string }[], extra: Partial<MetricResult> = {}) => ({
  ...result(rows, 0),
  dimensions: dims,
  ...extra,
});
const OTHER = k('__other__', 'Other');

describe('toOption — treemap', () => {
  const basel = k(1, 'Basel');
  const zurich = k(2, 'Zurich', '#123456');
  const p1 = k(11, 'Apollo');
  const p2 = k(12, 'Borealis');
  const p3 = k(13, 'Cygnus');
  const boxes: ChartTheme = { ...theme, background: 'card', textPrimary: 'primary' };

  it('nests the second dimension in the first, each parent the sum of its children in its colour', () => {
    const rows = [row([basel, p1], 3), row([basel, p2], 2), row([zurich, p3], 4)];
    const option = toOption('treemap', withDims(rows, [SITE, PROJ]), {}, boxes) as AnyOption;
    expect(option.aria).toEqual(QUIET_ARIA);
    const [series] = option.series;
    expect(series).toMatchObject({ type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false } });
    // Pinned to the edges, never sized and centred (a resize would shift it)
    expect(series).toMatchObject({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(series.width).toBeUndefined();
    expect(series.height).toBeUndefined();
    expect(series.data).toEqual([
      {
        name: 'Basel',
        value: 5,
        itemStyle: { color: 'p0' },
        children: [
          { name: 'Apollo', value: 3, itemStyle: { color: 'p0' } },
          { name: 'Borealis', value: 2, itemStyle: { color: 'p0' } },
        ],
      },
      { name: 'Zurich', value: 4, itemStyle: { color: '#123456' }, children: [{ name: 'Cygnus', value: 4, itemStyle: { color: '#123456' } }] },
    ]);
  });

  it('drops null, zero and negative values, and a parent left with nothing', () => {
    const rows = [row([basel, p1], null), row([basel, p2], 0), row([zurich, p1], -2), row([zurich, p3], 1), row([zurich], 5)];
    const series = (toOption('treemap', withDims(rows, [SITE, PROJ]), {}, boxes) as AnyOption).series[0];
    expect(series.data).toEqual([
      { name: 'Zurich', value: 1, itemStyle: { color: '#123456' }, children: [{ name: 'Cygnus', value: 1, itemStyle: { color: '#123456' } }] },
    ]);
  });

  it('is flat with one dimension, "Other" last and muted, colours keeping their position', () => {
    const rows = [row([OTHER], 1), row([basel], 0), row([zurich], 4), row([p1], 2)];
    const series = (toOption('treemap', withDims(rows, [SITE]), {}, boxes) as AnyOption).series[0];
    expect(series.data).toEqual([
      { name: 'Zurich', value: 4, itemStyle: { color: '#123456' } },
      { name: 'Apollo', value: 2, itemStyle: { color: 'p2' } },
      { name: 'Other', value: 1, itemStyle: { color: 'muted' } },
    ]);
    // No dimension: one "Total" box
    expect((toOption('treemap', result([row([], 7)], 0), {}, boxes) as AnyOption).series[0].data).toEqual([
      { name: 'Total', value: 7, itemStyle: { color: 'p0' } },
    ]);
  });

  it('draws a period dimension flat over the other dimension (only the API sends one)', () => {
    const jan = k('2026-01', 'Jan 2026');
    const feb = k('2026-02', 'Feb 2026');
    const rows = [row([basel, jan], 1), row([basel, feb], 2), row([zurich, jan], 4)];
    const bySite = (toOption('treemap', withDims(rows, [SITE, MON]), {}, boxes) as AnyOption).series[0];
    expect(bySite.data).toEqual([
      { name: 'Basel', value: 3, itemStyle: { color: 'p0' } },
      { name: 'Zurich', value: 4, itemStyle: { color: '#123456' } },
    ]);
    const swapped = [row([jan, basel], 1), row([jan, zurich], 4), row([feb, basel], 2)];
    const period = (toOption('treemap', withDims(swapped, [MON, SITE]), {}, boxes) as AnyOption).series[0];
    expect(period.data.map((d: AnyOption) => [d.name, d.value])).toEqual([
      ['Basel', 3],
      ['Zurich', 4],
    ]);
    // Only a period: flat over it
    const months = (toOption('treemap', withDims([row([jan], 1), row([feb], 2)], [MON]), {}, boxes) as AnyOption).series[0];
    expect(months.data.map((d: AnyOption) => d.name)).toEqual(['Jan 2026', 'Feb 2026']);
  });

  it('separates the boxes with the card colour and labels them with their value', () => {
    const option = toOption('treemap', withDims([row([basel, p1], 3)], [SITE, PROJ]), { number_format: 'integer' }, boxes) as AnyOption;
    const [series] = option.series;
    // Level 0 is ECharts' virtual root: its gap parts the sites, theirs the projects under the site's name.
    expect(series.levels).toEqual([
      { itemStyle: { gapWidth: 2, borderColor: 'card', borderWidth: 0 } },
      { itemStyle: { gapWidth: 1, borderColor: 'card', borderWidth: 2 }, upperLabel: { show: true, height: 22, color: 'primary' } },
      { itemStyle: { borderColor: 'card' } },
    ]);
    expect(series.label.formatter({ name: 'Apollo', value: 3.4 })).toBe('Apollo\n3');
    expect(series.label.formatter({})).toBe('\n–');
    expect(option.tooltip.trigger).toBe('item');
    expect(option.tooltip.formatter({ name: 'A <b>', value: 3 })).toBe('A &lt;b&gt;: 3 weeks');
    expect(option.tooltip.formatter({ name: 'A', value: 1 })).toBe('A: 1 week');
    expect(option.tooltip.formatter({})).toBe(': –');
  });
});

describe('toOption — sankey', () => {
  const p1 = k(11, 'Apollo');
  const p2 = k(12, 'Borealis');
  const t1 = k(1, 'Alpha team', '#aa0000');
  const t2 = k(2, 'Beta team');
  const flows: ChartTheme = { palette: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], textMuted: 'muted', textPrimary: 'primary' };

  it('flows from the first dimension to the second, node ids carrying their side', () => {
    const rows = [row([p1, t1], 3), row([p1, t2], 2), row([p2, t2], 4)];
    const option = toOption('sankey', withDims(rows, [PROJ, { kind: 'site', label: 'Team' }]), {}, flows) as AnyOption;
    expect(option.aria).toEqual(QUIET_ARIA);
    const [series] = option.series;
    expect(series).toMatchObject({
      type: 'sankey',
      nodeAlign: 'justify',
      draggable: false,
      emphasis: { focus: 'adjacency' },
      lineStyle: { color: 'gradient', opacity: 0.4 },
      layoutIterations: 32,
      label: { overflow: 'truncate', width: 120, color: 'primary' },
      // Room for the second column's labels, right of its nodes
      right: 128,
    });
    expect(series.data).toEqual([
      { id: '1:11', name: 'Apollo', itemStyle: { color: 'p0' } },
      { id: '1:12', name: 'Borealis', itemStyle: { color: 'p1' } },
      // The palette continues after the left column; a value's own colour wins
      { id: '2:1', name: 'Alpha team', itemStyle: { color: '#aa0000' } },
      { id: '2:2', name: 'Beta team', itemStyle: { color: 'p3' } },
    ]);
    expect(series.links).toEqual([
      { source: '1:11', target: '2:1', value: 3 },
      { source: '1:11', target: '2:2', value: 2 },
      { source: '1:12', target: '2:2', value: 4 },
    ]);
  });

  it('keeps a value present on both sides as two nodes', () => {
    const same = k(5, 'Shared');
    const series = (toOption('sankey', withDims([row([same, same], 1)], [PROJ, PROJ]), {}, flows) as AnyOption).series[0];
    expect(series.data.map((n: AnyOption) => n.id)).toEqual(['1:5', '2:5']);
    expect(series.links).toEqual([{ source: '1:5', target: '2:5', value: 1 }]);
    // Text keys are JSON in the id
    const named = (toOption('sankey', withDims([row([k('ACME', 'ACME'), same], 1)], [PROJ, PROJ]), {}, flows) as AnyOption).series[0];
    expect(named.data[0].id).toBe('1:"ACME"');
  });

  it('drops null and zero flows, and the nodes left without one', () => {
    const rows = [row([p1, t1], null), row([p1, t2], 0), row([p2, t2], 4), row([p2], 9)];
    const series = (toOption('sankey', withDims(rows, [PROJ, PROJ]), {}, flows) as AnyOption).series[0];
    expect(series.links).toEqual([{ source: '1:12', target: '2:2', value: 4 }]);
    expect(series.data.map((n: AnyOption) => n.id)).toEqual(['1:12', '2:2']);
    // Colours keep their position: Borealis is the second left value, Beta the second right one
    expect(series.data.map((n: AnyOption) => n.itemStyle.color)).toEqual(['p1', 'p3']);
  });

  it('draws "Other" as a muted node after the others', () => {
    const rows = [row([OTHER, t1], 1), row([p1, t1], 3)];
    const series = (toOption('sankey', withDims(rows, [PROJ, PROJ]), {}, flows) as AnyOption).series[0];
    expect(series.data.slice(0, 2)).toEqual([
      { id: '1:11', name: 'Apollo', itemStyle: { color: 'p0' } },
      { id: '1:"__other__"', name: 'Other', itemStyle: { color: 'muted' } },
    ]);
  });

  it('names the flow or the node and its total in the tooltip, escaped', () => {
    const rows = [row([p1, t1], 3), row([p1, k(2, 'B&B')], 2)];
    const option = toOption('sankey', withDims(rows, [PROJ, PROJ]), {}, flows) as AnyOption;
    const { formatter } = option.tooltip;
    expect(option.tooltip.trigger).toBe('item');
    expect(formatter({ dataType: 'edge', data: { source: '1:11', target: '2:2' }, value: 2 })).toBe('Apollo → B&amp;B: 2.0 weeks');
    expect(formatter({ dataType: 'node', data: { id: '1:11' }, name: 'Apollo', value: 5 })).toBe('Apollo: 5.0 weeks');
    expect(formatter({ dataType: 'node', data: { id: '2:1' }, name: 'Alpha team', value: 99 })).toBe('Alpha team: 3.0 weeks');
    // ECharts names a node with an id by that id: the node's own name is used
    expect(formatter({ dataType: 'node', data: { id: '1:11' }, name: '1:11', value: 5 })).toBe('Apollo: 5.0 weeks');
    expect(option.series[0].label.formatter({ data: { id: '2:2' }, name: '2:2' })).toBe('B&B');
    expect(option.series[0].label.formatter({})).toBe('');
    // Unknown ids: what ECharts gave
    expect(formatter({ dataType: 'edge', data: {}, value: 1 })).toBe(' → : 1.0 weeks');
    expect(formatter({ name: 'X', value: 4 })).toBe('X: 4.0 weeks');
    expect(formatter({})).toBe(': –');
  });

  it('flows one dimension into one node named after the measure (only the API sends one)', () => {
    const series = (toOption('sankey', withDims([row([p1], 3), row([p2], 1)], [PROJ]), {}, flows, 'Booked weeks') as AnyOption).series[0];
    expect(series.data).toEqual([
      { id: '1:11', name: 'Apollo', itemStyle: { color: 'p0' } },
      { id: '1:12', name: 'Borealis', itemStyle: { color: 'p1' } },
      { id: '2:"__measure__"', name: 'Booked weeks', itemStyle: { color: 'p2' } },
    ]);
    expect(series.links).toEqual([
      { source: '1:11', target: '2:"__measure__"', value: 3 },
      { source: '1:12', target: '2:"__measure__"', value: 1 },
    ]);
    const unnamed = (toOption('sankey', result([row([], 2)], 0), {}, flows) as AnyOption).series[0];
    expect(unnamed.data.map((n: AnyOption) => n.name)).toEqual(['Total', 'Value']);
  });
});

describe('hasDrawableData', () => {
  const rows = (values: (number | null)[]) => result(values.map((v, i) => row([k(i, `V${i}`)], v)), 1);

  it('needs a total for a gauge', () => {
    expect(hasDrawableData('gauge', { ...rows([]), total: 0 })).toBe(true);
    expect(hasDrawableData('gauge', { ...rows([5]), total: null })).toBe(false);
  });

  it('needs a value (a zero counts) for a heatmap', () => {
    expect(hasDrawableData('heatmap', rows([null, 0]))).toBe(true);
    expect(hasDrawableData('heatmap', rows([null, null]))).toBe(false);
    expect(hasDrawableData('heatmap', rows([]))).toBe(false);
  });

  it('needs a positive value for a treemap or a sankey', () => {
    for (const kind of ['treemap', 'sankey'] as const) {
      expect(hasDrawableData(kind, rows([0, null, 2]))).toBe(true);
      expect(hasDrawableData(kind, rows([0, null, -1]))).toBe(false);
      expect(hasDrawableData(kind, rows([]))).toBe(false);
    }
  });

  it('needs a row for a bar, line or pie chart; a KPI and a table always draw', () => {
    for (const kind of ['bar', 'line', 'pie'] as const) {
      expect(hasDrawableData(kind, rows([null]))).toBe(true);
      expect(hasDrawableData(kind, rows([]))).toBe(false);
    }
    expect(hasDrawableData('kpi', rows([]))).toBe(true);
    expect(hasDrawableData('table', rows([]))).toBe(true);
  });
});
