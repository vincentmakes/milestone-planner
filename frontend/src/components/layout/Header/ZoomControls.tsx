/**
 * ZoomControls - Zoom in/out buttons and current zoom level indicator
 */

import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import styles from './ZoomControls.module.css';

// Zoom limits (same as useCtrlScrollZoom)
const MIN_CELL_WIDTH = 12;
const MAX_CELL_WIDTH = 120;
const ZOOM_STEP = 4;
const DEFAULT_CELL_WIDTH = 36;

export function ZoomControls() {
  const cellWidth = useViewStore((s) => s.cellWidth);
  const setCellWidth = useViewStore((s) => s.setCellWidth);
  const triggerZoom = useUIStore((s) => s.triggerZoom);

  // Calculate zoom percentage relative to default
  const zoomPercent = Math.round((cellWidth / DEFAULT_CELL_WIDTH) * 100);

  const handleZoomIn = () => {
    const newWidth = Math.min(cellWidth + ZOOM_STEP, MAX_CELL_WIDTH);
    if (newWidth !== cellWidth) {
      // Trigger zoom with centering
      triggerZoom(1, newWidth);
      setCellWidth(newWidth);
    }
  };

  const handleZoomOut = () => {
    const newWidth = Math.max(cellWidth - ZOOM_STEP, MIN_CELL_WIDTH);
    if (newWidth !== cellWidth) {
      // Trigger zoom with centering
      triggerZoom(-1, newWidth);
      setCellWidth(newWidth);
    }
  };

  const handleResetZoom = () => {
    if (cellWidth !== DEFAULT_CELL_WIDTH) {
      const direction = cellWidth > DEFAULT_CELL_WIDTH ? -1 : 1;
      triggerZoom(direction, DEFAULT_CELL_WIDTH);
      setCellWidth(DEFAULT_CELL_WIDTH);
    }
  };

  const canZoomIn = cellWidth < MAX_CELL_WIDTH;
  const canZoomOut = cellWidth > MIN_CELL_WIDTH;

  return (
    <div className={styles.container}>
      <button
        className={styles.button}
        onClick={handleZoomOut}
        disabled={!canZoomOut}
        title="Zoom out (-)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M19 13H5v-2h14v2z" />
        </svg>
      </button>
      
      <button
        className={styles.zoomLevel}
        onClick={handleResetZoom}
        title="Click to reset zoom (100%)"
      >
        {zoomPercent}%
      </button>
      
      <button
        className={styles.button}
        onClick={handleZoomIn}
        disabled={!canZoomIn}
        title="Zoom in (+)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
        </svg>
      </button>
    </div>
  );
}
