/**
 * PhantomIndicator
 * 
 * Shows lag/lead indicator above the phantom bar during phantom sibling mode.
 * Displays the number of days offset and the dependency type (SS/FS).
 */

import { useMemo } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { calculateBarPosition, type TimelineCell } from '@/components/gantt/utils';
import { differenceInDays, addDays } from 'date-fns';
import type { ViewMode, Phase, Subphase } from '@/types';
import styles from './PhantomIndicator.module.css';

interface PhantomIndicatorProps {
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
  phantomRowTop: number;
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

// Parse date string to Date
function parseDate(dateStr: string): Date {
  const cleanDate = dateStr.split('T')[0];
  return new Date(cleanDate + 'T12:00:00');
}

export function PhantomIndicator({ cells, cellWidth, viewMode, phantomRowTop }: PhantomIndicatorProps) {
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  const projects = useAppStore((s) => s.projects);

  const indicatorData = useMemo(() => {
    if (!phantomSiblingMode) return null;

    const { phantomStart, phantomEnd, phantomColor, dependencyType, sourceId, type, projectId } = phantomSiblingMode;

    // Calculate phantom bar position for indicator placement
    const phantomPos = calculateBarPosition(phantomStart, phantomEnd, cells, cellWidth, viewMode);
    if (!phantomPos) return null;

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
      left: phantomPos.left + phantomPos.width / 2,
      top: phantomRowTop - 28,
      lagDays,
      dependencyType,
      color: phantomColor,
      isPositive: lagDays >= 0,
    };
  }, [phantomSiblingMode, cells, cellWidth, viewMode, phantomRowTop, projects]);

  if (!indicatorData) return null;

  const lagText = indicatorData.lagDays >= 0 ? `+${indicatorData.lagDays}d` : `${indicatorData.lagDays}d`;

  return (
    <div
      className={`${styles.indicator} ${indicatorData.isPositive ? styles.positive : styles.negative}`}
      style={{
        left: indicatorData.left,
        top: indicatorData.top,
        borderColor: indicatorData.color,
      }}
    >
      <span className={styles.lag}>{lagText}</span>
      <span className={styles.depType}>{indicatorData.dependencyType}</span>
    </div>
  );
}

export default PhantomIndicator;
