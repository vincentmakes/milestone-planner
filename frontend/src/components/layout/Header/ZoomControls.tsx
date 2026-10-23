/**
 * ZoomControls - Zoom in/out buttons and current zoom level indicator
 */

import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import styles from './ZoomControls.module.css';
import { Icon, PlusIcon, MinusIcon } from '@/components/common/Icon';

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
        aria-label="Zoom out"
      >
        <Icon icon={MinusIcon} size={16} />
      </button>
      
      <button
        className={styles.zoomLevel}
        onClick={handleResetZoom}
        title="Click to reset zoom (100%)"
        aria-label="Reset zoom"
      >
        {zoomPercent}%
      </button>
      
      <button
        className={styles.button}
        onClick={handleZoomIn}
        disabled={!canZoomIn}
        title="Zoom in (+)"
        aria-label="Zoom in"
      >
        <Icon icon={PlusIcon} size={16} />
      </button>
    </div>
  );
}
