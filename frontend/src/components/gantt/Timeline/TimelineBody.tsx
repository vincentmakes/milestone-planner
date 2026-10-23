/**
 * TimelineBody
 * Contains the timeline grid and project bars
 */

import { forwardRef, memo, useMemo, useRef, useCallback } from 'react';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { ProjectTimeline } from './ProjectTimeline';
import { TodayLine } from './TodayLine';
import { DependencyLayer } from './DependencyLayer';
import { DragIndicator } from './DragIndicator';
import { PhantomOverlay } from './PhantomOverlay';
import { ResourceDropOverlay } from './ResourceDropOverlay';
import { calculateTodayPosition, calculateRowPositions } from '../utils';
import type { TimelineCell } from '../utils';
import { flatGanttRows } from '../utils/projectSections';
import type { GanttRow } from '../utils/projectSections';
import type { Project, ViewMode, Subphase } from '@/types';
import styles from './TimelineBody.module.css';

interface TimelineBodyProps {
  cells: TimelineCell[];
  /** Every project of the list (dependency arrows, resource drop targets). */
  projects: Project[];
  /**
   * Rows to render, the same list the ProjectPanel gets (Group-by sections +
   * projects); omitted = one row per project.
   */
  rows?: GanttRow[];
  cellWidth: number;
  totalWidth: number;
  viewMode: ViewMode;
}

/**
 * The drag/resize indicator, subscribed on its own: `dragIndicator` changes on
 * every mousemove of a drag, and reading it in TimelineBody re-rendered the
 * whole body (row positions, dependency layer) per frame.
 */
function ConnectedDragIndicator() {
  const dragIndicator = useUIStore((s) => s.dragIndicator);
  return (
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
  );
}

// memo: Timeline re-renders on its own scroll/zoom bookkeeping; the body only
// needs to when its props or the store slices it reads change.
export const TimelineBody = memo(forwardRef<HTMLDivElement, TimelineBodyProps>(
  function TimelineBody({ cells, projects, rows, cellWidth, totalWidth, viewMode }, ref) {
    const expandedProjects = useViewStore((s) => s.expandedProjects);
    const expandedPhases = useViewStore((s) => s.expandedPhases);
    const expandedSubphases = useViewStore((s) => s.expandedSubphases);
    // Per-person booking groups the user collapsed (session-only)
    const collapsedStaffGroups = useViewStore((s) => s.collapsedStaffGroups);
    const showAssignments = useViewStore((s) => s.showAssignments);
    const customColumnFilters = useCustomColumnStore((s) => s.customColumnFilters);
    const customColumnValues = useCustomColumnStore((s) => s.customColumnValues);
    const resourceDrag = useUIStore((s) => s.resourceDrag);
    const showWeekends = useAppStore((s) => (s.instanceSettings?.show_weekends ?? 'true') !== 'false');
    
    // Memoised so the row positions keep their identity between renders.
    const flatRows = useMemo(() => flatGanttRows(projects), [projects]);
    const visibleRows = rows ?? flatRows;

    // Internal ref for phantom overlay mouse tracking
    const internalRef = useRef<HTMLDivElement>(null);
    
    // Combine refs - use callback ref pattern. Stable, so React does not
    // detach and re-attach it on every render.
    const setRefs = useCallback((element: HTMLDivElement | null) => {
      (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = element;
      if (typeof ref === 'function') {
        ref(element);
      } else if (ref) {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = element;
      }
    }, [ref]);

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
    // Memoised on its primitive fields: a fresh object every render made the
    // rowPositions memo below recompute on every render.
    // Selected field by field: the phantom's dates change on every mousemove
    // and must not re-render the body (PhantomOverlay follows them itself).
    const phantomActive = useUIStore((s) => s.phantomSiblingMode !== null);
    const phantomProjectId = useUIStore((s) => s.phantomSiblingMode?.projectId);
    const phantomSourceId = useUIStore((s) => s.phantomSiblingMode?.sourceId);
    const phantomType = useUIStore((s) => s.phantomSiblingMode?.type);
    const phantomParentId = useUIStore((s) => s.phantomSiblingMode?.parentId);
    const phantomParentType = useUIStore((s) => s.phantomSiblingMode?.parentType);
    const phantomConfig = useMemo(
      () =>
        phantomActive
          ? {
              projectId: phantomProjectId!,
              sourceId: phantomSourceId!,
              type: phantomType!,
              parentId: phantomParentId,
              parentType: phantomParentType,
            }
          : null,
      [phantomActive, phantomProjectId, phantomSourceId, phantomType, phantomParentId, phantomParentType]
    );
    
    // Check if any filters are active
    const hasActiveFilters = Object.keys(customColumnFilters).some(
      colId => customColumnFilters[Number(colId)]?.length > 0
    );
    
    const rowPositions = useMemo(
      () => calculateRowPositions(
        visibleRows,
        expandedProjects, 
        expandedPhases, 
        expandedSubphases, 
        phantomConfig,
        showAssignments,
        hasActiveFilters ? entityPassesFilters : undefined,
        hasActiveFilters ? anyDescendantMatches : undefined,
        collapsedStaffGroups
      ),
      [visibleRows, expandedProjects, expandedPhases, expandedSubphases, phantomConfig, showAssignments, hasActiveFilters, entityPassesFilters, anyDescendantMatches, collapsedStaffGroups]
    );

    // Only show weekend/holiday highlighting for week and month views
    const showHighlighting = viewMode === 'week' || viewMode === 'month';
    const renderWeekendMarkers = showHighlighting && showWeekends;
    const renderWeekSeparators = showHighlighting && !showWeekends;
    
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
            {/* Weekend markers (suppressed when show_weekends setting is off) */}
            {renderWeekendMarkers && cells.map((cell, index) =>
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
            
            {/* Company event background markers (per-event color, red fallback) */}
            {showHighlighting && cells.map((cell, index) =>
              cell.isCompanyEvent ? (
                <div
                  key={`event-bg-${index}`}
                  className={`${styles.gridCell} ${styles.companyEvent} ${cell.isSiteClosure ? styles.siteClosure : ''}`}
                  style={{
                    left: index * cellWidth,
                    width: cellWidth,
                    ...(cell.companyEventColor
                      ? ({ ['--event-color' as string]: cell.companyEventColor } as React.CSSProperties)
                      : {}),
                  }}
                />
              ) : null
            )}

            {/* Week separator lines (when weekends are hidden) */}
            {renderWeekSeparators && cells.map((cell, index) =>
              cell.isFirstOfWeek && index > 0 ? (
                <div
                  key={`week-sep-${index}`}
                  className={styles.weekSeparator}
                  style={{ left: index * cellWidth }}
                />
              ) : null
            )}
          </div>

          {/* Today line */}
          {todayPosition !== null && <TodayLine position={todayPosition} />}

          {/* Project rows, with a band per Group-by section header. The band
              is a direct child of .rows, in flow, so offsetTop-based maths
              (drag/resize, phantom) and DOM measurement stay correct; its
              class must not contain "row" and it carries no data-*-id. */}
          <div className={styles.rows}>
            {visibleRows.map((row) =>
              row.type === 'section' ? (
                <div
                  key={`section-${row.section.key}`}
                  className={styles.groupBand}
                  data-section-key={row.section.key}
                  aria-hidden="true"
                />
              ) : (
                <ProjectTimeline
                  key={row.project.id}
                  project={row.project}
                  cells={cells}
                  cellWidth={cellWidth}
                  isExpanded={expandedProjects.has(row.project.id)}
                  expandedPhases={expandedPhases}
                  expandedSubphases={expandedSubphases}
                />
              )
            )}
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
                      style={{
                        left: index * cellWidth,
                        width: cellWidth,
                        ...(cell.companyEventColor
                          ? ({ ['--event-color' as string]: cell.companyEventColor } as React.CSSProperties)
                          : {}),
                      }}
                      data-tooltip={cell.isSiteClosure ? `Site closed: ${cell.companyEventName || 'Company Event'}` : (cell.companyEventName || 'Company Event')}
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
          {phantomActive && (
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
          <ConnectedDragIndicator />
          
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
));
