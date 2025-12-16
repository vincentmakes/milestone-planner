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
        <div className={styles.secondaryRow}>
          {cells.map((cell, index) => (
            <div
              key={index}
              className={`${styles.secondaryCell} ${cell.isToday ? styles.today : ''} ${showHighlighting && cell.isWeekend ? styles.weekend : ''} ${showHighlighting && cell.isBankHoliday ? styles.holiday : ''}`}
              style={{ width: cellWidth }}
              title={showHighlighting && cell.isBankHoliday ? cell.bankHolidayName : undefined}
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
          ))}
        </div>
        
        {/* Spacer row to align with custom column headers in ProjectPanel */}
        {hasCustomColumns && (
          <div className={styles.customColumnSpacer} />
        )}
      </div>
    </div>
  );
});
