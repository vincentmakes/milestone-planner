/**
 * TimelineHeader
 * Displays the time period headers above the timeline: the period row, the
 * day / week / month labels, and the events row (`TimelineMarkers`: holiday
 * lines, company-event bands and their panel, at every zoom). The header is
 * `--timeline-header-total` high (23 + 28 + 15 px: the events row draws the
 * header's bottom border); the left panes' headers read the same token, so
 * their rows stay aligned.
 *
 * Hovering a day label with something in the strip (`cellHasHit`) opens the
 * strip's panel for that cell, through the `TimelineMarkers` handle (hover
 * only; focus and click stay on the strip's button). Those labels carry no
 * native `title` (two tooltips otherwise); the others keep it — a quarter
 * week whose only mark is a holiday names it there.
 */

import { memo, useRef } from 'react';
import { useAppStore } from '@/stores/appStore';
import { cellHasHit } from '../utils';
import type { TimelineCell, TimelineHeader as TimelineHeaderType } from '../utils';
import { TimelineMarkers } from './TimelineMarkers';
import type { TimelineMarkersHandle } from './TimelineMarkers';
import styles from './TimelineHeader.module.css';

/** `--event-color` for a cell whose first event has a colour */
function eventColorStyle(cell: TimelineCell): React.CSSProperties | undefined {
  return cell.companyEventColor
    ? ({ ['--event-color' as string]: cell.companyEventColor } as React.CSSProperties)
    : undefined;
}

/**
 * The label cell's native title. A cell with something in the strip has none
 * (hovering the label opens the strip's panel); any other cell has no event,
 * so its title is the holiday name a span cell cannot show in the strip
 * (a quarter week), `undefined` otherwise.
 */
function headerCellTitle(cell: TimelineCell, viewMode: TimelineHeaderProps['viewMode']): string | undefined {
  if (cellHasHit(cell, viewMode)) return undefined;
  return (cell.isBankHoliday && cell.bankHolidayName) || undefined;
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
  // The events row names the teams of the current site (events are loaded for it)
  const siteId = useAppStore((s) => s.currentSite?.id);
  // The strip's handle: a day label's hover opens the strip's panel
  const markers = useRef<TimelineMarkersHandle>(null);

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
                title={headerCellTitle(cell, viewMode)}
                data-date={cell.dateStr}
                data-date-end={cell.dateEnd || undefined}
                onMouseEnter={(e) => markers.current?.enter(index, e)}
                onMouseLeave={() => markers.current?.leave()}
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
        
        {/* Events row: the holiday / company-event strip and its panel, at
            every zoom, below the day labels and above the bars */}
        <div
          className={styles.eventsRow}
          style={{ '--cell-width': `${cellWidth}px` } as React.CSSProperties}
        >
          <TimelineMarkers ref={markers} cells={cells} cellWidth={cellWidth} viewMode={viewMode} siteId={siteId} />
        </div>

        {/* Spacer row to align with custom column headers in ProjectPanel */}
        {hasCustomColumns && (
          <div className={styles.customColumnSpacer} />
        )}
      </div>
    </div>
  );
});
