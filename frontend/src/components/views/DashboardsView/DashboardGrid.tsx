/**
 * DashboardGrid — the widgets on a responsive react-grid-layout (2.3.0) grid.
 *
 * Breakpoints are on the **container** width (the view beside the sidebar),
 * not the window: `lg` ≥ 1000 px with 12 columns, `md` ≥ 700 px with 8,
 * `sm` below with 4 — the columns every stored `layout` is written for
 * (`dashboard_seed.GRID_COLUMNS`). Rows are 80 px, 12 px apart.
 * `useContainerWidth` measures the container first; the grid renders once
 * it has a width. In view mode (the default) nothing drags or resizes;
 * `editing` turns on dragging by the widget header (`.widgetHeader`) and
 * resizing from the bottom-right corner (a press on a header button —
 * `.widgetAction`, Edit / Remove — never starts a drag), and
 * `onLayoutChange` reports every widget's `{lg, md, sm}` after a change (the
 * builder's job; the library also reports on mount and after a compaction).
 * A report says where it came from: `'gesture'` for the one a drag or resize
 * ends with, `'settle'` for the library's own (mount, compaction after a
 * widget came or went, new layouts handed in) — so the builder's undo history
 * gets one entry per gesture. react-grid-layout 2.3.0 reports a gesture's
 * layout synchronously right after `onDragStop` / `onResizeStop`, so those
 * mark the gesture and a microtask unmarks it (a gesture that moved nothing
 * reports nothing).
 *
 * Resizing is **row-fluid**, live: on every move of a resize the widgets in
 * the resized widget's right column take the width it gains or gives up
 * (`fluidResize`, never below two columns), computed from the layout the
 * gesture started with. react-grid-layout 2.3.0's `onResize` hands over the
 * fresh layout array of that move (`modifyLayout` copies it) with a clone of
 * the resized item and a new placeholder, and only afterwards compacts that
 * array into its state and shows the placeholder — so replacing entries of
 * the array and setting the item's and placeholder's `w` is honoured, the
 * neighbours move while the pointer does, and the report the gesture ends
 * with (the stop compacts the last move's layout) carries them: one undo
 * step. Height keeps the library's push-down.
 *
 * While a drag or resize is in progress the container carries `data-gesture`
 * (set on the DOM node, no re-render mid-gesture), and the stylesheet turns
 * off text selection inside the grid for that time only, so the pointer
 * sweeping over the widgets' titles never highlights them.
 *
 * The library's stylesheets are imported here, so they land in the
 * Dashboards chunk; `DashboardGrid.module.css` restyles the items and the
 * drop placeholder with app tokens.
 */

import { useCallback, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { getBreakpointFromWidth, Responsive, useContainerWidth } from 'react-grid-layout';
import type { Layout, LayoutItem, ResponsiveLayouts } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import type { DashboardWidget, MetricError, MetricResult, WidgetLayout } from '@/types';
import { WidgetCard } from './WidgetCard';
import {
  fluidResize,
  fromGridLayouts,
  GRID_BREAKPOINTS,
  GRID_COLS,
  GRID_MARGIN,
  GRID_ROW_HEIGHT,
  toGridLayouts,
} from './gridLayouts';
import type { GridBreakpoint, LayoutSource } from './gridLayouts';
import styles from './DashboardGrid.module.css';

export interface DashboardGridProps {
  widgets: readonly DashboardWidget[];
  data: Readonly<Record<number, MetricResult | MetricError>>;
  dataLoading?: boolean;
  /** Edit mode: widgets drag by their header and resize from a corner */
  editing?: boolean;
  /** Every widget's layout (widget id → `{lg, md, sm}`) after a change, and who made it */
  onLayoutChange?: (layouts: Record<number, WidgetLayout>, source: LayoutSource) => void;
  /** Edit mode: a widget header's Edit button */
  onEditWidget?: (id: number) => void;
  /** Edit mode: a widget header's Remove button */
  onRemoveWidget?: (id: number) => void;
}

export function DashboardGrid({
  widgets,
  data,
  dataLoading = false,
  editing = false,
  onLayoutChange,
  onEditWidget,
  onRemoveWidget,
}: DashboardGridProps) {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const layouts = useMemo(() => toGridLayouts(widgets), [widgets]);

  // The container node, shared with the library's width measurement.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const setRoot = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      // The library types the ref for React 19 (`RefObject<T | null>`).
      (containerRef as MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [containerRef]
  );
  // `data-gesture` on the container while a drag or resize is in progress.
  const markGesture = useCallback((on: boolean) => {
    if (on) rootRef.current?.setAttribute('data-gesture', '');
    else rootRef.current?.removeAttribute('data-gesture');
  }, []);
  const startDrag = useCallback(() => markGesture(true), [markGesture]);

  // Set between the end of a drag / resize and the report it makes.
  const gestureRef = useRef(false);
  const endGesture = useCallback(() => {
    markGesture(false);
    gestureRef.current = true;
    queueMicrotask(() => {
      gestureRef.current = false;
    });
  }, [markGesture]);

  // The columns of the breakpoint the library picks for this width.
  const cols = GRID_COLS[getBreakpointFromWidth(GRID_BREAKPOINTS, width) as GridBreakpoint];

  // The layout a resize started from: the rule always applies to it, so a
  // neighbour comes back when the widget does.
  const resizeStartRef = useRef<Layout | null>(null);
  const startResize = useCallback((layout: Layout) => {
    resizeStartRef.current = layout.map((entry) => ({ ...entry }));
    markGesture(true);
  }, [markGesture]);
  const resizeFluidly = useCallback(
    (layout: Layout, _old: LayoutItem | null, item: LayoutItem | null, placeholder: LayoutItem | null) => {
      const start = resizeStartRef.current;
      if (!start || !item) return;
      const next = fluidResize(start, item.i, item.w, cols);
      // This move's own array (the library compacts it after this callback)
      const live = layout as LayoutItem[];
      for (const want of next) {
        if (want.i === item.i) {
          item.w = want.w;
          if (placeholder) placeholder.w = want.w;
          continue;
        }
        const index = live.findIndex((entry) => entry.i === want.i);
        const entry = live[index];
        if (entry && (entry.x !== want.x || entry.w !== want.w)) live[index] = { ...entry, x: want.x, w: want.w };
      }
    },
    [cols]
  );
  const stopResize = useCallback(() => {
    resizeStartRef.current = null;
    endGesture();
  }, [endGesture]);

  const handleLayoutChange = useCallback(
    (_current: Layout, all: ResponsiveLayouts<GridBreakpoint>) => {
      onLayoutChange?.(fromGridLayouts(widgets, all), gestureRef.current ? 'gesture' : 'settle');
    },
    [onLayoutChange, widgets]
  );

  return (
    <div
      ref={setRoot}
      className={`${styles.container}${editing ? ` ${styles.editing}` : ''}`}
    >
      {mounted && width > 0 && (
        <Responsive
          width={width}
          layouts={layouts}
          breakpoints={GRID_BREAKPOINTS}
          cols={GRID_COLS}
          rowHeight={GRID_ROW_HEIGHT}
          margin={GRID_MARGIN}
          dragConfig={{ enabled: editing, handle: '.widgetHeader', cancel: '.widgetAction' }}
          resizeConfig={{ enabled: editing, handles: ['se'] }}
          onLayoutChange={handleLayoutChange}
          onDragStart={startDrag}
          onDragStop={endGesture}
          onResizeStart={startResize}
          onResize={resizeFluidly}
          onResizeStop={stopResize}
        >
          {widgets.map((widget) => (
            <div key={String(widget.id)} className={styles.item} data-widget-id={widget.id}>
              <WidgetCard
                widget={widget}
                result={data[widget.id]}
                loading={dataLoading}
                editing={editing}
                onEdit={onEditWidget ? () => onEditWidget(widget.id) : undefined}
                onRemove={onRemoveWidget ? () => onRemoveWidget(widget.id) : undefined}
              />
            </div>
          ))}
        </Responsive>
      )}
    </div>
  );
}
