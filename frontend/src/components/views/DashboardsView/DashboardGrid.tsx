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
 * resizing from the bottom-right corner, and `onLayoutChange` reports every
 * widget's `{lg, md, sm}` after a change (the builder's job).
 *
 * The library's stylesheets are imported here, so they land in the
 * Dashboards chunk; `DashboardGrid.module.css` restyles the items and the
 * drop placeholder with app tokens.
 */

import { useCallback, useMemo } from 'react';
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
import type { GridBreakpoint } from './gridLayouts';
import styles from './DashboardGrid.module.css';

export interface DashboardGridProps {
  widgets: readonly DashboardWidget[];
  data: Readonly<Record<number, MetricResult | MetricError>>;
  dataLoading?: boolean;
  /** Edit mode: widgets drag by their header and resize from a corner */
  editing?: boolean;
  /** Every widget's layout (widget id → `{lg, md, sm}`) after a change */
  onLayoutChange?: (layouts: Record<number, WidgetLayout>) => void;
}

export function DashboardGrid({ widgets, data, dataLoading = false, editing = false, onLayoutChange }: DashboardGridProps) {
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const layouts = useMemo(() => toGridLayouts(widgets), [widgets]);

  const handleLayoutChange = useCallback(
    (_current: Layout, all: ResponsiveLayouts<GridBreakpoint>) => {
      onLayoutChange?.(fromGridLayouts(widgets, all));
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
          dragConfig={{ enabled: editing, handle: '.widgetHeader' }}
          resizeConfig={{ enabled: editing, handles: ['se'] }}
          onLayoutChange={handleLayoutChange}
        >
          {widgets.map((widget) => (
            <div key={String(widget.id)} className={styles.item} data-widget-id={widget.id}>
              <WidgetCard widget={widget} result={data[widget.id]} loading={dataLoading} editing={editing} />
            </div>
          ))}
        </Responsive>
      )}
    </div>
  );
}
