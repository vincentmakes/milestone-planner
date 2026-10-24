/**
 * A metric result → an ECharts option, per widget kind (bar, line, pie).
 *
 * Pure: the result, the widget's display options and the chart theme in, an
 * option out (`EChart` applies it with `notMerge`).
 * - The category axis holds the first dimension's values in the server's
 *   order (periods chronological, "Other" last) — always a category axis,
 *   never a `time` axis: the server's period labels are the buckets.
 * - A second dimension becomes the series, one per value; a missing
 *   (category × series) point is 0 (the server zero-fills period buckets
 *   only when the period is the single dimension). A `null` value (a ratio
 *   over nothing: utilisation of a week without capacity) stays `null`, a
 *   gap in the bar or line, and a pie leaves its slice out; values over
 *   100 % are drawn as they are.
 * - `stacked` stacks the series; 100 % when `percent` is set or the server
 *   already answered percentages (`unit: 'percent'`): the value axis ends at
 *   100 (unless the result has a `note`: a fact counted in several values can
 *   take a stack past 100) and, when the server did not compute them, each
 *   category is normalised to 100 here — a single dimension against the
 *   server's distinct `total`, never the sum of its rows.
 * - Every category label is shown (`interval: 0`); a vertical bar or line
 *   chart with more than six categories, or a narrow one (`layout.narrow`:
 *   less than 90 px per category, measured by `EChart`), tilts them by 30°,
 *   and a narrow one truncates them at 72 px instead of 96.
 * - `orientation: 'horizontal'` puts the categories on the vertical axis.
 * - Colours: a value's own colour (team, tag, field item), else the palette
 *   by position; "Other" in the muted text colour.
 * - The legend shows the series of a second dimension unless
 *   `show_legend === false`; a pie shows its slices in a legend only when
 *   `show_legend === true` (its labels name them already). The tooltip
 *   formats values with `formatMetric` followed by the unit word ("3 weeks";
 *   nothing after a percentage). A single series is named after the measure
 *   (`measureLabel`, "Booked weeks"), two series after the second
 *   dimension's values.
 */

import type { MetricKey, MetricResult, MetricUnit, WidgetKind, WidgetOptions } from '@/types';
import { formatMetric, normaliseKey, OTHER_KEY, unitWord, widgetColor } from '@/utils/metrics';
import type { ChartTheme } from './echartsTheme';

export type ChartKind = Extract<WidgetKind, 'bar' | 'line' | 'pie'>;

export type ChartOption = Record<string, unknown>;

/** The category / series value of a key, as a map key (null and "Other" sort last). */
const keyId = (key: MetricKey | undefined): string => JSON.stringify(normaliseKey(key?.key ?? null));

const TOTAL_KEY: MetricKey = { key: '__total__', label: 'Total' };

/** Distinct values of dimension `index` in order of appearance; empty buckets, then "Other", last. */
function distinctKeys(result: MetricResult, index: number): MetricKey[] {
  const seen = new Map<string, MetricKey>();
  for (const row of result.rows) {
    const key = row.keys[index] ?? (index === 0 ? TOTAL_KEY : undefined);
    if (!key) continue;
    const id = keyId(key);
    if (!seen.has(id)) seen.set(id, key);
  }
  const rank = (key: MetricKey) => (key.key === OTHER_KEY ? 2 : key.key === null ? 1 : 0);
  return [...seen.values()]
    .map((key, order) => ({ key, order }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.order - b.order)
    .map(({ key }) => key);
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** A row's value added to a point: null only while every value so far is null (`undefined` = none yet). */
const addValue = (sum: number | null | undefined, value: number | null): number | null => {
  if (value === null) return sum ?? null;
  return (sum ?? 0) + value;
};

/** Categories above which a vertical chart tilts its labels. */
export const ROTATE_ABOVE = 6;

/** Below this many pixels per category a chart is narrow (`isNarrow`). */
export const NARROW_CATEGORY_PX = 90;

/** A category label's width: truncated past it. */
export const LABEL_WIDTH = 96;
export const NARROW_LABEL_WIDTH = 72;

/** How the chart is laid out on screen (measured by `EChart`). */
export interface ChartLayout {
  /** Less than `NARROW_CATEGORY_PX` per category */
  narrow?: boolean;
}

/** The number of categories the chart draws (the first dimension's distinct values). */
export const categoryCount = (result: MetricResult): number => distinctKeys(result, 0).length;

/** Whether a chart `width` px wide is narrow for `categories` categories (an unmeasured width never is). */
export const isNarrow = (width: number, categories: number): boolean =>
  width > 0 && categories > 0 && width / categories < NARROW_CATEGORY_PX;

/** Axis tick labels: up to one decimal, `%` on a percentage axis. */
const axisLabel = (percent: boolean) => (value: number) =>
  formatMetric(value, percent ? 'percent' : 'days', { number_format: Number.isInteger(value) ? 'integer' : null });

/** The units of whole counts (the value axis then ticks in whole steps). */
const COUNT_UNITS: ReadonlySet<MetricUnit> = new Set<MetricUnit>(['count', 'people', 'projects', 'phases', 'equipment']);

export function toOption(
  kind: ChartKind,
  result: MetricResult,
  options: WidgetOptions | null | undefined,
  theme: ChartTheme,
  /** The measure's name, for a single series ("Booked weeks") */
  measureLabel?: string,
  layout: ChartLayout = {}
): ChartOption {
  const opts = options ?? {};
  /** A value with its unit word ("70.1 weeks"); nothing after a percentage or a missing value ("–"). */
  const withUnit = (value: number | null | undefined, unit: MetricUnit, format: WidgetOptions | null) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return formatMetric(null, unit);
    const text = formatMetric(value, unit, format);
    const word = unit !== 'percent' && format?.number_format !== 'percent' ? unitWord(value, unit, format) : '';
    return word ? `${text} ${word}` : text;
  };
  const palette = theme.palette;
  const muted = theme.textMuted;
  const aria = { show: true, decal: { show: true } };
  const categories = distinctKeys(result, 0);

  if (kind === 'pie') {
    const valueOf = new Map<string, number | null>();
    for (const row of result.rows) {
      const id = keyId(row.keys[0] ?? TOTAL_KEY);
      valueOf.set(id, addValue(valueOf.get(id), row.value));
    }
    const unit = result.unit;
    return {
      aria,
      tooltip: {
        trigger: 'item',
        valueFormatter: (value: number | null) => withUnit(value, unit, opts),
      },
      legend: opts.show_legend === true ? { show: true, type: 'scroll', top: 0 } : { show: false },
      series: [
        {
          type: 'pie',
          radius: ['40%', '70%'],
          avoidLabelOverlap: true,
          label: { color: theme.textSecondary, overflow: 'truncate', width: 120 },
          // A slice of nothing (null) is left out; colours keep their position.
          data: categories.flatMap((key, i) => {
            const value = valueOf.get(keyId(key));
            if (value === null || value === undefined) return [];
            return [{ name: key.label, value, itemStyle: { color: widgetColor(key, i, palette, muted) } }];
          }),
        },
      ],
    };
  }

  const twoDimensions = result.dimensions.length >= 2;
  const seriesKeys: (MetricKey | null)[] = twoDimensions ? distinctKeys(result, 1) : [null];
  const percentMode = Boolean(opts.percent) || result.unit === 'percent';
  const normalise = Boolean(opts.percent) && result.unit !== 'percent';
  const displayUnit: MetricUnit = percentMode ? 'percent' : result.unit;

  // values[series][category]: 0 for a missing point, null for a ratio over nothing
  const values: (number | null)[][] = seriesKeys.map(() => categories.map(() => 0));
  const seen = seriesKeys.map(() => categories.map(() => false));
  const categoryIndex = new Map(categories.map((key, i) => [keyId(key), i]));
  const seriesIndex = new Map(seriesKeys.map((key, i) => [key ? keyId(key) : 'null', i]));
  for (const row of result.rows) {
    const c = categoryIndex.get(keyId(row.keys[0] ?? TOTAL_KEY));
    const s = twoDimensions ? seriesIndex.get(keyId(row.keys[1])) : 0;
    if (c === undefined || s === undefined) continue;
    values[s][c] = addValue(seen[s][c] ? values[s][c] : undefined, row.value);
    seen[s][c] = true;
  }
  if (normalise) {
    if (twoDimensions) {
      categories.forEach((_, c) => {
        const sum = values.reduce<number>((acc, series) => acc + (series[c] ?? 0), 0);
        values.forEach((series) => {
          const v = series[c];
          series[c] = v === null ? null : sum > 0 ? round((v / sum) * 100) : 0;
        });
      });
    } else {
      // The server's distinct total: a multi-valued dimension's rows add up
      // to more than it, and their sum would understate every share.
      const total = result.total ?? 0;
      values[0] = values[0].map((v) => (v === null ? null : total > 0 ? round((v / total) * 100) : 0));
    }
  }

  const stacked = Boolean(opts.stacked) && twoDimensions;
  // A single series whose values carry their own colours (teams, tags,
  // field items) shows them per bar; otherwise one colour for the series.
  const ownColours = !twoDimensions && categories.some((key) => key.color);
  const series = seriesKeys.map((key, s) => {
    const color = key ? widgetColor(key, s, palette, muted) : widgetColor(null, 0, palette);
    return {
      type: kind,
      name: key ? key.label : measureLabel || 'Value',
      ...(stacked ? { stack: 'total' } : {}),
      ...(kind === 'line' ? { showSymbol: categories.length <= 24, ...(stacked ? { areaStyle: { opacity: 0.25 } } : {}) } : {}),
      ...(kind === 'bar' ? { barMaxWidth: 48 } : {}),
      itemStyle: { color },
      ...(kind === 'line' ? { lineStyle: { color } } : {}),
      data: values[s].map((value, c) =>
        ownColours && kind === 'bar'
          ? { value, itemStyle: { color: widgetColor(categories[c], c, palette, muted) } }
          : value
      ),
    };
  });

  const showLegend = twoDimensions && opts.show_legend !== false;
  const horizontal = kind === 'bar' && opts.orientation === 'horizontal';
  const categoryAxis = {
    type: 'category',
    data: categories.map((key) => key.label),
    ...(kind === 'line' ? { boundaryGap: false } : {}),
    ...(horizontal ? { inverse: true } : {}),
    axisLabel: horizontal
      ? { interval: 0, hideOverlap: true, overflow: 'truncate', width: 120 }
      : {
          interval: 0,
          overflow: 'truncate',
          width: layout.narrow ? NARROW_LABEL_WIDTH : LABEL_WIDTH,
          ...(layout.narrow || categories.length > ROTATE_ABOVE ? { rotate: 30 } : {}),
        },
  };
  const valueAxis = {
    type: 'value',
    ...(stacked && percentMode && !result.note ? { max: 100 } : {}),
    // Counts are whole: no 0.2 / 0.4 ticks on an empty or small chart.
    ...(COUNT_UNITS.has(displayUnit) ? { minInterval: 1 } : {}),
    axisLabel: { formatter: axisLabel(percentMode) },
  };

  return {
    aria,
    legend: showLegend ? { show: true, type: 'scroll', top: 0 } : { show: false },
    grid: { left: 8, right: 16, top: showLegend ? 36 : 16, bottom: 8 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: kind === 'line' ? 'line' : 'shadow' },
      valueFormatter: (value: number | null) => withUnit(value, displayUnit, percentMode ? null : opts),
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series,
  };
}
