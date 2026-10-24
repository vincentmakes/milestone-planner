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
 * The library's stylesheets are imported here, so they land in the
 * Dashboards chunk; `DashboardGrid.module.css` restyles the items and the
 * drop placeholder with app tokens.
 */

import { useCallback, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { Responsive, useContainerWidth } from 'react-grid-layout';
import type { Layout, ResponsiveLayouts } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import type { DashboardWidget, MetricError, MetricResult, WidgetLayout } from '@/types';
import { WidgetCard } from './WidgetCard';
import {
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

  // Set between the end of a drag / resize and the report it makes.
  const gestureRef = useRef(false);
  const endGesture = useCallback(() => {
    gestureRef.current = true;
    queueMicrotask(() => {
      gestureRef.current = false;
    });
  }, []);

  const handleLayoutChange = useCallback(
    (_current: Layout, all: ResponsiveLayouts<GridBreakpoint>) => {
      onLayoutChange?.(fromGridLayouts(widgets, all), gestureRef.current ? 'gesture' : 'settle');
    },
    [onLayoutChange, widgets]
  );

  return (
    // The library types the ref for React 19 (`RefObject<T | null>`).
    <div
      ref={containerRef as RefObject<HTMLDivElement>}
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
          onDragStop={endGesture}
          onResizeStop={endGesture}
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
