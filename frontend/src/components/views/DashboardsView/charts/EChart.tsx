/**
 * EChart — one ECharts chart (bar, line, pie, gauge, heatmap, treemap or
 * sankey) of a widget's result.
 *
 * ECharts is imported piecemeal (`echarts/core` + the seven charts, six
 * components and the canvas renderer), registered once at module level, so
 * the Dashboards chunk carries only what the widgets draw. The chart is
 * initialised once per mount with the `milestone` theme (the app tokens,
 * `echartsTheme.ts`), gets its option with `notMerge` whenever the result or
 * the options change, follows its container through a `ResizeObserver` and
 * is disposed on unmount. The observed width also decides whether the chart
 * is narrow (`isNarrow`: under 90 px per category, a heatmap's per column),
 * which tilts and shortens the category labels (`toOption`'s `layout.narrow`)
 * so they never overlap, and with the observed height whether a heatmap has
 * room for a value in each cell (`heatmapLabelsFit`, `layout.labelsFit`).
 * A `data-theme` change on `<html>` (watched like `ThemeToggle` does)
 * re-registers the theme from the new tokens and applies it with the
 * instance's `setTheme` (ECharts 6), then sets the re-coloured option.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, GaugeChart, HeatmapChart, LineChart, PieChart, SankeyChart, TreemapChart } from 'echarts/charts';
import {
  AriaComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { MetricResult, WidgetOptions } from '@/types';
import { buildTheme, CHART_THEME_NAME, toEChartsTheme } from './echartsTheme';
import { categoryCount, heatmapCounts, heatmapLabelsFit, isNarrow, toOption } from './toOption';
import type { ChartKind } from './toOption';
import styles from './EChart.module.css';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GaugeChart,
  HeatmapChart,
  TreemapChart,
  SankeyChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  DatasetComponent,
  AriaComponent,
  CanvasRenderer,
]);

type ChartInstance = ReturnType<typeof echarts.init>;

export interface EChartProps {
  kind: ChartKind;
  result: MetricResult;
  options?: WidgetOptions | null;
  /** Accessible name of the chart (the widget title) */
  label: string;
  /** The measure's name, naming a single series ("Booked weeks") */
  measureLabel?: string;
}

/** The columns (categories) and rows a chart lays out, for `narrow` and `labelsFit`. */
const chartCounts = (kind: ChartKind, result: MetricResult) =>
  kind === 'heatmap'
    ? { ...heatmapCounts(result), heatmap: true }
    : { x: categoryCount(result), y: 0, heatmap: false };

/** Bumped on every `data-theme` change of `<html>`. */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return version;
}

export function EChart({ kind, result, options, label, measureLabel }: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartInstance | null>(null);
  const themeVersion = useThemeVersion();
  // The theme follows the tokens of the active app theme.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- themeVersion is the trigger: the tokens live in the DOM
  const theme = useMemo(() => buildTheme(), [themeVersion]);
  // Narrow: too little width per category (a heatmap: per column) for level
  // labels; labelsFit: room for a value in every heatmap cell. The observer
  // measures the container; a new result re-decides with the last size. Both
  // are states, so a drag-resize sets the option again only when one flips.
  const counts = useMemo(() => chartCounts(kind, result), [kind, result]);
  const countsRef = useRef(counts);
  const sizeRef = useRef({ width: 0, height: 0 });
  const [narrow, setNarrow] = useState(false);
  const [labelsFit, setLabelsFit] = useState(false);
  const decide = useRef(() => {
    const { width, height } = sizeRef.current;
    const { x, y, heatmap } = countsRef.current;
    setNarrow(isNarrow(width, x));
    setLabelsFit(heatmap && heatmapLabelsFit(width, height, x, y));
  }).current;
  useEffect(() => {
    countsRef.current = counts;
    decide();
  }, [counts, decide]);
  const option = useMemo(
    () => toOption(kind, result, options, theme, measureLabel, { narrow, labelsFit }),
    [kind, result, options, theme, measureLabel, narrow, labelsFit]
  );
  const appliedTheme = useRef(themeVersion);

  // One instance per mount; disposed on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    echarts.registerTheme(CHART_THEME_NAME, toEChartsTheme(buildTheme()));
    const chart = echarts.init(container, CHART_THEME_NAME, { renderer: 'canvas' });
    chartRef.current = chart;
    const observer = new ResizeObserver((entries) => {
      chart.resize();
      const rect = entries[0]?.contentRect;
      sizeRef.current = {
        width: rect?.width ?? container.clientWidth,
        height: rect?.height ?? container.clientHeight,
      };
      decide();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [decide]);

  // A theme switch: the new tokens become the registered theme.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || appliedTheme.current === themeVersion) return;
    appliedTheme.current = themeVersion;
    echarts.registerTheme(CHART_THEME_NAME, toEChartsTheme(theme));
    chart.setTheme(CHART_THEME_NAME);
  }, [theme, themeVersion]);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={containerRef} className={styles.chart} role="img" aria-label={label} />;
}
