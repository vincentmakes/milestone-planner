/**
 * EChart — one ECharts chart (bar, line or pie) of a widget's result.
 *
 * ECharts is imported piecemeal (`echarts/core` + the three charts, five
 * components and the canvas renderer), registered once at module level, so
 * the Dashboards chunk carries only what the widgets draw. The chart is
 * initialised once per mount with the `milestone` theme (the app tokens,
 * `echartsTheme.ts`), gets its option with `notMerge` whenever the result or
 * the options change, follows its container through a `ResizeObserver` and
 * is disposed on unmount. The observed width also decides whether the chart
 * is narrow (`isNarrow`: under 90 px per category), which tilts and shortens
 * the category labels (`toOption`'s `layout.narrow`) so they never overlap. A `data-theme` change on `<html>` (watched like
 * `ThemeToggle` does) re-registers the theme from the new tokens and applies
 * it with the instance's `setTheme` (ECharts 6), then sets the re-coloured
 * option.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  AriaComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { MetricResult, WidgetOptions } from '@/types';
import { buildTheme, CHART_THEME_NAME, toEChartsTheme } from './echartsTheme';
import { categoryCount, isNarrow, toOption } from './toOption';
import type { ChartKind } from './toOption';
import styles from './EChart.module.css';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
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
  // Narrow: too little width per category for level labels. The observer
  // measures the width; a new result re-decides with the last width.
  const categories = useMemo(() => categoryCount(result), [result]);
  const categoriesRef = useRef(categories);
  const widthRef = useRef(0);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    categoriesRef.current = categories;
    setNarrow(isNarrow(widthRef.current, categories));
  }, [categories]);
  const option = useMemo(
    () => toOption(kind, result, options, theme, measureLabel, { narrow }),
    [kind, result, options, theme, measureLabel, narrow]
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
      widthRef.current = entries[0]?.contentRect.width ?? container.clientWidth;
      setNarrow(isNarrow(widthRef.current, categoriesRef.current));
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

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
