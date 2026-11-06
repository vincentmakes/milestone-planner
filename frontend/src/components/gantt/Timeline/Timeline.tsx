/**
 * Timeline
 * Right panel containing the timeline header and body
 * Structure: horizontal scroll wrapper containing header + vertically scrollable body
 * 
 * When used within TimelineScrollProvider, syncs scroll with other timelines (e.g., StaffView).
 */

import { forwardRef, useRef, useEffect, useCallback } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { useCtrlScrollZoom } from '@/hooks/useCtrlScrollZoom';
import { useTimelinePosition } from '@/hooks/useTimelinePosition';
import { TimelineHeader } from './TimelineHeader';
import { TimelineBody } from './TimelineBody';
import { useTimelineScrollSync } from '@/contexts/TimelineScrollContext';
import type { TimelineCell, TimelineHeader as TimelineHeaderType } from '../utils';
import { calculateTodayCenterScrollLeft } from '../utils/timeline';
import type { Project, ViewMode } from '@/types';
import type { GanttRow } from '../utils/projectSections';
import styles from './Timeline.module.css';

interface TimelineProps {
  cells: TimelineCell[];
  headers: {
    primary: TimelineHeaderType[];
    secondary: TimelineHeaderType[];
  };
  projects: Project[];
  /** Rows (Group-by sections + projects) shared with the ProjectPanel. */
  rows?: GanttRow[];
  cellWidth: number;
  viewMode: ViewMode;
  hasCustomColumns?: boolean;
}

export const Timeline = forwardRef<HTMLDivElement, TimelineProps>(
  function Timeline({ cells, headers, projects, rows, cellWidth, viewMode, hasCustomColumns = false }, ref) {
    const totalWidth = cells.length * cellWidth;
    const horizontalScrollRef = useRef<HTMLDivElement>(null);
    const scrollToTodayTrigger = useUIStore((s) => s.scrollToTodayTrigger);
    const scrollToDateTrigger = useUIStore((s) => s.scrollToDateTrigger);
    const clearScrollToDateTrigger = useUIStore((s) => s.clearScrollToDateTrigger);
    const zoomTrigger = useUIStore((s) => s.zoomTrigger);
    const clearZoomTrigger = useUIStore((s) => s.clearZoomTrigger);
    const setTimelineScrollLeft = useViewStore((s) => s.setTimelineScrollLeft);
    const showStaffOverview = useViewStore((s) => s.showStaffOverview);
    const showEquipmentOverview = useViewStore((s) => s.showEquipmentOverview);
    const lastZoomTimestampRef = useRef<number>(0);
    

    // Enable Ctrl+Scroll zoom
    useCtrlScrollZoom({ containerRef: horizontalScrollRef, cellWidth });
    
    // Register for scroll sync when any overview panel is shown
    const showAnyOverview = showStaffOverview || showEquipmentOverview;
    const { handleScroll: handleSyncScroll, syncScrollPosition } = useTimelineScrollSync(
      'gantt-timeline', 
      horizontalScrollRef, 
      showAnyOverview
    );

    // Opening position, keeping the left-edge date across cell-set changes and
    // the debounced save. The timeline opens on today; an in-session remount
    // restores an anchor *date*, never a pixel offset, and a reload never
    // restores (see useTimelinePosition and Timeline.scroll.test.tsx).
    const { onScroll: savePositionOnScroll, positionedRef } = useTimelinePosition({
      containerRef: horizontalScrollRef,
      cells,
      cellWidth,
      viewMode,
      onPositioned: syncScrollPosition,
    });

    // Calculate which date is at the center of the viewport
    const getCenterDate = useCallback(() => {
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer || cells.length === 0) return null;
      
      const scrollCenter = scrollContainer.scrollLeft + (scrollContainer.clientWidth / 2);
      const cellIndex = Math.floor(scrollCenter / cellWidth);
      const cell = cells[Math.min(cellIndex, cells.length - 1)];
      return cell?.dateStr || null;
    }, [cells, cellWidth]);

    // Scroll to center a specific date in the viewport
    const scrollToCenterDate = useCallback((dateStr: string) => {
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer || cells.length === 0) return;
      
      // Find the cell that contains or is closest to this date
      let targetIndex = cells.findIndex(cell => cell.dateStr >= dateStr);
      if (targetIndex === -1) {
        targetIndex = cells.length - 1;
      }
      
      const cellCenterPosition = targetIndex * cellWidth + (cellWidth / 2);
      const scrollTo = cellCenterPosition - (scrollContainer.clientWidth / 2);
      scrollContainer.scrollLeft = Math.max(0, scrollTo);
    }, [cells, cellWidth]);

    // Handle zoom trigger from buttons/keyboard (center around viewport center)
    useEffect(() => {
      if (!zoomTrigger || zoomTrigger.timestamp === lastZoomTimestampRef.current) return;
      
      lastZoomTimestampRef.current = zoomTrigger.timestamp;
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer) {
        clearZoomTrigger();
        return;
      }
      
      // Get the date at the center of the viewport BEFORE zoom
      const centerDate = getCenterDate();
      
      // Clear the trigger
      clearZoomTrigger();
      
      // After cellWidth updates, re-center on the same date
      if (centerDate) {
        requestAnimationFrame(() => {
          scrollToCenterDate(centerDate);
          // Update the stored scroll position
          setTimelineScrollLeft(scrollContainer.scrollLeft);
          // Sync with other timelines
          syncScrollPosition(scrollContainer.scrollLeft);
        });
      }
    }, [zoomTrigger, clearZoomTrigger, getCenterDate, scrollToCenterDate, setTimelineScrollLeft, syncScrollPosition]);

    // Save the position on scroll (debounced, with its left-edge date) and
    // sync with the other timelines (Staff & Equipment overviews)
    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer) return;

      // Scroll offset for the print styles, set imperatively: keeping it in
      // state re-rendered the whole timeline body on every scroll event.
      scrollContainer.style.setProperty('--print-scroll-left', `${-scrollContainer.scrollLeft}px`);

      if (!positionedRef.current) return;
      savePositionOnScroll();
      handleSyncScroll(e);
    }, [positionedRef, savePositionOnScroll, handleSyncScroll]);

    // Find today's cell index and scroll to it when trigger changes
    useEffect(() => {
      if (scrollToTodayTrigger === 0) return; // Don't scroll on initial mount
      
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer) return;
      
      // Centre today's cell — or the next working day when today is a hidden
      // weekend day (see findTodayCell).
      const scrollTo = calculateTodayCenterScrollLeft(cells, cellWidth, scrollContainer.clientWidth);
      
      if (scrollTo !== null) {
        // For smooth scroll with sync, we need to sync after animation completes
        // Use scrollTo without smooth when panels are open to avoid conflicts
        if (showAnyOverview) {
          scrollContainer.scrollLeft = scrollTo;
          // Manually sync to other panels
          syncScrollPosition(scrollTo);
        } else {
          scrollContainer.scrollTo({
            left: scrollTo,
            behavior: 'smooth',
          });
        }
      }
    }, [scrollToTodayTrigger, cells, cellWidth, showAnyOverview, syncScrollPosition]);

    // Scroll to specific date when trigger changes
    useEffect(() => {
      if (!scrollToDateTrigger) return;
      
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer) return;
      
      // Find the cell index for this date
      const targetDate = scrollToDateTrigger.date;
      let targetIndex = cells.findIndex(cell => cell.dateStr >= targetDate);
      
      if (targetIndex === -1) {
        // Date is after all cells, scroll to end
        targetIndex = cells.length - 1;
      }
      
      if (targetIndex !== -1) {
        // Calculate scroll position to put target near the left third of the viewport
        const containerWidth = scrollContainer.clientWidth;
        const targetPosition = targetIndex * cellWidth;
        const scrollTo = Math.max(0, targetPosition - containerWidth / 4);
        
        // Use instant scroll when panels are open to avoid conflicts
        if (showAnyOverview) {
          scrollContainer.scrollLeft = scrollTo;
          syncScrollPosition(scrollTo);
        } else {
          scrollContainer.scrollTo({
            left: scrollTo,
            behavior: 'smooth',
          });
        }
      }
      
      clearScrollToDateTrigger();
    }, [scrollToDateTrigger, cells, cellWidth, clearScrollToDateTrigger, showAnyOverview, syncScrollPosition]);

    return (
      <div className={`${styles.timeline} compact-ui`}>
        <div 
          ref={horizontalScrollRef} 
          className={styles.horizontalScroll}
          onScroll={handleScroll}
        >
          <div className={styles.scrollContent} style={{ width: totalWidth }}>
            <TimelineHeader
              headers={headers}
              cells={cells}
              cellWidth={cellWidth}
              totalWidth={totalWidth}
              viewMode={viewMode}
              hasCustomColumns={hasCustomColumns}
            />
            <TimelineBody
              ref={ref}
              cells={cells}
              projects={projects}
              rows={rows}
              cellWidth={cellWidth}
              totalWidth={totalWidth}
              viewMode={viewMode}
            />
          </div>
        </div>
      </div>
    );
  }
);
