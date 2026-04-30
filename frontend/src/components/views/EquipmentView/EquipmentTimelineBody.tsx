/**
 * EquipmentTimelineBody
 * Timeline body for equipment view - shows bookings
 * Uses same structure as TimelineBody from main Gantt
 */

import { forwardRef, useMemo } from 'react';
import { calculateBarPosition, calculateTodayPosition } from '@/components/gantt/utils';
import { TodayLine } from '@/components/gantt/Timeline/TodayLine';
import { useUIStore } from '@/stores/uiStore';
import type { TimelineCell } from '@/components/gantt/utils';
import type { Equipment, EquipmentBlock, ViewMode } from '@/types';
import type { EquipmentBookingWithContext } from './EquipmentView';
import styles from './EquipmentTimelineBody.module.css';

interface EquipmentTimelineBodyProps {
  equipment: Equipment[];
  bookingsMap: Map<number, EquipmentBookingWithContext[]>;
  blocksMap: Map<number, EquipmentBlock[]>;
  cells: TimelineCell[];
  cellWidth: number;
  totalWidth: number;
  viewMode: ViewMode;
}

export const EquipmentTimelineBody = forwardRef<HTMLDivElement, EquipmentTimelineBodyProps>(
  function EquipmentTimelineBody({
    equipment,
    bookingsMap,
    blocksMap,
    cells,
    cellWidth,
    totalWidth,
    viewMode
  }, ref) {
    
    const showHighlighting = viewMode === 'week' || viewMode === 'month';
    
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
            {showHighlighting && cells.map((cell, index) => 
              cell.isCompanyEvent ? (
                <div
                  key={`event-${index}`}
                  className={`${styles.gridCell} ${styles.companyEvent}`}
                  style={{ left: index * cellWidth, width: cellWidth }}
                />
              ) : null
            )}
          </div>
          
          {/* Today line */}
          {todayPosition !== null && (
            <TodayLine position={todayPosition} />
          )}
          
          {/* Equipment rows */}
          <div className={styles.rows}>
            {equipment.map((equip) => (
              <EquipmentRow
                key={equip.id}
                equipment={equip}
                bookings={bookingsMap.get(equip.id) || []}
                blocks={blocksMap.get(equip.id) || []}
                cells={cells}
                cellWidth={cellWidth}
                viewMode={viewMode}
              />
            ))}
          </div>
          
          {/* Holiday and event tooltip layer - top strip only */}
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
        </div>
      </div>
    );
  }
);

// Individual equipment row
interface EquipmentRowProps {
  equipment: Equipment;
  bookings: EquipmentBookingWithContext[];
  blocks: EquipmentBlock[];
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function EquipmentRow({ bookings, blocks, cells, cellWidth, viewMode }: EquipmentRowProps) {
  const openEquipmentBlockModal = useUIStore((s) => s.openEquipmentBlockModal);

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

  // Calculate bar positions for blocks (maintenance / defect)
  const blockBars = useMemo(() => {
    return blocks.map((block) => {
      const pos = calculateBarPosition(block.start_date, block.end_date, cells, cellWidth, viewMode);
      if (!pos) return null;
      return { block, left: pos.left, width: pos.width };
    }).filter((x): x is { block: EquipmentBlock; left: number; width: number } => x !== null);
  }, [blocks, cells, cellWidth, viewMode]);

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
      {blockBars.map(({ block, left, width }) => (
        <div
          key={`block-${block.id}`}
          className={`${styles.blockBar} ${styles[`reason-${block.reason}`] || ''}`}
          style={{ left, width }}
          title={`${block.description || 'Blocked'} (${block.reason})`}
          onClick={(e) => {
            e.stopPropagation();
            openEquipmentBlockModal(block);
          }}
        >
          <span className={styles.barLabel}>
            {block.description || 'Blocked'}
          </span>
        </div>
      ))}
    </div>
  );
}
