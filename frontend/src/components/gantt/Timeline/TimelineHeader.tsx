/**
 * TimelineHeader
 * Displays the time period headers above the timeline
 */

import { memo } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { TimelineCell, TimelineHeader as TimelineHeaderType } from '../utils';
import styles from './TimelineHeader.module.css';

/** `--event-color` for a cell whose first event has a colour */
function eventColorStyle(cell: TimelineCell): React.CSSProperties | undefined {
  return cell.companyEventColor
    ? ({ ['--event-color' as string]: cell.companyEventColor } as React.CSSProperties)
    : undefined;
}

/**
 * The label cell's title: the holiday name first, then every event of the
 * cell joined by " · ", with " (n events)" when there are several;
 * `undefined` when the cell has neither.
 */
function headerCellTitle(cell: TimelineCell): string | undefined {
  const names = cell.companyEvents.map((event) => event.name);
  const parts = cell.isBankHoliday && cell.bankHolidayName ? [cell.bankHolidayName, ...names] : names;
  if (parts.length === 0) return undefined;
  return names.length > 1 ? `${parts.join(' · ')} (${names.length} events)` : parts.join(' · ');
}

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
  const showWeekends = useAppStore((s) => (s.instanceSettings?.show_weekends ?? 'true') !== 'false');

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
                } else if (cell.isWeekend && showWeekends) {
                  bgClass = styles.weekendBg;
                }

                if (!bgClass) return null;

                return (
                  <div
                    key={`bg-${index}`}
                    className={`${styles.bgCell} ${bgClass}`}
                    style={{ left: index * cellWidth, width: cellWidth, ...eventColorStyle(cell) }}
                  />
                );
              })}
              {/* Week separator lines (when weekends are hidden) */}
              {!showWeekends && cells.map((cell, index) =>
                cell.isFirstOfWeek && index > 0 ? (
                  <div
                    key={`week-sep-${index}`}
                    className={styles.weekSeparator}
                    style={{ left: index * cellWidth }}
                  />
                ) : null
              )}
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
            
            return (
              <div
                key={index}
                className={`${styles.secondaryCell} ${textClass}`}
                style={{ width: cellWidth, ...eventColorStyle(cell) }}
                title={headerCellTitle(cell)}
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
