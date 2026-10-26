/**
 * SegmentsBar - the timeline side of a StaffGroupRow (1.17.0): one person's
 * bookings on one phase / subphase drawn on a single row, one read-only block
 * per booking at its effective dates (`bookingSpan`), tinted with the card's
 * colour; a booking with an open request is hatched like a pending bar. The
 * per-booking bars below it (while the group is expanded) stay the
 * interactive ones and keep the absence / closure markers.
 *
 * Rendered inside the timeline's `.row` wrapper; its own class names avoid
 * "row" and its blocks carry no `data-*-id`, so the drag/resize hooks, which
 * find bars by `[data-assignment-id]` and rows by `[class*="row"]`, never
 * pick a block up.
 */

import { memo } from 'react';
import { calculateBarPosition } from '../utils';
import type { TimelineCell } from '../utils';
import { bookingSpan } from '@/utils/bookingSegments';
import { isPendingAssignment } from '@/utils/kanbanCards';
import { formatMediumDate } from '@/utils/date';
import type { StaffAssignment, ViewMode } from '@/types';
import styles from './SegmentsBar.module.css';

interface SegmentsBarProps {
  /** One person's bookings on the card, in row order */
  rows: readonly StaffAssignment[];
  card: { start_date: string; end_date: string; color?: string };
  name: string;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

export const SegmentsBar = memo(function SegmentsBar({ rows, card, name, cells, cellWidth, viewMode }: SegmentsBarProps) {
  return (
    <>
      {rows.map((row) => {
        const span = bookingSpan(row, card);
        const position = calculateBarPosition(span.start, span.end, cells, cellWidth, viewMode);
        if (!position) return null;
        const pending = isPendingAssignment(row) || Boolean(row.approval);
        const style = {
          left: position.left,
          width: position.width,
          ...(card.color ? { ['--segment-color' as string]: card.color } : {}),
        } as React.CSSProperties;
        return (
          <div
            key={row.id}
            className={`${styles.segment} ${pending ? styles.pendingSegment : ''}`}
            style={style}
            title={`${name} · ${formatMediumDate(span.start)} – ${formatMediumDate(span.end)} · ${row.allocation}%`}
          />
        );
      })}
    </>
  );
});
