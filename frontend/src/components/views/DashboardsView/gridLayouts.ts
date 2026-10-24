/**
 * The dashboards grid's geometry and the conversions between a widget's
 * stored `layout` (`{lg, md, sm}` of `{x, y, w, h}`) and react-grid-layout's
 * per-breakpoint layouts (items keyed by the widget id as a string).
 */

import type { Layout, ResponsiveLayouts } from 'react-grid-layout';
import type { DashboardWidget, WidgetLayout } from '@/types';

export type GridBreakpoint = keyof WidgetLayout;

/** Who changed the grid's layouts: a drag / resize, or the library settling the grid. */
export type LayoutSource = 'gesture' | 'settle';

export const GRID_BREAKPOINTS: Readonly<Record<GridBreakpoint, number>> = { lg: 1000, md: 700, sm: 0 };
export const GRID_COLS: Readonly<Record<GridBreakpoint, number>> = { lg: 12, md: 8, sm: 4 };
export const GRID_ROW_HEIGHT = 80;
export const GRID_MARGIN: readonly [number, number] = [12, 12];

const BREAKPOINT_NAMES = Object.keys(GRID_COLS) as GridBreakpoint[];

/**
 * The library's per-breakpoint layouts of the widgets (item `i` = the widget id).
 *
 * Each item carries `maxW` = the columns from its `x` to the right edge (at
 * least its own width, for a stored layout the library moves back inside).
 * react-grid-layout 2.3.0 refuses, rather than clamps, a resize move whose
 * pixel width would cross the grid's right edge (`resizeEast` keeps the
 * current width), so a pointer sample past the edge before the last column
 * is reached left a widget stuck short of it: growing a widget back to the
 * right edge failed while shrinking always worked. With `maxW` the resize
 * corner caps the pixel width at the edge first (react-resizable's
 * `maxConstraints`), the move is never refused, and the widget takes every
 * column up to the edge.
 */
export function toGridLayouts(widgets: readonly DashboardWidget[]): ResponsiveLayouts<GridBreakpoint> {
  const layouts: Partial<Record<GridBreakpoint, Layout>> = {};
  for (const bp of BREAKPOINT_NAMES) {
    layouts[bp] = widgets.map((widget) => {
      const pos = widget.layout[bp];
      return { i: String(widget.id), ...pos, maxW: Math.max(GRID_COLS[bp] - pos.x, pos.w) };
    });
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

