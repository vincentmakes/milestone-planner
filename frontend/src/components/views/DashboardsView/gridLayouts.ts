/**
 * The dashboards grid's geometry and the conversions between a widget's
 * stored `layout` (`{lg, md, sm}` of `{x, y, w, h}`) and react-grid-layout's
 * per-breakpoint layouts (items keyed by the widget id as a string).
 */

import type { Layout, ResponsiveLayouts } from 'react-grid-layout';
import type { DashboardWidget, WidgetLayout } from '@/types';

export type GridBreakpoint = keyof WidgetLayout;

export const GRID_BREAKPOINTS: Readonly<Record<GridBreakpoint, number>> = { lg: 1000, md: 700, sm: 0 };
export const GRID_COLS: Readonly<Record<GridBreakpoint, number>> = { lg: 12, md: 8, sm: 4 };
export const GRID_ROW_HEIGHT = 80;
export const GRID_MARGIN: readonly [number, number] = [12, 12];

const BREAKPOINT_NAMES = Object.keys(GRID_COLS) as GridBreakpoint[];

/** The library's per-breakpoint layouts of the widgets (item `i` = the widget id). */
export function toGridLayouts(widgets: readonly DashboardWidget[]): ResponsiveLayouts<GridBreakpoint> {
  const layouts: Partial<Record<GridBreakpoint, Layout>> = {};
  for (const bp of BREAKPOINT_NAMES) {
    layouts[bp] = widgets.map((widget) => ({ i: String(widget.id), ...widget.layout[bp] }));
  }
  return layouts;
}

/** The library's layouts back into each widget's `{lg, md, sm}` (a breakpoint it did not report keeps its position). */
export function fromGridLayouts(
  widgets: readonly DashboardWidget[],
  layouts: ResponsiveLayouts<GridBreakpoint>
): Record<number, WidgetLayout> {
  const out: Record<number, WidgetLayout> = {};
  for (const widget of widgets) {
    const next: WidgetLayout = { ...widget.layout };
    for (const bp of BREAKPOINT_NAMES) {
      const item = layouts[bp]?.find((entry) => entry.i === String(widget.id));
      if (item) next[bp] = { x: item.x, y: item.y, w: item.w, h: item.h };
    }
    out[widget.id] = next;
  }
  return out;
}

