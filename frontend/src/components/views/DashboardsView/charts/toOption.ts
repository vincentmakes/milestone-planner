/**
 * A metric result → an ECharts option, per widget kind (bar, line, pie;
 * gauge, heatmap, treemap and sankey in their own sections below, and
 * `hasDrawableData`, the guard of a blank chart, at the end).
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
 * - The four newer kinds keep the accessible description but no
 *   decal hatching (`aria.decal` off); their colours come from the theme's
 *   named tokens (`good` / `warn` / `bad`, `heatLow` / `heatHigh`), each
 *   with a palette fallback.
 */

import type { MetricKey, MetricResult, MetricUnit, WidgetKind, WidgetOptions } from '@/types';
import { formatMetric, normaliseKey, OTHER_KEY, unitWord, widgetColor } from '@/utils/metrics';
import type { ChartTheme } from './echartsTheme';

export type ChartKind = Extract<WidgetKind, 'bar' | 'line' | 'pie' | 'gauge' | 'heatmap' | 'treemap' | 'sankey'>;

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
  /** Less than `NARROW_CATEGORY_PX` per category (a heatmap: per column) */
  narrow?: boolean;
  /** A heatmap has room for a value in every cell (`heatmapLabelsFit`) */
  labelsFit?: boolean;
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

/** A value with its unit word ("70.1 weeks"); nothing after a percentage or a missing value ("–"). */
function withUnit(value: number | null | undefined, unit: MetricUnit, format: WidgetOptions | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return formatMetric(null, unit);
  const text = formatMetric(value, unit, format);
  const word = unit !== 'percent' && format?.number_format !== 'percent' ? unitWord(value, unit, format) : '';
  return word ? `${text} ${word}` : text;
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text for a tooltip `formatter`: ECharts writes its string as HTML, and labels are people's data. */
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);

/** The four new kinds keep the accessible description but draw no decal hatching (bars and pies do). */
const quietAria = () => ({ enabled: true, decal: { show: false } });

// ---------------------------------------------------------------------------
// Gauge
// ---------------------------------------------------------------------------

/** The colours of a gauge's bands; `plain` without a target. */
export interface GaugeColours {
  good: string;
  warn: string;
  bad: string;
  plain: string;
}

/** The band names, standing in for colours when `gaugeScale` is called without any (tests, Task 3). */
export const GAUGE_BANDS: GaugeColours = { good: 'good', warn: 'warn', bad: 'bad', plain: 'plain' };

/** A gauge's scale: its ends, the coloured stops of its track and the colour of a value's band. */
export interface GaugeScale {
  min: number;
  max: number;
  /** `[fraction of the track, colour]`, non-decreasing, the last at 1 */
  stops: [number, string][];
  /** The colour of the band `value` falls in */
  band: (value: number) => string;
}

const ceil10 = (value: number): number => Math.ceil(value / 10) * 10;

/** The smallest 1, 2 or 5 × 10ⁿ at least `value` (1 for nothing positive). */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  for (let exponent = Math.floor(Math.log10(value)) - 1; ; exponent += 1) {
    for (const mantissa of [1, 2, 5]) {
      const candidate = exponent >= 0 ? mantissa * 10 ** exponent : mantissa / 10 ** -exponent;
      if (candidate >= value) return candidate;
    }
  }
}

/** The largest gauge target, the server's (`MAX_GAUGE_TARGET` in `app/schemas/dashboard.py`). */
export const MAX_GAUGE_TARGET = 1_000_000_000;

/** A stored target, when it is one (finite, from 0 to `MAX_GAUGE_TARGET`). */
export const gaugeTarget = (target: number | null | undefined): number | null =>
  typeof target === 'number' && Number.isFinite(target) && target >= 0 && target <= MAX_GAUGE_TARGET ? target : null;

/**
 * The scale of a gauge of `value` against `target`, in `unit`.
 *
 * `min` is 0, or the value when it is negative (available days). `max`: a
 * percentage ends at 120 at least, else at the value or the target rounded up
 * to ten; any other unit at the nice number (1, 2, 5 × 10ⁿ) past 125 % of the
 * target and 110 % of the value. With a target the track is green up to it,
 * amber up to 100 % (a percentage) or 115 % of the target (any other unit) —
 * no amber band when the target is 100 % or more, a value at the target is
 * then red — and red after; without
 * one it is the plain colour. The stops are fractions of the track from
 * `min` to `max`, so a negative minimum keeps every band at its value.
 */
export function gaugeScale(
  value: number,
  target: number | null | undefined,
  unit: MetricUnit,
  colours: GaugeColours = GAUGE_BANDS
): GaugeScale {
  const goal = gaugeTarget(target);
  const percent = unit === 'percent';
  const min = Math.min(0, value);
  const max = percent
    ? Math.max(120, ceil10(value), ceil10(goal ?? 0))
    : niceCeil(Math.max((goal ?? 0) * 1.25, value * 1.1, 1));
  if (goal === null) return { min, max, stops: [[1, colours.plain]], band: () => colours.plain };
  // The amber band's end, as a value: 100 % or 115 % of the target, never before the target.
  const amber = Math.max(goal, Math.min(max, percent ? 100 : goal * 1.15));
  const fraction = (v: number) => (v - min) / (max - min);
  return {
    min,
    max,
    stops: [
      [fraction(goal), colours.good],
      [fraction(amber), colours.warn],
      [1, colours.bad],
    ],
    // Without an amber band (`amber === goal`), a value at the target is past it:
    // red, like the track there — never amber, a colour the track does not show.
    band: (v) => (v < goal ? colours.good : amber > goal && v <= amber ? colours.warn : colours.bad),
  };
}

/** The gauge's track (and progress) width in pixels. */
export const GAUGE_TRACK_WIDTH = 20;

/** A gauge of the result's total (its dimensions, which only the API can send, are ignored). */
function gaugeOption(result: MetricResult, opts: WidgetOptions, theme: ChartTheme): ChartOption {
  const palette = theme.palette;
  const unit = result.unit;
  const value = result.total ?? 0;
  const target = gaugeTarget(opts.target);
  const scale = gaugeScale(value, target, unit, {
    good: theme.good ?? palette[1],
    warn: theme.warn ?? palette[2],
    bad: theme.bad ?? palette[7] ?? palette[0],
    plain: palette[0],
  });
  return {
    aria: quietAria(),
    series: [
      {
        type: 'gauge',
        min: scale.min,
        max: scale.max,
        startAngle: 210,
        endAngle: -30,
        progress: { show: true, width: GAUGE_TRACK_WIDTH, itemStyle: { color: scale.band(value) } },
        axisLine: { lineStyle: { width: GAUGE_TRACK_WIDTH, color: scale.stops } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        title: { show: target !== null, offsetCenter: [0, '70%'], color: theme.textSecondary },
        detail: {
          valueAnimation: false,
          offsetCenter: [0, '20%'],
          formatter: (v: number) => withUnit(v, unit, opts),
          color: theme.textPrimary,
        },
        data: [
          {
            value,
            // In the widget's number format, like the value ("Target 20 days" with Integer).
            name: target !== null ? `Target ${withUnit(target, unit, opts)}` : '',
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

/** A heatmap shows a value in a cell of at least this many pixels wide… */
export const HEATMAP_LABEL_MIN_WIDTH = 44;
/** …and this many high. */
export const HEATMAP_LABEL_MIN_HEIGHT = 20;

/**
 * What the chart keeps beside and below the cells: the grid's 8 + 16 px and
 * the row labels (up to 120 px) across; the grid's 8 px, the colour scale's
 * 56 px and the column labels (about 24 px) down.
 */
export const HEATMAP_RESERVED_WIDTH = 144;
export const HEATMAP_RESERVED_HEIGHT = 88;

/**
 * Whether every cell of an `xCount` × `yCount` heatmap in a `width` × `height`
 * px chart has room for its value: the cells share what the axis labels and
 * the colour scale leave (measured on the whole chart, a value such as
 * "116.7 %" overflowed its cell just above the threshold).
 */
export const heatmapLabelsFit = (width: number, height: number, xCount: number, yCount: number): boolean =>
  (width - HEATMAP_RESERVED_WIDTH) / Math.max(1, xCount) >= HEATMAP_LABEL_MIN_WIDTH &&
  (height - HEATMAP_RESERVED_HEIGHT) / Math.max(1, yCount) >= HEATMAP_LABEL_MIN_HEIGHT;

/** The one column of a one-dimension heatmap (an API-only shape): the measure. */
const MEASURE_KEY_ID = '__measure__';

/** Period buckets in time order: their keys (`2026-01`, `2026-Q1`, `2026-W01`) sort as text. */
const chronological = (keys: MetricKey[]): MetricKey[] => {
  const rank = (key: MetricKey) => (key.key === OTHER_KEY ? 2 : key.key === null ? 1 : 0);
  return [...keys].sort((a, b) => rank(a) - rank(b) || String(a.key).localeCompare(String(b.key)));
};

export interface HeatmapAxes {
  /** The columns, left to right */
  x: MetricKey[];
  /** The rows, top to bottom */
  y: MetricKey[];
  xOf: (row: MetricResult['rows'][number]) => MetricKey | undefined;
  yOf: (row: MetricResult['rows'][number]) => MetricKey | undefined;
}

/**
 * A heatmap's axes: a period dimension runs along x and the other dimension
 * down y; without a period the first dimension is y and the second x. Values
 * keep the server's order ("Other" last), periods their time order. A
 * one-dimension result (only the API sends one) is a single column named
 * after the measure.
 */
export function heatmapAxes(result: MetricResult, measureLabel?: string): HeatmapAxes {
  const ordered = (index: number) => {
    const keys = distinctKeys(result, index);
    return result.dimensions[index]?.kind === 'period' ? chronological(keys) : keys;
  };
  if (result.dimensions.length < 2) {
    const measure: MetricKey = { key: MEASURE_KEY_ID, label: measureLabel || 'Value' };
    return { x: [measure], y: ordered(0), xOf: () => measure, yOf: (row) => row.keys[0] ?? TOTAL_KEY };
  }
  const xIndex = result.dimensions[0].kind === 'period' ? 0 : 1;
  const yIndex = 1 - xIndex;
  return { x: ordered(xIndex), y: ordered(yIndex), xOf: (row) => row.keys[xIndex], yOf: (row) => row.keys[yIndex] };
}

/** A heatmap's column and row counts (`EChart` decides `narrow` and `labelsFit` with them). */
export const heatmapCounts = (result: MetricResult): { x: number; y: number } => {
  const axes = heatmapAxes(result);
  return { x: axes.x.length, y: axes.y.length };
};

function heatmapOption(
  result: MetricResult,
  opts: WidgetOptions,
  theme: ChartTheme,
  measureLabel: string | undefined,
  layout: ChartLayout
): ChartOption {
  const unit = result.unit;
  const axes = heatmapAxes(result, measureLabel);
  const xIndex = new Map(axes.x.map((key, i) => [keyId(key), i]));
  const yIndex = new Map(axes.y.map((key, i) => [keyId(key), i]));
  // One cell per (column, row); a null cell (a ratio over nothing) has no point.
  const cells = new Map<string, [number, number, number | null]>();
  for (const row of result.rows) {
    const xKey = axes.xOf(row);
    const yKey = axes.yOf(row);
    const x = xKey && xIndex.get(keyId(xKey));
    const y = yKey && yIndex.get(keyId(yKey));
    if (x === undefined || y === undefined) continue;
    const id = `${x}:${y}`;
    const cell = cells.get(id);
    cells.set(id, [x, y, addValue(cell ? cell[2] : undefined, row.value)]);
  }
  const data = [...cells.values()].filter((cell): cell is [number, number, number] => cell[2] !== null);
  const values = data.map((cell) => cell[2]);
  const minValue = values.length ? values.reduce((a, b) => Math.min(a, b)) : 0;
  const maxValue = values.length ? values.reduce((a, b) => Math.max(a, b)) : 0;
  const min = Math.min(0, minValue);
  const max = unit === 'percent' ? Math.max(100, maxValue, min + 1) : Math.max(maxValue, min + 1);
  const palette = theme.palette;
  const narrow = Boolean(layout.narrow);
  const axis = (keys: MetricKey[], axisLabel: Record<string, unknown>) => ({
    type: 'category',
    data: keys.map((key) => key.label),
    boundaryGap: true,
    axisLabel,
  });
  const valueOf = (params: { value?: unknown }) => (Array.isArray(params.value) ? (params.value[2] as number) : null);

  return {
    aria: quietAria(),
    tooltip: {
      trigger: 'item',
      formatter: (params: { value?: unknown }) => {
        const [x, y, value] = params.value as [number, number, number];
        return escapeHtml(`${axes.y[y]?.label ?? ''} · ${axes.x[x]?.label ?? ''}: ${withUnit(value, unit, opts)}`);
      },
    },
    // Room at the bottom for the colour scale; the axis labels inside the box.
    grid: { left: 8, right: 16, top: 8, bottom: 56, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
    xAxis: axis(axes.x, {
      interval: 0,
      overflow: 'truncate',
      width: narrow ? NARROW_LABEL_WIDTH : LABEL_WIDTH,
      ...(narrow ? { rotate: 30 } : {}),
    }),
    // First row on top
    yAxis: { ...axis(axes.y, { interval: 0, overflow: 'truncate', width: 120 }), inverse: true },
    visualMap: {
      type: 'continuous',
      min,
      max,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemWidth: 10,
      itemHeight: 120,
      text: [formatMetric(max, unit, opts), formatMetric(min, unit, opts)],
      textStyle: { color: theme.textSecondary },
      inRange: { color: [theme.heatLow ?? theme.background ?? 'transparent', theme.heatHigh ?? palette[0]] },
    },
    series: [
      {
        type: 'heatmap',
        data,
        itemStyle: { borderColor: theme.background, borderWidth: 1 },
        label: {
          show: Boolean(layout.labelsFit),
          formatter: (params: { value?: unknown }) => formatMetric(valueOf(params), unit, opts),
        },
        emphasis: { itemStyle: { borderColor: theme.textPrimary, borderWidth: 1 } },
      },
    ],
  };
}

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
  if (kind === 'gauge') return gaugeOption(result, opts, theme);
  if (kind === 'heatmap') return heatmapOption(result, opts, theme, measureLabel, layout);
  if (kind === 'treemap') return treemapOption(result, opts, theme);
  if (kind === 'sankey') return sankeyOption(result, opts, theme, measureLabel);

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

// ---------------------------------------------------------------------------
// Treemap
// ---------------------------------------------------------------------------

/** A positive value: treemap boxes and sankey flows draw nothing of a null, a zero or a negative one. */
const positive = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;

interface TreemapNode {
  name: string;
  value: number;
  itemStyle: { color: string };
  children?: TreemapNode[];
}

/**
 * Boxes sized by value: two dimensions nest the second in the first (each
 * parent the sum of its children, the children in its colour), one is flat.
 * A period dimension (only the API sends one) makes it flat over the other
 * dimension. Rows with nothing positive are left out; colours keep their
 * position ("Other" muted).
 */
function treemapOption(result: MetricResult, opts: WidgetOptions, theme: ChartTheme): ChartOption {
  const unit = result.unit;
  const palette = theme.palette;
  const muted = theme.textMuted;
  const dims = result.dimensions;
  const periods = dims.slice(0, 2).map((d) => d.kind === 'period');
  const nested = dims.length >= 2 && !periods[0] && !periods[1];
  const colour = (key: MetricKey, i: number) => widgetColor(key, i, palette, muted);

  let data: TreemapNode[];
  if (nested) {
    const children = new Map<string, Map<string, { key: MetricKey; value: number }>>();
    for (const row of result.rows) {
      const [parent, child] = row.keys;
      if (!parent || !child || !positive(row.value)) continue;
      const kids = children.get(keyId(parent)) ?? new Map<string, { key: MetricKey; value: number }>();
      children.set(keyId(parent), kids);
      const kid = kids.get(keyId(child));
      kids.set(keyId(child), { key: child, value: (kid?.value ?? 0) + row.value });
    }
    data = distinctKeys(result, 0).flatMap((key, i) => {
      const kids = children.get(keyId(key));
      if (!kids) return [];
      const color = colour(key, i);
      const list = [...kids.values()];
      return [
        {
          name: key.label,
          value: list.reduce((sum, kid) => sum + kid.value, 0),
          itemStyle: { color },
          children: list.map((kid) => ({ name: kid.key.label, value: kid.value, itemStyle: { color } })),
        },
      ];
    });
  } else {
    const index = dims.length >= 2 && periods[0] && !periods[1] ? 1 : 0;
    const sums = new Map<string, number>();
    for (const row of result.rows) {
      const key = row.keys[index] ?? (index === 0 ? TOTAL_KEY : undefined);
      if (!key || !positive(row.value)) continue;
      sums.set(keyId(key), (sums.get(keyId(key)) ?? 0) + row.value);
    }
    data = distinctKeys(result, index).flatMap((key, i) => {
      const value = sums.get(keyId(key));
      return value === undefined ? [] : [{ name: key.label, value, itemStyle: { color: colour(key, i) } }];
    });
  }

  const numberOf = (value: unknown) => (typeof value === 'number' ? value : null);
  return {
    aria: quietAria(),
    tooltip: {
      trigger: 'item',
      formatter: (params: { name?: string; value?: unknown }) =>
        escapeHtml(`${params.name ?? ''}: ${withUnit(numberOf(params.value), unit, opts)}`),
    },
    series: [
      {
        type: 'treemap',
        // Edges, not `width: '100%'`: ECharts centres a sized treemap and, on a
        // resize, keeps the offset of the first size — the boxes then slide
        // down and right, cut by the canvas.
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        label: {
          formatter: (params: { name?: string; value?: unknown }) =>
            `${params.name ?? ''}\n${formatMetric(numberOf(params.value), unit, opts)}`,
        },
        // ECharts counts its virtual root as level 0: the root's gap parts the
        // first dimension's boxes, theirs part the second's under their name.
        levels: [
          { itemStyle: { gapWidth: 2, borderColor: theme.background, borderWidth: 0 } },
          {
            itemStyle: { gapWidth: 1, borderColor: theme.background, borderWidth: 2 },
            upperLabel: { show: true, height: 22, color: theme.textPrimary },
          },
          { itemStyle: { borderColor: theme.background } },
        ],
        data,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Sankey
// ---------------------------------------------------------------------------

/** The widest a sankey node's label is drawn (truncated beyond). */
const SANKEY_LABEL_WIDTH = 120;

/**
 * Flows from the first dimension's values (left) to the second's (right),
 * each flow the value of the row (rows with nothing positive are left out,
 * and so are the values without a flow). Node ids carry their side (`1:` /
 * `2:`), so a value present on both sides stays two nodes; the palette
 * continues from the left column into the right one ("Other" muted). A
 * one-dimension result (only the API sends one) flows into one node named
 * after the measure.
 */
/** What ECharts hands a sankey tooltip or label: a node (`data.id`) or a flow (`dataType: 'edge'`). */
interface SankeyTooltipParams {
  dataType?: string;
  data?: { id?: string; source?: string; target?: string };
  name?: string;
  value?: unknown;
}

function sankeyOption(
  result: MetricResult,
  opts: WidgetOptions,
  theme: ChartTheme,
  measureLabel: string | undefined
): ChartOption {
  const unit = result.unit;
  const palette = theme.palette;
  const muted = theme.textMuted;
  const two = result.dimensions.length >= 2;
  const left = distinctKeys(result, 0);
  const measure: MetricKey = { key: MEASURE_KEY_ID, label: measureLabel || 'Value' };
  const right = two ? distinctKeys(result, 1) : [measure];
  const idOf = (side: 1 | 2, key: MetricKey) => `${side}:${keyId(key)}`;

  const flows = new Map<string, { source: string; target: string; value: number }>();
  for (const row of result.rows) {
    const from = row.keys[0] ?? TOTAL_KEY;
    const to = two ? row.keys[1] : measure;
    if (!to || !positive(row.value)) continue;
    const source = idOf(1, from);
    const target = idOf(2, to);
    const id = `${source}→${target}`;
    flows.set(id, { source, target, value: (flows.get(id)?.value ?? 0) + row.value });
  }
  const links = [...flows.values()];
  const totals = new Map<string, number>();
  for (const link of links) {
    totals.set(link.source, (totals.get(link.source) ?? 0) + link.value);
    totals.set(link.target, (totals.get(link.target) ?? 0) + link.value);
  }
  const nodes = [
    ...left.map((key, i) => ({
      id: idOf(1, key),
      name: key.label,
      itemStyle: { color: widgetColor(key, i, palette, muted) },
    })),
    ...right.map((key, i) => ({
      id: idOf(2, key),
      name: key.label,
      itemStyle: { color: widgetColor(key, i + left.length, palette, muted) },
    })),
  ].filter((node) => totals.has(node.id));
  const nameOf = new Map(nodes.map((node) => [node.id, node.name]));

  return {
    aria: quietAria(),
    tooltip: {
      trigger: 'item',
      formatter: (params: SankeyTooltipParams) => {
        const data = params.data ?? {};
        const value = typeof params.value === 'number' ? params.value : null;
        if (params.dataType === 'edge') {
          const from = nameOf.get(data.source ?? '') ?? '';
          const to = nameOf.get(data.target ?? '') ?? '';
          return escapeHtml(`${from} → ${to}: ${withUnit(value, unit, opts)}`);
        }
        // `params.name` is the node's id: its name comes from the node.
        const name = nameOf.get(data.id ?? '') ?? params.name ?? '';
        return escapeHtml(`${name}: ${withUnit(totals.get(data.id ?? '') ?? value, unit, opts)}`);
      },
    },
    series: [
      {
        type: 'sankey',
        nodeAlign: 'justify',
        draggable: false,
        emphasis: { focus: 'adjacency' },
        lineStyle: { color: 'gradient', opacity: 0.4 },
        layoutIterations: 32,
        // The second column's labels sit right of its nodes: leave them their
        // width (ECharts' default 20 % cuts them on a narrow card).
        right: SANKEY_LABEL_WIDTH + 8,
        // A node with an `id` is named by it in ECharts' own label: name it here.
        label: {
          overflow: 'truncate',
          width: SANKEY_LABEL_WIDTH,
          color: theme.textPrimary,
          formatter: (params: SankeyTooltipParams) => nameOf.get(params.data?.id ?? '') ?? '',
        },
        data: nodes,
        links,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Blank-chart guard
// ---------------------------------------------------------------------------

/**
 * Whether a widget of `kind` draws anything of `result`: a gauge needs a
 * total, a heatmap one value (a zero counts), a treemap or a sankey one
 * positive value, a bar, line or pie chart one row. `WidgetCard` shows
 * "Nothing to show for this period." otherwise. A KPI and a table always
 * draw (they show their own empty state).
 */
export function hasDrawableData(kind: WidgetKind, result: MetricResult): boolean {
  switch (kind) {
    case 'gauge':
      return result.total !== null;
    case 'heatmap':
      return result.rows.some((row) => row.value !== null);
    case 'treemap':
    case 'sankey':
      return result.rows.some((row) => positive(row.value));
    case 'bar':
    case 'line':
    case 'pie':
      return result.rows.length > 0;
    default:
      return true;
  }
}
