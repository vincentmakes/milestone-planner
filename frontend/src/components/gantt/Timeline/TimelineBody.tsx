/**
 * TimelineBody
 * Contains the timeline grid and project bars
 */

import { forwardRef, useMemo, useRef } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { ProjectTimeline } from './ProjectTimeline';
import { TodayLine } from './TodayLine';
import { DependencyLayer } from './DependencyLayer';
import { DragIndicator } from './DragIndicator';
import { PhantomOverlay } from './PhantomOverlay';
import { calculateTodayPosition, calculateRowPositions } from '../utils';
import type { TimelineCell } from '../utils';
import type { Project, ViewMode } from '@/types';
import styles from './TimelineBody.module.css';

interface TimelineBodyProps {
  cells: TimelineCell[];
  projects: Project[];
  cellWidth: number;
  totalWidth: number;
  viewMode: ViewMode;
}

export const TimelineBody = forwardRef<HTMLDivElement, TimelineBodyProps>(
  function TimelineBody({ cells, projects, cellWidth, totalWidth, viewMode }, ref) {
    const expandedProjects = useAppStore((s) => s.expandedProjects);
    const expandedPhases = useAppStore((s) => s.expandedPhases);
    const expandedSubphases = useAppStore((s) => s.expandedSubphases);
    const dragIndicator = useUIStore((s) => s.dragIndicator);
    const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
    
    // Internal ref for phantom overlay mouse tracking
    const internalRef = useRef<HTMLDivElement>(null);
    
    // Combine refs - use callback ref pattern
    const setRefs = (element: HTMLDivElement | null) => {
      (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = element;
      if (typeof ref === 'function') {
        ref(element);
      } else if (ref) {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = element;
      }
    };

    // Calculate today line position
    const todayPosition = useMemo(
      () => calculateTodayPosition(cells, cellWidth),
      [cells, cellWidth]
    );

    // Calculate row positions for dependency arrows (includes phantom row if active)
    const phantomConfig = phantomSiblingMode ? {
      projectId: phantomSiblingMode.projectId,
      sourceId: phantomSiblingMode.sourceId,
      type: phantomSiblingMode.type,
      parentId: phantomSiblingMode.parentId,
      parentType: phantomSiblingMode.parentType,
    } : null;
    
    const rowPositions = useMemo(
      () => calculateRowPositions(projects, expandedProjects, expandedPhases, expandedSubphases, phantomConfig),
      [projects, expandedProjects, expandedPhases, expandedSubphases, phantomConfig]
    );

    // Only show weekend/holiday highlighting for week and month views
    const showHighlighting = viewMode === 'week' || viewMode === 'month';
    
    // Calculate container dimensions for phantom overlay
    const containerHeight = rowPositions.totalHeight + 100; // Add some padding

    return (
      <div ref={setRefs} className={styles.body}>
        <div 
          className={styles.content}
          style={{ 
            width: totalWidth,
            '--cell-width': `${cellWidth}px`
          } as React.CSSProperties}
        >
          {/* Grid background with CSS gradient + special cell markers */}
          <div className={styles.grid}>
            {/* Weekend markers */}
            {showHighlighting && cells.map((cell, index) => 
              cell.isWeekend ? (
                <div
                  key={`weekend-${index}`}
                  className={`${styles.gridCell} ${styles.weekend}`}
                  style={{ left: index * cellWidth, width: cellWidth }}
                />
              ) : null
            )}
            
            {/* Bank holiday markers */}
            {showHighlighting && cells.map((cell, index) => 
              cell.isBankHoliday ? (
                <div
                  key={`holiday-${index}`}
                  className={`${styles.gridCell} ${styles.holiday}`}
                  style={{ left: index * cellWidth, width: cellWidth }}
                />
              ) : null
            )}
          </div>

          {/* Today line */}
          {todayPosition !== null && <TodayLine position={todayPosition} />}

          {/* Project rows */}
          <div className={styles.rows}>
            {projects.map((project) => (
              <ProjectTimeline
                key={project.id}
                project={project}
                cells={cells}
                cellWidth={cellWidth}
                isExpanded={expandedProjects.has(project.id)}
                expandedPhases={expandedPhases}
                expandedSubphases={expandedSubphases}
              />
            ))}
          </div>

          {/* Dependency arrows overlay */}
          <DependencyLayer
            projects={projects}
            cells={cells}
            cellWidth={cellWidth}
            rowPositions={rowPositions.positions}
          />
          
          {/* Phantom sibling mode overlay */}
          {phantomSiblingMode && (
            <PhantomOverlay
              cells={cells}
              cellWidth={cellWidth}
              viewMode={viewMode}
              timelineRef={internalRef}
              containerWidth={totalWidth}
              containerHeight={containerHeight}
              phantomRowTop={rowPositions.phantomRowTop}
            />
          )}
          
          {/* Drag/Resize indicator */}
          <DragIndicator
            visible={dragIndicator.visible}
            left={dragIndicator.left}
            top={dragIndicator.top}
            type={dragIndicator.type}
            lagDays={dragIndicator.lagDays}
            date={dragIndicator.date}
            duration={dragIndicator.duration}
            edge={dragIndicator.edge}
          />
        </div>
      </div>
    );
  }
);
