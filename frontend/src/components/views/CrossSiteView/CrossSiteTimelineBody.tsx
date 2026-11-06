/**
 * CrossSiteTimelineBody
 * Timeline body for cross-site view - shows site headers and project bars
 * Uses same structure as TimelineBody from main Gantt
 */

import { forwardRef, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { calculateBarPosition, calculateTodayPosition } from '@/components/gantt/utils';
import { TodayLine } from '@/components/gantt/Timeline/TodayLine';
import type { TimelineCell } from '@/components/gantt/utils';
import type { ViewMode } from '@/types';
import type { CrossSiteRow } from './CrossSiteView';
import styles from './CrossSiteTimelineBody.module.css';

interface CrossSiteTimelineBodyProps {
  rows: CrossSiteRow[];
  cells: TimelineCell[];
  cellWidth: number;
  totalWidth: number;
  viewMode: ViewMode;
}

export const CrossSiteTimelineBody = forwardRef<HTMLDivElement, CrossSiteTimelineBodyProps>(
  function CrossSiteTimelineBody({ 
    rows, 
    cells, 
    cellWidth, 
    totalWidth,
    viewMode 
  }, ref) {
    
    const showWeekends = useAppStore((s) => (s.instanceSettings?.show_weekends ?? 'true') !== 'false');
    // Background tints are week/month only; the event strip sits in the
    // header's events row (TimelineHeader)
    const showHighlighting = viewMode === 'week' || viewMode === 'month';
    const renderWeekendMarkers = showHighlighting && showWeekends;
    const renderWeekSeparators = showHighlighting && !showWeekends;
    
    // Calculate today line position
    const todayPosition = useMemo(
      () => calculateTodayPosition(cells, cellWidth),
      [cells, cellWidth]
    );
    
    return (
      <div ref={ref} className={styles.body}>
        <div 
          className={styles.content}
          style={{ 
            width: totalWidth,
            '--cell-width': `${cellWidth}px`
          } as React.CSSProperties}
        >
          {/* Grid background */}
          <div className={styles.grid}>
            {renderWeekendMarkers && cells.map((cell, index) =>
              cell.isWeekend ? (
                <div
                  key={`weekend-${index}`}
                  className={`${styles.gridCell} ${styles.weekend}`}
                  style={{ left: index * cellWidth, width: cellWidth }}
                />
              ) : null
            )}
            {showHighlighting && cells.map((cell, index) => 
              cell.isBankHoliday ? (
                <div
                  key={`holiday-${index}`}
                  className={`${styles.gridCell} ${styles.holiday}`}
                  style={{ left: index * cellWidth, width: cellWidth }}
                />
              ) : null
            )}
            {showHighlighting && cells.map((cell, index) =>
              cell.isCompanyEvent ? (
                <div
                  key={`event-${index}`}
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
            {/* Week separator bands (when weekends are hidden) */}
            {renderWeekSeparators && cells.map((cell, index) =>
              cell.isFirstOfWeek && index > 0 ? (
                <div
                  key={`week-sep-${index}`}
                  className={styles.weekSeparator}
                  style={{ left: index * cellWidth - 1 }}
                />
              ) : null
            )}
            {cells.map((cell, index) => 
              cell.isToday ? (
                <div
                  key={`today-${index}`}
                  className={`${styles.gridCell} ${styles.today}`}
                  style={{ left: index * cellWidth, width: cellWidth }}
                />
              ) : null
            )}
          </div>
          
          {/* Today line */}
          {todayPosition !== null && (
            <TodayLine position={todayPosition} />
          )}
          
          {/* Rows */}
          <div className={styles.rows}>
            {rows.map((row) => {
              if (row.type === 'site') {
                return (
                  <div 
                    key={`site-row-${row.site.id}`}
                    className={`${styles.siteRow} ${row.isCurrentSite ? styles.currentSite : ''}`}
                  />
                );
              } else {
                return (
                  <ProjectRow
                    key={`project-row-${row.project.id}`}
                    row={row}
                    cells={cells}
                    cellWidth={cellWidth}
                    viewMode={viewMode}
                  />
                );
              }
            })}
          </div>
        </div>
      </div>
    );
  }
);

// Project row with bar
interface ProjectRowProps {
  row: Extract<CrossSiteRow, { type: 'project' }>;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function ProjectRow({ row, cells, cellWidth, viewMode }: ProjectRowProps) {
  const { project } = row;
  
  // Calculate bar position
  const barPosition = useMemo(() => {
    if (!project.start_date || !project.end_date) return null;
    return calculateBarPosition(project.start_date, project.end_date, cells, cellWidth, viewMode);
  }, [project.start_date, project.end_date, cells, cellWidth, viewMode]);
  
  return (
    <div className={styles.projectRow}>
      {barPosition && (
        <div
          className={`${styles.bar} ${project.confirmed ? styles.confirmed : styles.unconfirmed}`}
          style={{ left: barPosition.left, width: barPosition.width }}
          title={project.name}
        >
          <span className={styles.barLabel}>{project.name}</span>
        </div>
      )}
    </div>
  );
}
