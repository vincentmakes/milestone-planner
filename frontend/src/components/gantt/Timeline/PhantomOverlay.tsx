/**
 * PhantomOverlay
 * 
 * Overlay component for phantom sibling mode visualization.
 * Renders the phantom row, bar, arrow, and lag indicator.
 * Handles mouse tracking for bar position updates.
 */

import { useEffect, useCallback, useState, useMemo } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { usePhantomSibling } from '@/hooks/usePhantomSibling';
import { calculateBarPosition, type TimelineCell } from '@/components/gantt/utils';
import type { ViewMode, Phase, Subphase } from '@/types';
import { format, addDays, differenceInDays } from 'date-fns';
import styles from './PhantomOverlay.module.css';

interface PhantomOverlayProps {
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
  timelineRef: React.RefObject<HTMLDivElement>;
  containerWidth: number;
  containerHeight: number;
  phantomRowTop?: number; // Calculated position for the phantom row
}

// Helper to find phase/subphase position in the timeline
function findSourceBarPosition(
  sourceId: number,
  sourceType: 'phase' | 'subphase',
  timelineEl: HTMLElement
): { left: number; width: number; top: number; height: number } | null {
  const dataAttr = sourceType === 'phase' ? 'data-phase-id' : 'data-subphase-id';
  const barRow = timelineEl.querySelector(`[${dataAttr}="${sourceId}"]`) as HTMLElement | null;
  if (!barRow) return null;

  // Look for regular bar or milestone
  const bar = barRow.querySelector('[class*="phaseBar"], [class*="bar"], [class*="milestone"]') as HTMLElement;
  if (!bar) return null;

  // Get position relative to timeline container
  const barRect = bar.getBoundingClientRect();
  const containerRect = timelineEl.getBoundingClientRect();

  return {
    left: barRect.left - containerRect.left + timelineEl.scrollLeft,
    width: barRect.width,
    top: barRow.offsetTop,
    height: barRow.clientHeight || 32,
  };
}

// Helper to find subphase by ID
function findSubphaseById(phases: Phase[], subphaseId: number): Subphase | null {
  for (const phase of phases) {
    const found = findSubphaseInChildren(phase.children || [], subphaseId);
    if (found) return found;
  }
  return null;
}

function findSubphaseInChildren(children: Subphase[], targetId: number): Subphase | null {
  for (const child of children) {
    if (child.id === targetId) return child;
    if (child.children && child.children.length > 0) {
      const found = findSubphaseInChildren(child.children, targetId);
      if (found) return found;
    }
  }
  return null;
}

// Parse date string
function parseDate(dateStr: string): Date {
  const cleanDate = dateStr.split('T')[0];
  return new Date(cleanDate + 'T12:00:00');
}

export function PhantomOverlay({
  cells,
  cellWidth,
  viewMode,
  timelineRef,
  containerWidth,
  containerHeight,
  phantomRowTop: calculatedPhantomRowTop,
}: PhantomOverlayProps) {
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  const updatePhantomPosition = useUIStore((s) => s.updatePhantomPosition);
  const projects = useAppStore((s) => s.projects);
  const { completePhantom } = usePhantomSibling();

  // Track source bar position (state for reactivity)
  const [sourceBar, setSourceBar] = useState<{ left: number; width: number; top: number; height: number } | null>(null);

  // Update source bar position when phantom mode changes
  useEffect(() => {
    if (!phantomSiblingMode || !timelineRef.current) {
      setSourceBar(null);
      return;
    }

    const { sourceId, type } = phantomSiblingMode;
    
    // Small delay to let DOM update after collapse
    const updatePosition = () => {
      if (timelineRef.current) {
        const pos = findSourceBarPosition(sourceId, type, timelineRef.current);
        setSourceBar(pos);
      }
    };
    
    // Update after a frame to ensure DOM is ready
    const rafId = requestAnimationFrame(() => {
      updatePosition();
      // And again to be safe
      requestAnimationFrame(updatePosition);
    });
    
    return () => cancelAnimationFrame(rafId);
  }, [phantomSiblingMode, timelineRef]);

  // Mouse move handler
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!phantomSiblingMode || !timelineRef.current) return;

      const { siblingDurationDays } = phantomSiblingMode;
      const timelineRect = timelineRef.current.getBoundingClientRect();
      const scrollLeft = timelineRef.current.scrollLeft;

      // Calculate position relative to timeline content
      const relativeX = e.clientX - timelineRect.left + scrollLeft;

      if (cells.length === 0) return;

      // Get timeline date range
      const firstCellDate = new Date(cells[0].date);
      firstCellDate.setHours(0, 0, 0, 0);

      const lastCell = cells[cells.length - 1];
      const lastCellDate = new Date(lastCell.date);
      lastCellDate.setHours(23, 59, 59, 999);

      const totalWidth = cells.length * cellWidth;
      const totalMs = lastCellDate.getTime() - firstCellDate.getTime();
      const msPerPixel = totalMs / totalWidth;

      // Calculate duration in pixels
      const durationMs = (siblingDurationDays - 1) * 24 * 60 * 60 * 1000;
      const halfDurationPx = durationMs / msPerPixel / 2;

      // Calculate bar left position (centered on cursor)
      const barLeftPx = relativeX - halfDurationPx;
      const clampedBarLeft = Math.max(0, Math.min(barLeftPx, totalWidth - (durationMs / msPerPixel)));

      // Calculate start date from pixel position
      const startMs = firstCellDate.getTime() + clampedBarLeft * msPerPixel;
      const startDate = new Date(startMs);
      startDate.setHours(0, 0, 0, 0);

      const endDate = addDays(startDate, siblingDurationDays - 1);

      // Update state
      updatePhantomPosition(format(startDate, 'yyyy-MM-dd'), format(endDate, 'yyyy-MM-dd'));
    },
    [phantomSiblingMode, timelineRef, cells, cellWidth, updatePhantomPosition]
  );

  // Click handler to complete phantom
  const handleClick = useCallback(
    (e: MouseEvent) => {
      if (!phantomSiblingMode) return;

      // Check if click is on phantom elements
      const target = e.target as HTMLElement;
      const isPhantomClick =
        target.closest(`.${styles.phantomRow}`) ||
        target.closest(`.${styles.phantomBar}`);

      if (isPhantomClick) {
        e.preventDefault();
        e.stopPropagation();
        completePhantom();
      }
    },
    [phantomSiblingMode, completePhantom]
  );

  // Set up event listeners
  useEffect(() => {
    if (!phantomSiblingMode || !timelineRef.current) return;

    const timeline = timelineRef.current;
    timeline.addEventListener('mousemove', handleMouseMove);
    timeline.addEventListener('click', handleClick, true);

    return () => {
      timeline.removeEventListener('mousemove', handleMouseMove);
      timeline.removeEventListener('click', handleClick, true);
    };
  }, [phantomSiblingMode, handleMouseMove, handleClick, timelineRef]);

  // Calculate bar and lag info
  const phantomData = useMemo(() => {
    if (!phantomSiblingMode) return null;

    const { phantomStart, phantomEnd, phantomColor, type, dependencyType, sourceId, projectId } =
      phantomSiblingMode;

    // Calculate bar position
    const barPosition = calculateBarPosition(phantomStart, phantomEnd, cells, cellWidth, viewMode);
    if (!barPosition) return null;

    // Find source item to calculate lag
    const project = projects.find((p) => p.id === projectId);
    if (!project) return null;

    let sourceItem: Phase | Subphase | undefined;
    if (type === 'phase') {
      sourceItem = (project.phases || []).find((p) => p.id === sourceId);
    } else {
      sourceItem = findSubphaseById(project.phases || [], sourceId) || undefined;
    }

    if (!sourceItem) return null;

    // Calculate lag
    const newStart = parseDate(phantomStart);
    const sourceStart = parseDate(sourceItem.start_date);
    const sourceEnd = parseDate(sourceItem.end_date);

    let lagDays: number;
    if (dependencyType === 'SS') {
      lagDays = differenceInDays(newStart, sourceStart);
    } else {
      const expectedStart = addDays(sourceEnd, 1);
      lagDays = differenceInDays(newStart, expectedStart);
    }

    return {
      barPosition,
      phantomColor,
      type,
      dependencyType,
      lagDays,
      sourceBar,
    };
  }, [phantomSiblingMode, cells, cellWidth, viewMode, projects, sourceBar]);

  if (!phantomSiblingMode || !phantomData) return null;
  
  // Don't render until we have source bar position
  if (!phantomData.sourceBar) return null;

  const { barPosition, phantomColor, type, dependencyType, lagDays, sourceBar: sourceBarPos } = phantomData;
  const lagText = lagDays >= 0 ? `+${lagDays}d` : `${lagDays}d`;

  // Use calculated phantom row position if available, otherwise fall back to source position
  const phantomRowTop = calculatedPhantomRowTop ?? (sourceBarPos.top + sourceBarPos.height);
  const phantomBarHeight = 24;
  const phantomBarTop = phantomRowTop + (32 - phantomBarHeight) / 2;

  return (
    <div className={styles.overlay}>
      {/* Phantom row background */}
      <div
        className={styles.phantomRow}
        style={{
          top: phantomRowTop,
          width: containerWidth,
        }}
        onClick={(e) => {
          e.stopPropagation();
          completePhantom();
        }}
      />

      {/* Phantom bar */}
      <div
        className={styles.phantomBar}
        style={{
          left: barPosition.left,
          top: phantomBarTop,
          width: barPosition.width,
          height: phantomBarHeight,
          backgroundColor: `${phantomColor}80`,
          borderColor: phantomColor,
        }}
        onClick={(e) => {
          e.stopPropagation();
          completePhantom();
        }}
      >
        <span className={styles.barLabel}>
          New {type === 'phase' ? 'Phase' : 'Subphase'}
        </span>
      </div>

      {/* Lag indicator */}
      <div
        className={`${styles.indicator} ${lagDays >= 0 ? styles.positive : styles.negative}`}
        style={{
          left: barPosition.left + barPosition.width / 2,
          top: phantomRowTop - 28,
          borderColor: phantomColor,
        }}
      >
        <span className={styles.lag}>{lagText}</span>
        <span className={styles.depType}>{dependencyType}</span>
      </div>

      {/* Phantom arrow */}
      <svg
        className={styles.arrowSvg}
        width={containerWidth}
        height={containerHeight}
      >
        <defs>
          <marker
            id="phantomArrowhead"
            markerWidth="8"
            markerHeight="6"
            refX="7"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L0,6 L8,3 z" fill={phantomColor} />
          </marker>
        </defs>
        <path
          d={createArrowPath(
            sourceBarPos,
            { left: barPosition.left, top: phantomBarTop + phantomBarHeight / 2 },
            dependencyType
          )}
            stroke={phantomColor}
            strokeWidth="2"
            fill="none"
            strokeDasharray="5,3"
            markerEnd="url(#phantomArrowhead)"
            opacity="0.8"
          />
        </svg>
    </div>
  );
}

/**
 * Create SVG path for the arrow
 */
function createArrowPath(
  sourceBar: { left: number; width: number; top: number; height: number },
  target: { left: number; top: number },
  depType: 'SS' | 'FS'
): string {
  const minHorizontal = 15;
  const sourceY = sourceBar.top + sourceBar.height / 2;

  let fromX: number;
  if (depType === 'SS') {
    fromX = sourceBar.left;
  } else {
    fromX = sourceBar.left + sourceBar.width;
  }

  const toX = target.left;
  const toY = target.top;

  if (depType === 'SS') {
    const goLeftX = Math.min(fromX, toX) - minHorizontal;
    return `M${fromX},${sourceY} H${goLeftX} V${toY} H${toX}`;
  } else {
    if (toX > fromX + minHorizontal) {
      const midX = fromX + (toX - fromX) / 2;
      return `M${fromX},${sourceY} H${midX} V${toY} H${toX}`;
    } else {
      const goRightX = fromX + minHorizontal;
      const goAroundY = Math.max(sourceY, toY) + 20;
      return `M${fromX},${sourceY} H${goRightX} V${goAroundY} H${toX - minHorizontal} V${toY} H${toX}`;
    }
  }
}

export default PhantomOverlay;
