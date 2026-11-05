/**
 * The options of the four newer kinds through the real ECharts (SVG,
 * server-side rendering, dev build), not a fake: no ECharts warning, and the
 * texts a viewer reads — a sankey names its nodes (ECharts would label a node
 * with an `id` by that id), a treemap names its parent boxes (ECharts counts
 * its virtual root as level 0), a gauge shows its target, a heatmap its
 * values and scale. Text widths come from a fixed-width measure (jsdom has
 * no canvas).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as echarts from 'echarts';
import { toOption } from '../toOption';
import type { ChartKind, ChartOption } from '../toOption';
import { buildTheme, CHART_THEME_NAME, toEChartsTheme } from '../echartsTheme';
import type { MetricKey, MetricResult, WidgetOptions } from '@/types';

const TOKENS: Record<string, string> = {
  '--accent-blue': '#3b82f6',
  '--accent-green': '#10b981',
  '--accent-orange': '#f97316',
  '--accent-purple': '#8b5cf6',
  '--accent-cyan': '#06b6d4',
  '--accent-yellow': '#f59e0b',
  '--accent-teal': '#14b8a6',
  '--accent-red': '#ef4444',
  '--text-primary': '#e8edf4',
  '--text-secondary': '#8b99ab',
  '--text-muted': '#5a6a7a',
  '--border-color': '#2a3544',
  '--bg-card': '#151d2a',
  '--bg-tertiary': '#1a2332',
};
const theme = buildTheme((token) => TOKENS[token]);

beforeAll(() => {
  echarts.setPlatformAPI({ measureText: (text = '') => ({ width: text.length * 7 }) });
  echarts.registerTheme(CHART_THEME_NAME, toEChartsTheme(theme));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const k = (key: MetricKey['key'], label: string): MetricKey => ({ key, label });
const base = { truncated: false, warnings: [] };

/** The option rendered to SVG, the warnings ECharts logged, and the texts drawn. */
function render(kind: ChartKind, result: MetricResult, options: WidgetOptions = {}) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const chart = echarts.init(null, CHART_THEME_NAME, { renderer: 'svg', ssr: true, width: 600, height: 400 });
  const option: ChartOption = toOption(kind, result, options, theme, 'Booked weeks', { labelsFit: true });
  chart.setOption(option as echarts.EChartsOption, { notMerge: true });
  const svg = chart.renderToSVGString();
  chart.dispose();
  const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  return { svg, texts, logged: [...warn.mock.calls, ...error.mock.calls].map((call) => call.join(' ')) };
}

const teamMonth: MetricResult = {
  ...base,
  unit: 'weeks',
  dimensions: [
    { kind: 'team', label: 'Team' },
    { kind: 'period', label: 'Month' },
  ],
  rows: [
    { keys: [k(1, 'Alpha'), k('2026-02', 'Feb 2026')], value: 3 },
    { keys: [k(1, 'Alpha'), k('2026-03', 'Mar 2026')], value: null },
    { keys: [k(2, 'Beta'), k('2026-01', 'Jan 2026')], value: 5 },
  ],
  total: 8,
};

const siteProject: MetricResult = {
  ...base,
  unit: 'weeks',
  dimensions: [
    { kind: 'site', label: 'Site' },
    { kind: 'project', label: 'Project' },
  ],
  rows: [
    { keys: [k(1, 'Basel'), k(11, 'Apollo')], value: 3 },
    { keys: [k(1, 'Basel'), k(12, 'Borealis')], value: 2 },
    { keys: [k(2, 'Zurich'), k(13, 'Cygnus')], value: 4 },
    { keys: [k('__other__', 'Other'), k(13, 'Cygnus')], value: 1 },
  ],
  total: 10,
};

describe('the newer kinds through the real ECharts', () => {
  it('draws a gauge with its value and target', () => {
    const utilisation: MetricResult = { ...base, unit: 'percent', dimensions: [], rows: [{ keys: [], value: 72 }], total: 72 };
    const { texts, logged } = render('gauge', utilisation, { target: 85 });
    expect(logged).toEqual([]);
    expect(texts.some((t) => /^Target 85\s%$/.test(t))).toBe(true);
    expect(texts.some((t) => /^72\s%$/.test(t))).toBe(true);
    expect(render('gauge', utilisation).texts.some((t) => t.startsWith('Target'))).toBe(false);
  });

  it('draws a heatmap with its axes, its values and its scale', () => {
    const { texts, logged } = render('heatmap', teamMonth);
    expect(logged).toEqual([]);
    expect(texts).toEqual(expect.arrayContaining(['Alpha', 'Beta', 'Jan 2026', 'Feb 2026', '3.0', '5.0', '0.0']));
    // The null cell has no value drawn
    expect(texts.filter((t) => t === '3.0')).toHaveLength(1);
    expect(texts.indexOf('Jan 2026')).toBeLessThan(texts.indexOf('Feb 2026'));
  });

  it('names the parent boxes of a treemap above their children', () => {
    const { texts, logged } = render('treemap', siteProject);
    expect(logged).toEqual([]);
    expect(texts).toEqual(expect.arrayContaining(['Basel', 'Zurich', 'Other', 'Apollo', 'Cygnus']));
  });

  it('keeps a treemap on its canvas after a resize', () => {
    // Regression: sized `width: '100%'` and centred, the boxes kept the first
    // size's centring offset after a resize and were cut on the right and below.
    const chart = echarts.init(null, CHART_THEME_NAME, { renderer: 'svg', ssr: true, width: 500, height: 280 });
    const option = toOption('treemap', siteProject, {}, theme, 'Booked weeks', {});
    chart.setOption(option as echarts.EChartsOption, { notMerge: true });
    chart.resize({ width: 600, height: 400 });
    chart.setOption(option as echarts.EChartsOption, { notMerge: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the laid-out box is internal
    const layout = (chart as any).getModel().getSeriesByIndex(0).layoutInfo;
    chart.dispose();
    expect(layout).toMatchObject({ x: 0, y: 0, width: 600, height: 400 });
  });

  it("leaves a sankey's right-hand labels on the canvas", () => {
    const projectTeam: MetricResult = {
      ...base,
      unit: 'weeks',
      dimensions: [
        { kind: 'project', label: 'Project' },
        { kind: 'team', label: 'Team' },
      ],
      rows: [
        { keys: [k(11, 'Apollo'), k(1, 'Process Development')], value: 3 },
        { keys: [k(12, 'Borealis'), k(2, 'Analytical Lab')], value: 2 },
      ],
      total: 5,
    };
    const chart = echarts.init(null, CHART_THEME_NAME, { renderer: 'svg', ssr: true, width: 600, height: 400 });
    chart.setOption(toOption('sankey', projectTeam, {}, theme, 'Booked weeks', {}) as echarts.EChartsOption, {
      notMerge: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the node layout is internal
    const series = (chart as any).getModel().getSeriesByIndex(0);
    const data = series.getData();
    const rightmost = Math.max(
      ...Array.from({ length: data.count() }, (_, i) => {
        // Node positions are inside the series box; the label follows the
        // node (5 px away), at most 120 px wide
        const node = data.getItemLayout(i);
        return series.layoutInfo.x + node.x + node.dx + 5 + Math.min(120, data.getName(i).length * 7);
      })
    );
    chart.dispose();
    expect(rightmost).toBeLessThanOrEqual(600);
  });

  it('names the nodes of a sankey, never by their ids', () => {
    const { texts, logged } = render('sankey', siteProject);
    expect(logged).toEqual([]);
    expect(texts).toEqual(expect.arrayContaining(['Basel', 'Zurich', 'Other', 'Apollo', 'Borealis', 'Cygnus']));
    expect(texts.some((t) => /^[12]:/.test(t))).toBe(false);
  });
});
