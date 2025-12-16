/**
 * PhantomArrow
 * 
 * SVG arrow from source bar to phantom bar during phantom sibling mode.
 * Uses dashed line style to indicate it's a preview.
 */

import { useMemo } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { calculateBarPosition, type TimelineCell } from '@/components/gantt/utils';
import type { ViewMode } from '@/types';
import styles from './PhantomArrow.module.css';

interface PhantomArrowProps {
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
  sourceBar: { left: number; width: number; top: number; height: number } | null;
  phantomRowTop: number;
  phantomRowHeight: number;
  containerWidth: number;
  containerHeight: number;
}

export function PhantomArrow({
  cells,
  cellWidth,
  viewMode,
  sourceBar,
  phantomRowTop,
  phantomRowHeight,
  containerWidth,
  containerHeight,
}: PhantomArrowProps) {
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);

  const arrowPath = useMemo(() => {
    if (!phantomSiblingMode || !sourceBar) return null;

    const { phantomStart, phantomEnd, phantomColor, dependencyType } = phantomSiblingMode;

    // Calculate phantom bar position
    const phantomPos = calculateBarPosition(phantomStart, phantomEnd, cells, cellWidth, viewMode);
    if (!phantomPos) return null;

    // Source bar center Y
    const fromY = sourceBar.top + sourceBar.height / 2;

    // Calculate start X position based on dependency type
    let fromX: number;
    if (dependencyType === 'SS') {
      // SS: start from beginning of source bar
      fromX = sourceBar.left;
    } else {
      // FS: start from end of source bar
      fromX = sourceBar.left + sourceBar.width;
    }

    // Phantom bar start X and center Y
    const toX = phantomPos.left;
    const toY = phantomRowTop + phantomRowHeight / 2;

    // Create path with routing
    const path = createArrowPath(fromX, fromY, toX, toY, dependencyType);

    return {
      path,
      color: phantomColor,
    };
  }, [phantomSiblingMode, sourceBar, cells, cellWidth, viewMode, phantomRowTop, phantomRowHeight]);

  if (!arrowPath) return null;

  const markerId = 'phantomArrowhead';

  return (
    <svg
      className={styles.arrowSvg}
      width={containerWidth}
      height={containerHeight}
    >
      <defs>
        <marker
          id={markerId}
          markerWidth="8"
          markerHeight="6"
          refX="7"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L8,3 z" fill={arrowPath.color} />
        </marker>
      </defs>
      <path
        d={arrowPath.path}
        stroke={arrowPath.color}
        strokeWidth="2"
        fill="none"
        strokeDasharray="5,3"
        markerEnd={`url(#${markerId})`}
        opacity="0.8"
      />
    </svg>
  );
}

/**
 * Create SVG path for the arrow with proper routing
 */
function createArrowPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  depType: 'SS' | 'FS'
): string {
  const minHorizontal = 15;

  if (depType === 'SS') {
    // SS: Go left from source, down/up, then right to target
    const goLeftX = Math.min(fromX, toX) - minHorizontal;
    return `M${fromX},${fromY} H${goLeftX} V${toY} H${toX}`;
  } else {
    // FS: Go right from source, down/up, then left to target
    if (toX > fromX + minHorizontal) {
      // Target is to the right - simple path
      const midX = fromX + (toX - fromX) / 2;
      return `M${fromX},${fromY} H${midX} V${toY} H${toX}`;
    } else {
      // Target is to the left or close - route around
      const goRightX = fromX + minHorizontal;
      const goAroundY = Math.max(fromY, toY) + 20;
      return `M${fromX},${fromY} H${goRightX} V${goAroundY} H${toX - minHorizontal} V${toY} H${toX}`;
    }
  }
}

export default PhantomArrow;
