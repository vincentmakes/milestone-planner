/**
 * useTimelinePosition — where a timeline opens and how it keeps its place.
 *
 * The rule (Timeline.scroll.test.tsx, "opens on today — regression guard"):
 * - A timeline opens on today, computed from today and the cells it is given.
 * - A remount in the same session (Gantt → Kanban → Gantt) restores
 *   `viewStore.timelineAnchorDate`, the *date* last at the left edge — never a
 *   pixel offset: the same pixel is another date on another cell set.
 * - A reload never restores: the anchor is not persisted, and the store holds
 *   no pixel offset at all.
 * - The mount never writes the anchor (nor anything else). After a reload App renders the Gantt
 *   once before the data load, with no settings (weekends shown); that mount
 *   is thrown away, and a position it stored sent the real one, on
 *   weekday-only cells, months ahead. Only a scroll, a navigation, the Today
 *   button (`anchorAt`) or a cell-set change of a positioned, visible
 *   timeline writes it. A mount unmounted before its frame does nothing.
 *
 * Shared by the Gantt Timeline and the standalone Staff / Equipment views.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { useViewStore } from '@/stores/viewStore';
import { leftEdgeDate, openingScrollLeft, scrollLeftForDate } from '@/components/gantt/utils/timeline';
import type { TimelineCell } from '@/components/gantt/utils/timeline';
import type { ViewMode } from '@/types';

/** Debounce of the scroll-position save. */
const SCROLL_SAVE_DELAY = 200;

interface UseTimelinePositionOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
  /** False when another timeline owns the position (an embedded overview). */
  enabled?: boolean;
  /** Called after the hook moved the timeline itself (to sync other panes). */
  onPositioned?: (scrollLeft: number) => void;
}

export function useTimelinePosition({
  containerRef,
  cells,
  cellWidth,
  viewMode,
  enabled = true,
  onPositioned,
}: UseTimelinePositionOptions) {
  const setTimelineAnchorDate = useViewStore((s) => s.setTimelineAnchorDate);
  /** Set once the opening position is scheduled; scrolls count from then on. */
  const positionedRef = useRef(false);
  /** The date at the left edge, kept on every scroll and cell change. */
  const leftDateRef = useRef<string | null>(null);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The kind of cells: a view-mode switch or weekends shown / hidden changes
  // what a pixel means; a navigation (same kind, another date range) does not.
  const hasWeekendCells = useMemo(() => cells.some((cell) => cell.isWeekend), [cells]);
  const cellShape = `${viewMode}:${hasWeekendCells}`;
  const previousRef = useRef({ cells, cellShape });

  const save = useCallback(
    (container: HTMLDivElement) => {
      // A detached or hidden pane is not where the user is.
      if (!container.isConnected || container.clientWidth === 0 || !leftDateRef.current) return;
      setTimelineAnchorDate(leftDateRef.current);
    },
    [setTimelineAnchorDate]
  );

  // Open on the session's anchor date, else on today — once per mount.
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container || positionedRef.current || cells.length === 0) return;
    positionedRef.current = true;
    previousRef.current = { cells, cellShape };
    let frame = requestAnimationFrame(() => {
      frame = 0;
      // Read at the frame: a Today click handled since (anchorAt) counts.
      const anchor = useViewStore.getState().timelineAnchorDate;
      container.scrollLeft = openingScrollLeft(cells, cellWidth, container.clientWidth, anchor);
      leftDateRef.current = leftEdgeDate(cells, cellWidth, container.scrollLeft);
      onPositioned?.(container.scrollLeft);
    });
    // Unmounted (or re-run) before the frame: nothing was positioned, so
    // nothing is written and the next run positions afresh.
    return () => {
      if (frame === 0) return;
      cancelAnimationFrame(frame);
      positionedRef.current = false;
    };
  }, [enabled, containerRef, cells, cellShape, cellWidth, onPositioned]);

  // The cells changed after the opening position.
  useEffect(() => {
    const previous = previousRef.current;
    if (previous.cells === cells && previous.cellShape === cellShape) return;
    previousRef.current = { cells, cellShape };
    const container = containerRef.current;
    const leftDate = leftDateRef.current;
    if (!enabled || !container || !leftDate) return; // not positioned yet

    if (previous.cellShape !== cellShape) {
      // Another kind of cells (view mode, weekends shown or hidden — e.g. the
      // settings arriving late): keep the date at the left edge.
      requestAnimationFrame(() => {
        container.scrollLeft = scrollLeftForDate(cells, cellWidth, leftDate);
        leftDateRef.current = leftEdgeDate(cells, cellWidth, container.scrollLeft);
        save(container);
        onPositioned?.(container.scrollLeft);
      });
      return;
    }

    // Same kind of cells over another range (Previous / Next period) or
    // reloaded holidays: the offset stays, so the date under it may move.
    const date = leftEdgeDate(cells, cellWidth, container.scrollLeft);
    if (date !== leftDate) {
      leftDateRef.current = date;
      save(container);
    }
  }, [enabled, containerRef, cells, cellShape, cellWidth, save, onPositioned]);

  // Pending save cleared on unmount.
  useEffect(
    () => () => {
      if (saveTimeout.current) clearTimeout(saveTimeout.current);
    },
    []
  );

  /**
   * The timeline was sent to `scrollLeft` (the Today button): anchor its
   * left-edge date now, without waiting for the (smooth) scroll to end.
   */
  const anchorAt = useCallback(
    (scrollLeft: number) => {
      const container = containerRef.current;
      if (!enabled || !container) return;
      leftDateRef.current = leftEdgeDate(cells, cellWidth, scrollLeft);
      save(container);
    },
    [enabled, containerRef, cells, cellWidth, save]
  );

  /** Call from the container's scroll handler. */
  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!enabled || !container || !positionedRef.current) return;
    leftDateRef.current = leftEdgeDate(cells, cellWidth, container.scrollLeft);
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => save(container), SCROLL_SAVE_DELAY);
  }, [enabled, containerRef, cells, cellWidth, save]);

  return { onScroll, anchorAt, positionedRef, leftDateRef };
}
