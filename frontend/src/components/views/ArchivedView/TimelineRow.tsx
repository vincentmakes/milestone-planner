/**
 * TimelineRow - Renders a single timeline row with grid and project bar
 * Uses the same optimized CSS grid pattern as the main Gantt view
 */

import { useMemo } from 'react';
import type { Project } from '@/types';
import type { TimelineCell } from '@/components/gantt/utils';
import styles from './TimelineRow.module.css';

interface TimelineRowProps {
  project: Project;
  cells: TimelineCell[];
  cellWidth: number;
  totalWidth: number;
  showHighlighting: boolean;
}

export function TimelineRow({ 
  project, 
  cells, 
  cellWidth, 
  totalWidth,
  showHighlighting 
}: TimelineRowProps) {
  
  // Calculate bar position
  const barPosition = useMemo(() => {
    if (!project.start_date || !project.end_date || cells.length === 0) {
      return null;
    }
    
    const projectStart = new Date(project.start_date);
    const projectEnd = new Date(project.end_date);
    projectStart.setHours(0, 0, 0, 0);
    projectEnd.setHours(0, 0, 0, 0);
    
    const firstCellDate = cells[0].date;
    const lastCellDate = cells[cells.length - 1].date;
    
    // Check if project is visible in current range
    if (projectEnd < firstCellDate || projectStart > lastCellDate) {
      return null;
    }
    
    // Find start index
    let startIndex = 0;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].date >= projectStart) {
        startIndex = i;
        break;
      }
      if (i === cells.length - 1) {
        startIndex = i;
      }
    }
    
    // If project starts before visible range
    if (projectStart < firstCellDate) {
      startIndex = 0;
    }
    
    // Find end index
    let endIndex = cells.length - 1;
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].date <= projectEnd) {
        endIndex = i;
        break;
      }
    }
    
    // Calculate position
    const left = startIndex * cellWidth;
    const width = Math.max((endIndex - startIndex + 1) * cellWidth, cellWidth);
    
    return { left, width };
  }, [project.start_date, project.end_date, cells, cellWidth]);
  
  return (
    <div 
      className={styles.row}
      style={{ 
        width: totalWidth,
        '--cell-width': `${cellWidth}px`
      } as React.CSSProperties}
    >
      {/* Special cell markers for weekends/holidays */}
      {showHighlighting && cells.map((cell, index) => {
        if (cell.isWeekend) {
          return (
            <div
              key={`weekend-${index}`}
              className={`${styles.specialCell} ${styles.weekend}`}
              style={{ left: index * cellWidth, width: cellWidth }}
            />
          );
        }
        return null;
      })}
      
      {showHighlighting && cells.map((cell, index) => {
        if (cell.isBankHoliday) {
          return (
            <div
              key={`holiday-${index}`}
              className={`${styles.specialCell} ${styles.bankHoliday}`}
              style={{ left: index * cellWidth, width: cellWidth }}
              data-tooltip={cell.bankHolidayName || 'Holiday'}
            />
          );
        }
        return null;
      })}
      
      {showHighlighting && cells.map((cell, index) => {
        if (cell.isCompanyEvent) {
          return (
            <div
              key={`event-${index}`}
              className={`${styles.specialCell} ${styles.companyEvent}`}
              style={{ left: index * cellWidth, width: cellWidth }}
              data-tooltip={cell.companyEventName || 'Company Event'}
            />
          );
        }
        return null;
      })}
      
      {/* Today marker */}
      {cells.map((cell, index) => {
        if (cell.isToday) {
          return (
            <div
              key={`today-${index}`}
              className={`${styles.specialCell} ${styles.today}`}
              style={{ left: index * cellWidth, width: cellWidth }}
            />
          );
        }
        return null;
      })}
      
      {/* Project bar */}
      {barPosition && (
        <div
          className={`${styles.bar} ${project.confirmed ? styles.confirmed : styles.unconfirmed}`}
          style={{ left: barPosition.left, width: barPosition.width }}
        >
          {project.name}
        </div>
      )}
    </div>
  );
}
