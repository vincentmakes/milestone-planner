/**
 * The staff block of a phase / subphase in the Gantt tree (1.17.0): one row
 * per booking, except that a person with two or more bookings on the card
 * gets a collapsible overview row (the panel's StaffGroupRow, the timeline's
 * SegmentsBar) followed, while expanded, by their bookings.
 *
 * The panel, the timeline and `calculateRowPositions` all lay the block out
 * from `cardStaffItems` / `staffRowCount`, so the two panes and the row
 * geometry can never disagree. People come in the order of their first row
 * (`groupCardBookings`), each person's rows in row order.
 */

import { groupCardBookings } from '@/utils/bookingSegments';
import type { StaffAssignment } from '@/types';

export type StaffGroupLevel = 'phase' | 'subphase';

/** One entry of a card's staff block. */
export type CardStaffItem =
  | { kind: 'single'; assignment: StaffAssignment }
  | {
      kind: 'group';
      /** `viewStore.collapsedStaffGroups` key */
      key: string;
      staffId: number;
      rows: StaffAssignment[];
      collapsed: boolean;
    };

/** The `collapsedStaffGroups` key of one person's bookings on one card. */
export function staffGroupKey(level: StaffGroupLevel, cardId: number, staffId: number): string {
  return `${level}:${cardId}:${staffId}`;
}

/** The card's staff block: singles and per-person groups, in row order. */
export function cardStaffItems(
  assignments: readonly StaffAssignment[] | undefined,
  level: StaffGroupLevel,
  cardId: number,
  collapsed: ReadonlySet<string>
): CardStaffItem[] {
  const items: CardStaffItem[] = [];
  for (const [staffId, rows] of groupCardBookings(assignments ?? [])) {
    if (rows.length === 1) {
      items.push({ kind: 'single', assignment: rows[0] });
      continue;
    }
    const key = staffGroupKey(level, cardId, staffId);
    items.push({ kind: 'group', key, staffId, rows, collapsed: collapsed.has(key) });
  }
  return items;
}

/**
 * How many rows the card's staff block occupies: one per single booking, and
 * per group its overview row plus, while expanded, one per booking.
 */
export function staffRowCount(
  assignments: readonly StaffAssignment[] | undefined,
  level: StaffGroupLevel,
  cardId: number,
  collapsed: ReadonlySet<string>
): number {
  return cardStaffItems(assignments, level, cardId, collapsed).reduce(
    (count, item) => count + (item.kind === 'single' ? 1 : 1 + (item.collapsed ? 0 : item.rows.length)),
    0
  );
}

/** "40 %" when every booking has the same allocation, else "20–60 %". */
export function allocationRange(rows: readonly StaffAssignment[]): string {
  const values = rows.map((r) => r.allocation);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? `${min} %` : `${min}–${max} %`;
}
