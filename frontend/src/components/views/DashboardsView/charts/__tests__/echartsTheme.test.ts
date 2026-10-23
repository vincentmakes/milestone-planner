/**
 * The chart theme comes from the active app theme's tokens through a style
 * getter: accents then the skill swatches as the palette (deduplicated),
 * text / border / surface / font tokens, nothing hard-coded when a token is
 * missing.
 */
import { describe, it, expect } from 'vitest';
import { buildTheme, PALETTE_TOKENS, toEChartsTheme, CHART_THEME_NAME } from '../echartsTheme';
import { SKILL_COLOR_SWATCHES } from '@/utils/colorSwatches';

const TOKENS: Record<string, string> = {
  '--accent-blue': ' #3b82f6 ',
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
  '--font-family': "'DM Sans', sans-serif",
};

describe('buildTheme', () => {
  it('reads the tokens through the getter', () => {
    const theme = buildTheme((token) => TOKENS[token]);
    expect(theme.textPrimary).toBe('#e8edf4');
    expect(theme.textSecondary).toBe('#8b99ab');
    expect(theme.textMuted).toBe('#5a6a7a');
    expect(theme.border).toBe('#2a3544');
    expect(theme.background).toBe('#151d2a');
    expect(theme.fontFamily).toBe("'DM Sans', sans-serif");
  });

  it('builds the palette from the accents, then the skill swatches not already in it', () => {
    const theme = buildTheme((token) => TOKENS[token]);
    expect(theme.palette.slice(0, PALETTE_TOKENS.length)).toEqual([
      '#3b82f6',
      '#10b981',
      '#f97316',
      '#8b5cf6',
      '#06b6d4',
      '#f59e0b',
      '#14b8a6',
      '#ef4444',
    ]);
    // Pink, lime and indigo are the swatches the accents lack
    expect(theme.palette.slice(PALETTE_TOKENS.length)).toEqual(['#ec4899', '#84cc16', '#6366f1']);
    expect(new Set(theme.palette.map((c) => c.toLowerCase())).size).toBe(theme.palette.length);
  });

  it('leaves out what the getter cannot resolve', () => {
    const theme = buildTheme(() => null);
    expect(theme.palette).toEqual(SKILL_COLOR_SWATCHES.map((s) => s.value));
    expect(theme.textPrimary).toBeUndefined();
    expect(theme.border).toBeUndefined();
    expect(buildTheme(() => '   ').fontFamily).toBeUndefined();
  });

  it('reads the document by default', () => {
    document.documentElement.style.setProperty('--text-primary', '#010203');
    try {
      expect(buildTheme().textPrimary).toBe('#010203');
    } finally {
      document.documentElement.style.removeProperty('--text-primary');
    }
  });
});

describe('toEChartsTheme', () => {
  it('maps the theme onto ECharts theme keys', () => {
    const theme = buildTheme((token) => TOKENS[token]);
    const out = toEChartsTheme(theme) as Record<string, Record<string, unknown>>;
    expect(CHART_THEME_NAME).toBe('milestone');
    expect(out.color).toEqual(theme.palette);
    expect(out.backgroundColor).toBe('transparent');
    expect(out.textStyle).toEqual({ color: '#e8edf4', fontFamily: "'DM Sans', sans-serif" });
    expect(out.tooltip).toMatchObject({ backgroundColor: '#151d2a', borderColor: '#2a3544' });
    expect(out.categoryAxis).toMatchObject({
      axisLabel: { color: '#8b99ab' },
      axisLine: { lineStyle: { color: '#2a3544' } },
      splitLine: { show: false },
    });
    expect(out.valueAxis).toMatchObject({ splitLine: { show: true, lineStyle: { color: ['#2a3544'] } } });
    expect(out.legend).toMatchObject({ textStyle: { color: '#8b99ab' } });
  });

  it('keeps ECharts’ split-line colour without a border token', () => {
    const out = toEChartsTheme(buildTheme(() => null)) as Record<string, Record<string, Record<string, unknown>>>;
    expect(out.valueAxis.splitLine.lineStyle).toEqual({ color: undefined, type: 'dashed' });
  });
});
