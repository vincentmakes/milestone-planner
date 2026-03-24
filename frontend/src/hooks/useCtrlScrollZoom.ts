/**
 * useCtrlScrollZoom Hook
 * 
 * Enables Ctrl+Scroll to zoom in/out on the timeline by adjusting cellWidth.
 * Maintains scroll position around the cursor so the same date stays under the mouse.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useViewStore } from '@/stores/viewStore';

// Zoom limits
const MIN_CELL_WIDTH = 12;
const MAX_CELL_WIDTH = 120;
const ZOOM_STEP = 4;

interface UseCtrlScrollZoomOptions {
  /** Ref to the scrollable timeline container */
  containerRef: React.RefObject<HTMLElement>;
  /** Current cell width */
  cellWidth: number;
  /** Whether zoom is enabled (default: true) */
  enabled?: boolean;
}

export function useCtrlScrollZoom({ containerRef, cellWidth, enabled = true }: UseCtrlScrollZoomOptions) {
  const setCellWidth = useViewStore((s) => s.setCellWidth);
  const isZoomingRef = useRef(false);

  const handleWheel = useCallback((e: WheelEvent) => {
    // Only zoom if Ctrl is held and zoom is enabled
    if (!e.ctrlKey || !enabled) return;
    
    // Prevent default browser zoom
    e.preventDefault();
    
    const container = containerRef.current;
    if (!container) return;
    
    // Avoid rapid-fire zoom events
    if (isZoomingRef.current) return;
    isZoomingRef.current = true;
    
    // Determine zoom direction (scroll up = zoom in, scroll down = zoom out)
    const zoomIn = e.deltaY < 0;
    const newCellWidth = zoomIn
      ? Math.min(cellWidth + ZOOM_STEP, MAX_CELL_WIDTH)
      : Math.max(cellWidth - ZOOM_STEP, MIN_CELL_WIDTH);
    
    // If at limits, don't do anything
    if (newCellWidth === cellWidth) {
      isZoomingRef.current = false;
      return;
    }
    
    // Calculate the date position under the cursor to maintain scroll position
    const containerRect = container.getBoundingClientRect();
    const mouseXInContainer = e.clientX - containerRect.left + container.scrollLeft;
    
    // Current cell index under cursor
    const currentCellIndex = mouseXInContainer / cellWidth;
    
    // Apply new cell width
    setCellWidth(newCellWidth);
    
    // Calculate new scroll position to keep the same date under cursor
    // Use requestAnimationFrame to apply after DOM updates
    requestAnimationFrame(() => {
      const newScrollLeft = currentCellIndex * newCellWidth - (e.clientX - containerRect.left);
      container.scrollLeft = Math.max(0, newScrollLeft);
      isZoomingRef.current = false;
    });
  }, [cellWidth, containerRef, setCellWidth, enabled]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    // Add listener with passive: false to allow preventDefault
    container.addEventListener('wheel', handleWheel, { passive: false });
    
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [handleWheel, containerRef, enabled]);

  return {
    minCellWidth: MIN_CELL_WIDTH,
    maxCellWidth: MAX_CELL_WIDTH,
    zoomStep: ZOOM_STEP,
  };
}
