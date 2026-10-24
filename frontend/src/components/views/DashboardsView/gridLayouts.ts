/**
 * The dashboards grid's geometry and the conversions between a widget's
 * stored `layout` (`{lg, md, sm}` of `{x, y, w, h}`) and react-grid-layout's
 * per-breakpoint layouts (items keyed by the widget id as a string).
 */

import type { Layout, LayoutItem, ResponsiveLayouts } from 'react-grid-layout';
import type { DashboardWidget, WidgetLayout } from '@/types';

export type GridBreakpoint = keyof WidgetLayout;

/** Who changed the grid's layouts: a drag / resize, or the library settling the grid. */
export type LayoutSource = 'gesture' | 'settle';

export const GRID_BREAKPOINTS: Readonly<Record<GridBreakpoint, number>> = { lg: 1000, md: 700, sm: 0 };
export const GRID_COLS: Readonly<Record<GridBreakpoint, number>> = { lg: 12, md: 8, sm: 4 };
export const GRID_ROW_HEIGHT = 80;
export const GRID_MARGIN: readonly [number, number] = [12, 12];

const BREAKPOINT_NAMES = Object.keys(GRID_COLS) as GridBreakpoint[];

/** The narrowest a widget gets while its row trades width (a stored narrower one keeps its width). */
export const MIN_COLS = 2;

/** Whether two items share rows: their `[y, y + h)` ranges intersect. */
const sharesRows = (a: LayoutItem, b: LayoutItem) => a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The item's right column: among the items sharing its rows (its row band)
 * that start at or right of its right edge, those at the smallest `x` (several
 * items stacked beside a tall widget move together). Empty at the grid's edge.
 */
export function rightColumn(layout: Layout, item: LayoutItem): LayoutItem[] {
  const edge = item.x + item.w;
  const right = layout.filter((other) => other.i !== item.i && other.x >= edge && sharesRows(other, item));
  if (right.length === 0) return [];
  const colX = Math.min(...right.map((other) => other.x));
  return right.filter((other) => other.x === colX);
}

/**
 * The widest an item may be resized to (`maxW`).
 *
 * Without a right column: the columns from its `x` to the grid's edge, `cols − x`
 * (at least its own width, for a stored layout the library moves back inside).
 * With one: its width plus what the column can give while every item of it
 * keeps `MIN_COLS` — `w + min(column w) − 2`. The column's items shrink together,
 * so for a column touching the item that is `columnRightEdge − x − 2`, the
 * column's right edge being the leftmost right edge of its items. Never below `w`.
 */
export function fluidMaxW(layout: Layout, item: LayoutItem, cols: number): number {
  const column = rightColumn(layout, item);
  if (column.length === 0) return Math.max(cols - item.x, item.w);
  return item.w + Math.max(0, Math.min(...column.map((other) => other.w)) - MIN_COLS);
}

/**
 * A row-fluid resize: the item `itemId` takes the width `nextW` (it keeps its
 * `x` — the handle is the bottom-right corner) and its right column absorbs the
 * change so the row stays full.
 *
 * - Grow: each item of the right column moves right and narrows by the same
 *   amount, never below `MIN_COLS` (the narrowest item of the column decides
 *   how much the item may grow); with no right column the grid's edge limits it.
 * - Shrink: the right column moves left and widens into the freed space; with
 *   no right column the space stays empty. The item never gets narrower than
 *   `MIN_COLS` (or its own width, if stored narrower).
 *
 * Items left of the item, further right than its right column, or outside its
 * rows are untouched, and so is every height (the library pushes rows down).
 * Returns a new array in the same order; changed items are new objects.
 */
export function fluidResize(layout: Layout, itemId: string, nextW: number, cols: number): Layout {
  const item = layout.find((entry) => entry.i === itemId);
  if (!item) return [...layout];
  const column = rightColumn(layout, item);
  let delta = nextW - item.w;
  if (delta > 0) {
    const room =
      column.length === 0 ? cols - item.x - item.w : Math.min(...column.map((other) => other.w)) - MIN_COLS;
    delta = Math.max(0, Math.min(delta, room));
  } else if (delta < 0) {
    delta = Math.max(nextW, Math.min(MIN_COLS, item.w)) - item.w;
  }
  if (delta === 0) return [...layout];
  const moving = new Set(column.map((other) => other.i));
  return layout.map((entry) => {
    if (entry.i === itemId) return { ...entry, w: entry.w + delta };
    if (moving.has(entry.i)) return { ...entry, x: entry.x + delta, w: entry.w - delta };
    return entry;
  });
}

/**
 * The library's per-breakpoint layouts of the widgets (item `i` = the widget id).
 *
 * Each item carries `maxW` (`fluidMaxW`): the columns from its `x` to the
 * grid's right edge when nothing is right of it in its rows, else what its
 * right column can give while keeping two columns each — the row-fluid resize
 * (`fluidResize`, applied live by `DashboardGrid`) trades width with that
 * column. react-grid-layout 2.3.0 refuses, rather than clamps, a resize move
 * whose pixel width would cross the grid's right edge (`resizeEast` keeps the
 * current width), so a pointer sample past the edge before the last column is
 * reached left a widget stuck short of it; with `maxW` the resize corner caps
 * the pixel width first (react-resizable's `maxConstraints`) and the move is
 * never refused. `minW` = two columns (or a narrower stored width), so the
 * corner stops where the rule does.
 */
export function toGridLayouts(widgets: readonly DashboardWidget[]): ResponsiveLayouts<GridBreakpoint> {
  const layouts: Partial<Record<GridBreakpoint, Layout>> = {};
  for (const bp of BREAKPOINT_NAMES) {
    const base: Layout = widgets.map((widget) => ({ i: String(widget.id), ...widget.layout[bp] }));
    layouts[bp] = base.map((entry) => ({
      ...entry,
      minW: Math.min(MIN_COLS, entry.w),
      maxW: fluidMaxW(base, entry, GRID_COLS[bp]),
    }));
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

