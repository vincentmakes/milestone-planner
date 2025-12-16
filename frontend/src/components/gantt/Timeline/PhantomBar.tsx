/**
 * PhantomBar
 * 
 * Semi-transparent bar that follows the cursor during phantom sibling mode.
 * Shows where the new phase/subphase will be placed.
 */

import { useMemo } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { calculateBarPosition, type TimelineCell } from '@/components/gantt/utils';
import type { ViewMode } from '@/types';
import styles from './PhantomBar.module.css';

interface PhantomBarProps {
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
  rowTop: number;
  rowHeight: number;
  onClick: () => void;
}

export function PhantomBar({ cells, cellWidth, viewMode, rowTop, rowHeight, onClick }: PhantomBarProps) {
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);

  const barPosition = useMemo(() => {
    if (!phantomSiblingMode) return null;

    const { phantomStart, phantomEnd } = phantomSiblingMode;
    return calculateBarPosition(phantomStart, phantomEnd, cells, cellWidth, viewMode);
  }, [phantomSiblingMode, cells, cellWidth, viewMode]);

  if (!phantomSiblingMode || !barPosition) return null;

  const { phantomColor, type } = phantomSiblingMode;
  const barHeight = 24;
  const barTop = rowTop + (rowHeight - barHeight) / 2;

  return (
    <div
      className={styles.phantomBar}
      style={{
        left: barPosition.left,
        width: barPosition.width,
        top: barTop,
        height: barHeight,
        backgroundColor: `${phantomColor}80`, // 50% opacity
        borderColor: phantomColor,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <span className={styles.label}>
        New {type === 'phase' ? 'Phase' : 'Subphase'}
      </span>
    </div>
  );
}

export default PhantomBar;
