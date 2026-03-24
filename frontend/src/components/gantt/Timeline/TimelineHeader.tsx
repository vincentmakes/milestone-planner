/**
 * TimelineHeader
 * Displays the time period headers above the timeline
 */

import { memo } from 'react';
import type { TimelineCell, TimelineHeader as TimelineHeaderType } from '../utils';
import styles from './TimelineHeader.module.css';

interface TimelineHeaderProps {
  headers: {
    primary: TimelineHeaderType[];
    secondary: TimelineHeaderType[];
  };
  cells: TimelineCell[];
  cellWidth: number;
  totalWidth: number;
  viewMode: 'week' | 'month' | 'quarter' | 'year';
  hasCustomColumns?: boolean;
}

export const TimelineHeader = memo(function TimelineHeader({
  headers,
  cells,
  cellWidth,
  totalWidth,
  viewMode,
  hasCustomColumns = false,
}: TimelineHeaderProps) {
  // Only show week numbers in week and month views (not quarter or year)
  const showWeekNumbers = viewMode === 'week' || viewMode === 'month' || viewMode === 'quarter';
  // Only show weekend/holiday highlighting in week and month views
  const showHighlighting = viewMode === 'week' || viewMode === 'month';

  return (
    <div className={styles.header}>
      <div className={styles.headerContent} style={{ width: totalWidth }}>
        {/* Primary row (months/quarters/years) */}
        <div className={styles.primaryRow}>
          {headers.primary.map((header, index) => (
            <div
              key={index}
              className={`${styles.primaryCell} ${header.isCurrentPeriod ? styles.current : ''}`}
              style={{ width: header.span * cellWidth }}
            >
              {header.label}
            </div>
          ))}
        </div>

        {/* Secondary row (days/weeks/months) */}
        <div 
          className={styles.secondaryRow}
          style={{ '--cell-width': `${cellWidth}px` } as React.CSSProperties}
        >
          {/* Background markers for highlighting - positioned absolutely like body grid */}
          {showHighlighting && (
            <div className={styles.bgLayer}>
              {cells.map((cell, index) => {
                // Determine background type - priority: today > holiday > event > weekend
                let bgClass = '';
                if (cell.isToday) {
                  bgClass = styles.todayBg;
                } else if (cell.isBankHoliday) {
                  // All holidays (public and custom) use orange - matching body
                  bgClass = styles.holidayBg;
                } else if (cell.isCompanyEvent) {
                  bgClass = styles.eventBg;
                } else if (cell.isWeekend) {
                  bgClass = styles.weekendBg;
                }
                
                if (!bgClass) return null;
                
                return (
                  <div
                    key={`bg-${index}`}
                    className={`${styles.bgCell} ${bgClass}`}
                    style={{ left: index * cellWidth, width: cellWidth }}
                  />
                );
              })}
            </div>
          )}
          
          {/* Cell labels */}
          {cells.map((cell, index) => {
            // Determine text color class
            let textClass = '';
            if (cell.isToday) {
              textClass = styles.todayText;
            } else if (cell.isBankHoliday) {
              textClass = styles.holidayText;
            } else if (cell.isCompanyEvent) {
              textClass = styles.eventText;
            }
            
            const tooltipText = cell.isBankHoliday 
              ? cell.bankHolidayName 
              : cell.isCompanyEvent 
                ? cell.companyEventName 
                : undefined;
            
            return (
              <div
                key={index}
                className={`${styles.secondaryCell} ${textClass}`}
                style={{ width: cellWidth }}
                title={tooltipText}
                data-date={cell.dateStr}
                data-date-end={cell.dateEnd || undefined}
              >
                <span className={styles.dayLabel}>{cell.label}</span>
                {/* Week number on first day of week - position varies by view */}
                {showWeekNumbers && cell.isFirstOfWeek && (
                  <span className={viewMode === 'month' ? styles.weekLabelBottom : styles.weekLabelTop}>
                    W{cell.weekNumber}
                  </span>
                )}
                {cell.isFirstOfMonth && cellWidth < 40 && (
                  <span className={styles.monthLabel}>{cell.monthLabel}</span>
                )}
              </div>
            );
          })}
        </div>
        
        {/* Spacer row to align with custom column headers in ProjectPanel */}
        {hasCustomColumns && (
          <div className={styles.customColumnSpacer} />
        )}
      </div>
    </div>
  );
});
