/**
 * Timeline
 * Right panel containing the timeline header and body
 * Structure: horizontal scroll wrapper containing header + vertically scrollable body
 * 
 * When used within TimelineScrollProvider, syncs scroll with other timelines (e.g., StaffView).
 */

import { forwardRef, useRef, useEffect, useCallback, useState } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { useCtrlScrollZoom } from '@/hooks/useCtrlScrollZoom';
import { TimelineHeader } from './TimelineHeader';
import { TimelineBody } from './TimelineBody';
import { useTimelineScrollSync } from '@/contexts/TimelineScrollContext';
import type { TimelineCell, TimelineHeader as TimelineHeaderType } from '../utils';
import type { Project, ViewMode } from '@/types';
import styles from './Timeline.module.css';

interface TimelineProps {
  cells: TimelineCell[];
  headers: {
    primary: TimelineHeaderType[];
    secondary: TimelineHeaderType[];
  };
  projects: Project[];
  cellWidth: number;
  viewMode: ViewMode;
  hasCustomColumns?: boolean;
}

// Debounce delay for saving scroll position
const SCROLL_SAVE_DELAY = 200;

export const Timeline = forwardRef<HTMLDivElement, TimelineProps>(
  function Timeline({ cells, headers, projects, cellWidth, viewMode, hasCustomColumns = false }, ref) {
    const totalWidth = cells.length * cellWidth;
    const horizontalScrollRef = useRef<HTMLDivElement>(null);
    const scrollToTodayTrigger = useUIStore((s) => s.scrollToTodayTrigger);
    const scrollToDateTrigger = useUIStore((s) => s.scrollToDateTrigger);
    const clearScrollToDateTrigger = useUIStore((s) => s.clearScrollToDateTrigger);
    const zoomTrigger = useUIStore((s) => s.zoomTrigger);
    const clearZoomTrigger = useUIStore((s) => s.clearZoomTrigger);
    const timelineScrollLeft = useViewStore((s) => s.timelineScrollLeft);
    const setTimelineScrollLeft = useViewStore((s) => s.setTimelineScrollLeft);
    const showStaffOverview = useViewStore((s) => s.showStaffOverview);
    const showEquipmentOverview = useViewStore((s) => s.showEquipmentOverview);
    const hasRestoredScroll = useRef(false);
    const scrollSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previousViewModeRef = useRef<ViewMode>(viewMode);
    const previousCellWidthRef = useRef<number>(cellWidth);
    const visibleDateRef = useRef<string | null>(null);
    const lastZoomTimestampRef = useRef<number>(0);
    
    // Track current scroll position for print styles
    const [currentScrollLeft, setCurrentScrollLeft] = useState(timelineScrollLeft);

    // Enable Ctrl+Scroll zoom
    useCtrlScrollZoom({ containerRef: horizontalScrollRef, cellWidth });
    
    // Register for scroll sync when any overview panel is shown
    const showAnyOverview = showStaffOverview || showEquipmentOverview;
    const { handleScroll: handleSyncScroll, syncScrollPosition } = useTimelineScrollSync(
      'gantt-timeline', 
      horizontalScrollRef, 
      showAnyOverview
    );

    // Calculate which date is at the left edge of the viewport
    const getVisibleDate = useCallback(() => {
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer || cells.length === 0) return null;
      
      const scrollLeft = scrollContainer.scrollLeft;
      const cellIndex = Math.floor(scrollLeft / cellWidth);
      const cell = cells[Math.min(cellIndex, cells.length - 1)];
      return cell?.dateStr || null;
    }, [cells, cellWidth]);
    
    // Calculate which date is at the center of the viewport
    const getCenterDate = useCallback(() => {
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer || cells.length === 0) return null;
      
      const scrollCenter = scrollContainer.scrollLeft + (scrollContainer.clientWidth / 2);
      const cellIndex = Math.floor(scrollCenter / cellWidth);
      const cell = cells[Math.min(cellIndex, cells.length - 1)];
      return cell?.dateStr || null;
    }, [cells, cellWidth]);

    // Scroll to show a specific date at the left edge
    const scrollToDate = useCallback((dateStr: string) => {
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer || cells.length === 0) return;
      
      // Find the cell that contains or is closest to this date
      let targetIndex = cells.findIndex(cell => cell.dateStr >= dateStr);
      if (targetIndex === -1) {
        // Date is after all cells, scroll to end
        targetIndex = cells.length - 1;
      } else if (targetIndex > 0 && cells[targetIndex].dateStr !== dateStr) {
        // If exact match not found, use the previous cell
        targetIndex = targetIndex - 1;
      }
      
      const scrollTo = targetIndex * cellWidth;
      scrollContainer.scrollLeft = scrollTo;
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

    // Restore scroll position on mount (only once)
    useEffect(() => {
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer || hasRestoredScroll.current) return;
      
      if (timelineScrollLeft > 0) {
        // Use requestAnimationFrame to ensure DOM is ready
        requestAnimationFrame(() => {
          scrollContainer.scrollLeft = timelineScrollLeft;
          hasRestoredScroll.current = true;
          // Store the visible date for view mode changes
          visibleDateRef.current = getVisibleDate();
          // Sync with other timelines
          syncScrollPosition(timelineScrollLeft);
        });
      } else {
        hasRestoredScroll.current = true;
      }
    }, [timelineScrollLeft, getVisibleDate]); // syncScrollPosition is stable, no need in deps

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
    }, [zoomTrigger, clearZoomTrigger, getCenterDate, scrollToCenterDate, setTimelineScrollLeft]); // syncScrollPosition is stable

    // Handle view mode changes - preserve visible date at left edge
    useEffect(() => {
      const viewModeChanged = previousViewModeRef.current !== viewMode;
      
      if (viewModeChanged && hasRestoredScroll.current && visibleDateRef.current) {
        // Scroll to the same date that was visible before
        requestAnimationFrame(() => {
          scrollToDate(visibleDateRef.current!);
          // Update the stored scroll position
          const scrollContainer = horizontalScrollRef.current;
          if (scrollContainer) {
            setTimelineScrollLeft(scrollContainer.scrollLeft);
            // Sync with other timelines
            syncScrollPosition(scrollContainer.scrollLeft);
          }
        });
      }
      
      previousViewModeRef.current = viewMode;
      previousCellWidthRef.current = cellWidth;
    }, [viewMode, cellWidth, scrollToDate, setTimelineScrollLeft]); // syncScrollPosition is stable

    // Save scroll position on scroll (debounced)
    // Also syncs with other timelines via the scroll sync hook
    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer || !hasRestoredScroll.current) return;
      
      // Update visible date immediately
      visibleDateRef.current = getVisibleDate();
      
      // Update current scroll position for print styles (immediate)
      setCurrentScrollLeft(scrollContainer.scrollLeft);
      
      // Clear existing timeout
      if (scrollSaveTimeout.current) {
        clearTimeout(scrollSaveTimeout.current);
      }
      
      // Save after delay
      scrollSaveTimeout.current = setTimeout(() => {
        setTimelineScrollLeft(scrollContainer.scrollLeft);
      }, SCROLL_SAVE_DELAY);
      
      // Sync with other timelines (Staff Overview)
      handleSyncScroll(e);
    }, [setTimelineScrollLeft, getVisibleDate, handleSyncScroll]);

    // Find today's cell index and scroll to it when trigger changes
    useEffect(() => {
      if (scrollToTodayTrigger === 0) return; // Don't scroll on initial mount
      
      const scrollContainer = horizontalScrollRef.current;
      if (!scrollContainer) return;
      
      // Find the index of today's cell
      const todayIndex = cells.findIndex((cell) => cell.isToday);
      
      if (todayIndex !== -1) {
        // Calculate scroll position to center today in view
        const containerWidth = scrollContainer.clientWidth;
        const todayPosition = todayIndex * cellWidth;
        const scrollTo = Math.max(0, todayPosition - containerWidth / 2 + cellWidth / 2);
        
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

    // Cleanup timeout on unmount
    useEffect(() => {
      return () => {
        if (scrollSaveTimeout.current) {
          clearTimeout(scrollSaveTimeout.current);
        }
      };
    }, []);

    return (
      <div className={styles.timeline}>
        <div 
          ref={horizontalScrollRef} 
          className={styles.horizontalScroll}
          onScroll={handleScroll}
          style={{ '--print-scroll-left': `${-currentScrollLeft}px` } as React.CSSProperties}
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
