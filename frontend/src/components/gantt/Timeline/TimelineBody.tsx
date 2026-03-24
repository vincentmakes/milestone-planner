/**
 * TimelineBody
 * Contains the timeline grid and project bars
 */

import { forwardRef, useMemo, useRef, useCallback } from 'react';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { useUIStore } from '@/stores/uiStore';
import { ProjectTimeline } from './ProjectTimeline';
import { TodayLine } from './TodayLine';
import { DependencyLayer } from './DependencyLayer';
import { DragIndicator } from './DragIndicator';
import { PhantomOverlay } from './PhantomOverlay';
import { ResourceDropOverlay } from './ResourceDropOverlay';
import { calculateTodayPosition, calculateRowPositions } from '../utils';
import type { TimelineCell } from '../utils';
import type { Project, ViewMode, Subphase } from '@/types';
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
    const expandedProjects = useViewStore((s) => s.expandedProjects);
    const expandedPhases = useViewStore((s) => s.expandedPhases);
    const expandedSubphases = useViewStore((s) => s.expandedSubphases);
    const showAssignments = useViewStore((s) => s.showAssignments);
    const customColumnFilters = useCustomColumnStore((s) => s.customColumnFilters);
    const customColumnValues = useCustomColumnStore((s) => s.customColumnValues);
    const dragIndicator = useUIStore((s) => s.dragIndicator);
    const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
    const resourceDrag = useUIStore((s) => s.resourceDrag);
    
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
    
    // Filter functions for row position calculation
    const entityPassesFilters = useCallback((entityType: 'phase' | 'subphase', entityId: number): boolean => {
      const activeFilterColumns = Object.keys(customColumnFilters).filter(
        colId => customColumnFilters[Number(colId)]?.length > 0
      );
      
      if (activeFilterColumns.length === 0) return true;
      
      for (const colIdStr of activeFilterColumns) {
        const colId = Number(colIdStr);
        const filterValues = customColumnFilters[colId];
        const valueKey = `${colId}-${entityType}-${entityId}`;
        const cellValue = customColumnValues[valueKey] ?? null;
        
        if (cellValue === null) {
          if (!filterValues.includes('__empty__')) return false;
        } else {
          if (!filterValues.includes(cellValue)) return false;
        }
      }
      return true;
    }, [customColumnFilters, customColumnValues]);
    
    const anyDescendantMatches = useCallback((subphases: Subphase[]): boolean => {
      for (const sp of subphases) {
        if (entityPassesFilters('subphase', sp.id)) return true;
        if (sp.children && sp.children.length > 0) {
          if (anyDescendantMatches(sp.children)) return true;
        }
      }
      return false;
    }, [entityPassesFilters]);

    // Calculate row positions for dependency arrows (includes phantom row if active)
    const phantomConfig = phantomSiblingMode ? {
      projectId: phantomSiblingMode.projectId,
      sourceId: phantomSiblingMode.sourceId,
      type: phantomSiblingMode.type,
      parentId: phantomSiblingMode.parentId,
      parentType: phantomSiblingMode.parentType,
    } : null;
    
    // Check if any filters are active
    const hasActiveFilters = Object.keys(customColumnFilters).some(
      colId => customColumnFilters[Number(colId)]?.length > 0
    );
    
    const rowPositions = useMemo(
      () => calculateRowPositions(
        projects, 
        expandedProjects, 
        expandedPhases, 
        expandedSubphases, 
        phantomConfig,
        showAssignments,
        hasActiveFilters ? entityPassesFilters : undefined,
        hasActiveFilters ? anyDescendantMatches : undefined
      ),
      [projects, expandedProjects, expandedPhases, expandedSubphases, phantomConfig, showAssignments, hasActiveFilters, entityPassesFilters, anyDescendantMatches]
    );

    // Only show weekend/holiday highlighting for week and month views
    const showHighlighting = viewMode === 'week' || viewMode === 'month';
    
    // Calculate container dimensions for phantom overlay
    const containerHeight = rowPositions.totalHeight + 100; // Add some padding

    // Handle drag over for resource drop - MUST preventDefault to allow drop
    const handleDragOver = useCallback((e: React.DragEvent) => {
      // Check if this is a resource drag (has our data type)
      if (e.dataTransfer.types.includes('application/json') || resourceDrag.active) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    }, [resourceDrag.active]);

    // Handle drag enter
    const handleDragEnter = useCallback((e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('application/json') || resourceDrag.active) {
        e.preventDefault();
      }
    }, [resourceDrag.active]);

    return (
      <div ref={setRefs} className={styles.body}>
        <div 
          className={`${styles.content} ${resourceDrag.active ? styles.dropTarget : ''}`}
          style={{ 
            width: totalWidth,
            '--cell-width': `${cellWidth}px`
          } as React.CSSProperties}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
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
            
            {/* Bank holiday background markers (orange - same for custom and public) */}
            {showHighlighting && cells.map((cell, index) => 
              cell.isBankHoliday ? (
                <div
                  key={`holiday-bg-${index}`}
                  className={`${styles.gridCell} ${styles.holiday}`}
                  style={{ left: index * cellWidth, width: cellWidth }}
                />
              ) : null
            )}
            
            {/* Company event background markers (red) */}
            {showHighlighting && cells.map((cell, index) => 
              cell.isCompanyEvent ? (
                <div
                  key={`event-bg-${index}`}
                  className={`${styles.gridCell} ${styles.companyEvent}`}
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
          
          {/* Holiday/Event tooltip layer - top strip only, doesn't block bars */}
          {showHighlighting && (
            <div className={styles.tooltipLayer}>
              {cells.map((cell, index) => {
                // Priority: bank holidays first, then company events
                if (cell.isBankHoliday) {
                  return (
                    <div
                      key={`tooltip-${index}`}
                      className={`${styles.tooltipCell} ${styles.holiday}`}
                      style={{ left: index * cellWidth, width: cellWidth }}
                      data-tooltip={cell.bankHolidayName || 'Holiday'}
                    />
                  );
                }
                if (cell.isCompanyEvent) {
                  return (
                    <div
                      key={`tooltip-${index}`}
                      className={`${styles.tooltipCell} ${styles.event}`}
                      style={{ left: index * cellWidth, width: cellWidth }}
                      data-tooltip={cell.companyEventName || 'Company Event'}
                    />
                  );
                }
                return null;
              })}
            </div>
          )}

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
          
          {/* Resource drag-drop overlay */}
          {resourceDrag.active && (
            <ResourceDropOverlay
              projects={projects}
              cells={cells}
              cellWidth={cellWidth}
              totalWidth={totalWidth}
              containerRef={internalRef}
              rowPositions={rowPositions.positions}
            />
          )}
        </div>
      </div>
    );
  }
);
