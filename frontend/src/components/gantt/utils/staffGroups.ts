/**
 * The staff block of a phase / subphase in the Gantt tree (1.17.0): one row
 * per booking, except that a person with two or more bookings on the card
 * gets a collapsible overview row (the panel's StaffGroupRow, the timeline's
 * SegmentsBar) followed, while expanded, by their bookings.
 *
 * The panel, the timeline and `calculateRowPositions` all lay the block out
 * from `cardStaffItems` / `staffRowCount`, so the two panes and the row
 * geometry can never disagree. People come in the order of their first row
 * (`groupCardBookings`), each person's rows in date order (effective start,
 * then id).
 */

import { bookingSpan, groupCardBookings, isUnlinkedBooking, segmentsOverlap } from '@/utils/bookingSegments';
import type { StaffAssignment } from '@/types';

export type StaffGroupLevel = 'phase' | 'subphase';

/** The card a staff block belongs to: its id and dates (for `bookingSpan`). */
export interface StaffCard {
  id: number;
  start_date: string;
  end_date: string;
}

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

/**
 * The card's staff block: singles and per-person groups, each placed where
 * the person's first row comes in API order; a group's rows in date order
 * (effective start from `bookingSpan`, then id).
 */
export function cardStaffItems(
  assignments: readonly StaffAssignment[] | undefined,
  level: StaffGroupLevel,
  card: StaffCard,
  collapsed: ReadonlySet<string>
): CardStaffItem[] {
  const items: CardStaffItem[] = [];
  for (const [staffId, rows] of groupCardBookings(assignments ?? [])) {
    if (rows.length === 1) {
      items.push({ kind: 'single', assignment: rows[0] });
      continue;
    }
    // A card without dates (partial test fixtures) leaves its linked rows first.
    const startOf = (row: StaffAssignment) =>
      isUnlinkedBooking(row) || (card.start_date && card.end_date) ? bookingSpan(row, card).start : '';
    const starts = new Map(rows.map((row) => [row.id, startOf(row)]));
    const ordered = [...rows].sort((a, b) => {
      const sa = starts.get(a.id) as string;
      const sb = starts.get(b.id) as string;
      return sa < sb ? -1 : sa > sb ? 1 : a.id - b.id;
    });
    const key = staffGroupKey(level, card.id, staffId);
    items.push({ kind: 'group', key, staffId, rows: ordered, collapsed: collapsed.has(key) });
  }
  return items;
}

/**
 * Whether relinking an unlinked booking would overlap another booking of the
 * same person on the card -- the server refuses it with a 409 ("already
 * booked on this card for overlapping dates"), so the pin is disabled. A
 * linked row (unlinking is never blocked) or a lone row: false. Pending rows
 * of the person are ignored; a linked sibling always overlaps the card.
 */
export function relinkWouldOverlap(
  row: StaffAssignment,
  assignments: readonly StaffAssignment[] | undefined,
  card: StaffCard
): boolean {
  if (!isUnlinkedBooking(row)) return false;
  return (assignments ?? []).some((other) => {
    if (other.id === row.id || other.staff_id !== row.staff_id || other.approval_status === 'pending') return false;
    const span = bookingSpan(other, card);
    return segmentsOverlap(span.start, span.end, card.start_date, card.end_date);
  });
}

/**
 * How many rows the card's staff block occupies: one per single booking, and
 * per group its overview row plus, while expanded, one per booking.
 */
export function staffRowCount(
  assignments: readonly StaffAssignment[] | undefined,
  level: StaffGroupLevel,
  card: StaffCard,
  collapsed: ReadonlySet<string>
): number {
  return cardStaffItems(assignments, level, card, collapsed).reduce(
    (count, item) => count + (item.kind === 'single' ? 1 : 1 + (item.collapsed ? 0 : item.rows.length)),
    0
  );
}

/** "40%" when every booking has the same allocation, else "20–60%" (as the booking rows print it). */
export function allocationRange(rows: readonly StaffAssignment[]): string {
  const values = rows.map((r) => r.allocation);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? `${min}%` : `${min}–${max}%`;
}
