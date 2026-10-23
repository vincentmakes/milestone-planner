/**
 * The dashboards' chart theme, read from the active app theme's tokens.
 *
 * `buildTheme(read)` resolves the text, border, surface and font tokens and a
 * palette — the app's accent tokens, then the skill swatches — through a
 * style getter (the computed `<html>` style by default), so it is pure given
 * the getter and re-run whenever `data-theme` changes. `toEChartsTheme`
 * turns it into the theme object registered with ECharts as `milestone`.
 * A token the getter cannot resolve is left out (ECharts keeps its default);
 * no colour is hard-coded here.
 */

import { getCSSVariable } from '@/utils/themeColors';
import { SKILL_COLOR_SWATCHES } from '@/utils/colorSwatches';

/** The name the theme is registered under. */
export const CHART_THEME_NAME = 'milestone';

/** Accent tokens, in palette order. */
export const PALETTE_TOKENS = [
  '--accent-blue',
  '--accent-green',
  '--accent-orange',
  '--accent-purple',
  '--accent-cyan',
  '--accent-yellow',
  '--accent-teal',
  '--accent-red',
] as const;

export type StyleGetter = (token: string) => string | null | undefined;

export interface ChartTheme {
  palette: string[];
  textPrimary?: string;
  textSecondary?: string;
  textMuted?: string;
  border?: string;
  background?: string;
  fontFamily?: string;
}

const clean = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** Resolve the chart theme from the tokens of the active app theme. */
export function buildTheme(read: StyleGetter = getCSSVariable): ChartTheme {
  const palette: string[] = [];
  const seen = new Set<string>();
  const add = (color: string | undefined) => {
    if (!color || seen.has(color.toLowerCase())) return;
    seen.add(color.toLowerCase());
    palette.push(color);
  };
  for (const token of PALETTE_TOKENS) add(clean(read(token)));
  for (const swatch of SKILL_COLOR_SWATCHES) add(swatch.value);
  return {
    palette,
    textPrimary: clean(read('--text-primary')),
    textSecondary: clean(read('--text-secondary')),
    textMuted: clean(read('--text-muted')),
    border: clean(read('--border-color')),
    background: clean(read('--bg-card')),
    fontFamily: clean(read('--font-family')),
  };
}

const axisTheme = (theme: ChartTheme, splitLines: boolean) => ({
  axisLine: { show: true, lineStyle: { color: theme.border } },
  axisTick: { show: false, lineStyle: { color: theme.border } },
  axisLabel: { color: theme.textSecondary, fontFamily: theme.fontFamily },
  nameTextStyle: { color: theme.textMuted },
  splitLine: { show: splitLines, lineStyle: { color: theme.border ? [theme.border] : undefined, type: 'dashed' } },
  splitArea: { show: false },
});

/** The ECharts theme object for {@link ChartTheme}. */
export function toEChartsTheme(theme: ChartTheme): Record<string, unknown> {
  return {
    color: theme.palette,
    backgroundColor: 'transparent',
    textStyle: { color: theme.textPrimary, fontFamily: theme.fontFamily },
    title: { textStyle: { color: theme.textPrimary }, subtextStyle: { color: theme.textMuted } },
    legend: { textStyle: { color: theme.textSecondary }, pageTextStyle: { color: theme.textSecondary } },
    tooltip: {
      backgroundColor: theme.background,
      borderColor: theme.border,
      textStyle: { color: theme.textPrimary, fontFamily: theme.fontFamily },
    },
    categoryAxis: axisTheme(theme, false),
    valueAxis: axisTheme(theme, true),
    line: { symbol: 'circle', symbolSize: 6, smooth: false },
    pie: { itemStyle: { borderColor: theme.background, borderWidth: 1 } },
  };
}
