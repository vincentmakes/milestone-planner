/**
 * EquipmentTimelineBody
 * Timeline body for equipment view - shows bookings
 * Uses same structure as TimelineBody from main Gantt
 */

import { forwardRef, useMemo } from 'react';
import { calculateBarPosition, calculateTodayPosition } from '@/components/gantt/utils';
import { TodayLine } from '@/components/gantt/Timeline/TodayLine';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import type { TimelineCell } from '@/components/gantt/utils';
import type { Equipment, EquipmentBlock, ViewMode } from '@/types';
import type { OverlapInfo } from '@/utils/equipmentOverlap';
import type { EquipmentBookingWithContext } from './EquipmentView';
import { DETAIL_ROW_HEIGHT } from './EquipmentView';
import styles from './EquipmentTimelineBody.module.css';

interface EquipmentTimelineBodyProps {
  equipment: Equipment[];
  bookingsMap: Map<number, EquipmentBookingWithContext[]>;
  blocksMap: Map<number, EquipmentBlock[]>;
  overlapMap: Map<number, OverlapInfo>;
  expandedEquipment: Set<number>;
  canManage: boolean;
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
    overlapMap,
    expandedEquipment,
    canManage,
    cells,
    cellWidth,
    totalWidth,
    viewMode
  }, ref) {
    
    const showWeekends = useAppStore((s) => (s.instanceSettings?.show_weekends ?? 'true') !== 'false');
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
                  className={`${styles.gridCell} ${styles.companyEvent}`}
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
          {todayPosition !== null && (
            <TodayLine position={todayPosition} />
          )}
          
          {/* Equipment rows */}
          <div className={styles.rows}>
            {equipment.map((equip) => {
              const equipBookings = bookingsMap.get(equip.id) || [];
              const equipBlocks = blocksMap.get(equip.id) || [];
              const overlapSegments = overlapMap.get(equip.id)?.segments || [];
              const isExpanded = expandedEquipment.has(equip.id);
              return (
                <div key={equip.id} className={styles.equipmentWrapper}>
                  <EquipmentRow
                    equipment={equip}
                    bookings={equipBookings}
                    blocks={equipBlocks}
                    overlapSegments={overlapSegments}
                    cells={cells}
                    cellWidth={cellWidth}
                    viewMode={viewMode}
                  />
                  {isExpanded && (
                    <>
                      {equipBlocks.map((block) => (
                        <BlockDetailRow
                          key={`b-${block.id}`}
                          block={block}
                          cells={cells}
                          cellWidth={cellWidth}
                          viewMode={viewMode}
                        />
                      ))}
                      {/* "Add block" placeholder row mirrors panel height */}
                      {canManage && (
                        <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />
                      )}
                      {equipBookings.map((booking) => (
                        <BookingDetailRow
                          key={`a-${booking.id}-${booking.level}`}
                          booking={booking}
                          cells={cells}
                          cellWidth={cellWidth}
                          viewMode={viewMode}
                        />
                      ))}
                      {equipBookings.length === 0 && equipBlocks.length === 0 && !canManage && (
                        <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />
                      )}
                    </>
                  )}
                </div>
              );
            })}
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
                      style={{
                        left: index * cellWidth,
                        width: cellWidth,
                        ...(cell.companyEventColor
                          ? ({ ['--event-color' as string]: cell.companyEventColor } as React.CSSProperties)
                          : {}),
                      }}
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
  overlapSegments: { start: string; end: string }[];
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function EquipmentRow({ bookings, blocks, overlapSegments, cells, cellWidth, viewMode }: EquipmentRowProps) {
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

  // Calculate positions for overlap segments (overlay on top of bars)
  const overlapBars = useMemo(() => {
    return overlapSegments
      .map((seg) => calculateBarPosition(seg.start, seg.end, cells, cellWidth, viewMode))
      .filter((pos): pos is { left: number; width: number } => pos !== null);
  }, [overlapSegments, cells, cellWidth, viewMode]);

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
      {/* Overlap conflict overlay - renders on top of bars where ≥2 reservations clash */}
      {overlapBars.map((pos, idx) => (
        <div
          key={`overlap-${idx}`}
          className={styles.overlapBar}
          style={{ left: pos.left, width: pos.width }}
          title="Booking conflict: overlapping reservations"
        />
      ))}
    </div>
  );
}

// Block detail row (shown when equipment is expanded)
interface BlockDetailRowProps {
  block: EquipmentBlock;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function BlockDetailRow({ block, cells, cellWidth, viewMode }: BlockDetailRowProps) {
  const openEquipmentBlockModal = useUIStore((s) => s.openEquipmentBlockModal);
  const pos = useMemo(
    () => calculateBarPosition(block.start_date, block.end_date, cells, cellWidth, viewMode),
    [block, cells, cellWidth, viewMode],
  );

  if (!pos) return <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />;

  return (
    <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }}>
      <div
        className={`${styles.detailBar} ${styles.blockDetailBar} ${styles[`reason-${block.reason}`] || ''}`}
        style={{ left: pos.left, width: pos.width, height: 20, top: 6 }}
        title={`${block.description || 'Blocked'} (${block.reason})`}
        onClick={(e) => {
          e.stopPropagation();
          openEquipmentBlockModal(block);
        }}
      />
    </div>
  );
}

// Booking detail row (shown when equipment is expanded)
interface BookingDetailRowProps {
  booking: EquipmentBookingWithContext;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function BookingDetailRow({ booking, cells, cellWidth, viewMode }: BookingDetailRowProps) {
  const pos = useMemo(
    () => calculateBarPosition(booking.start_date, booking.end_date, cells, cellWidth, viewMode),
    [booking, cells, cellWidth, viewMode],
  );

  if (!pos) return <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />;

  return (
    <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }}>
      <div
        className={`${styles.detailBar} ${styles.bookingDetailBar}`}
        style={{ left: pos.left, width: pos.width, height: 20, top: 6 }}
        title={`${booking.projectName}${booking.phaseName ? ` - ${booking.phaseName}` : ''}`}
      />
    </div>
  );
}
