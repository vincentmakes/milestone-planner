/**
 * EquipmentTimelineBody
 * Timeline body for equipment view - shows bookings
 * Uses same structure as TimelineBody from main Gantt
 */

import { forwardRef, useMemo } from 'react';
import { calculateBarPosition } from '@/components/gantt/utils';
import type { TimelineCell } from '@/components/gantt/utils';
import type { Equipment, ViewMode } from '@/types';
import type { EquipmentBookingWithContext } from './EquipmentView';
import styles from './EquipmentTimelineBody.module.css';

interface EquipmentTimelineBodyProps {
  equipment: Equipment[];
  bookingsMap: Map<number, EquipmentBookingWithContext[]>;
  cells: TimelineCell[];
  cellWidth: number;
  totalWidth: number;
  viewMode: ViewMode;
}

export const EquipmentTimelineBody = forwardRef<HTMLDivElement, EquipmentTimelineBodyProps>(
  function EquipmentTimelineBody({ 
    equipment, 
    bookingsMap, 
    cells, 
    cellWidth, 
    totalWidth,
    viewMode 
  }, ref) {
    
    const showHighlighting = viewMode === 'week' || viewMode === 'month';
    
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
            {showHighlighting && cells.map((cell, index) => 
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
          
          {/* Equipment rows */}
          <div className={styles.rows}>
            {equipment.map((equip) => (
              <EquipmentRow
                key={equip.id}
                equipment={equip}
                bookings={bookingsMap.get(equip.id) || []}
                cells={cells}
                cellWidth={cellWidth}
                viewMode={viewMode}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }
);

// Individual equipment row
interface EquipmentRowProps {
  equipment: Equipment;
  bookings: EquipmentBookingWithContext[];
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function EquipmentRow({ bookings, cells, cellWidth, viewMode }: EquipmentRowProps) {
  // Calculate bar positions for bookings
  const bookingBars = useMemo(() => {
    return bookings.map((booking) => {
      const pos = calculateBarPosition(booking.start_date, booking.end_date, cells, cellWidth, viewMode);
      if (!pos) return null;
      return {
        ...booking,
        left: pos.left,
        width: pos.width,
      };
    }).filter(Boolean);
  }, [bookings, cells, cellWidth, viewMode]);
  
  return (
    <div className={styles.row}>
      {bookingBars.map((booking) => booking && (
        <div
          key={`booking-${booking.id}`}
          className={styles.bookingBar}
          style={{ left: booking.left, width: booking.width }}
          title={`${booking.projectName}${booking.phaseName ? ` - ${booking.phaseName}` : ''}`}
        >
          <span className={styles.barLabel}>{booking.projectName}</span>
        </div>
      ))}
    </div>
  );
}
