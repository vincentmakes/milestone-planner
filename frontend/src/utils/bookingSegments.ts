/**
 * Unlinked booking segments: the shared date rule (1.17.0).
 *
 * A phase / subphase staff booking is either *linked* (no own dates: it
 * follows its card) or an *unlinked segment* with its own dates inside the
 * card. A person may hold several non-overlapping segments on one card. When
 * the card's dates change, its segments are fitted to the new dates with
 * `fitSegmentsToCard`:
 *
 *   - the card moved with the same duration -> every segment moves with it;
 *   - otherwise each segment is clamped into the card; a segment left fully
 *     outside is placed against the nearest edge, keeping its length (capped
 *     by the card), so it never ends before it starts nor outgrows the card;
 *   - unchanged card dates -> the segments are returned as they are.
 *
 * Mirror of app/services/booking_segments.py: the server applies the same
 * rule in the card PUT, the client applies it to its optimistic copy, so the
 * reload after a move shows what the user already sees.
 * tests/test_booking_segments.py and src/utils/__tests__/bookingSegmentsMirror.test.ts
 * carry the same case table -- change one, change both.
 *
 * Every date goes through the utils/date.ts helpers (local calendar days,
 * never `new Date(str)`); inputs may be `YYYY-MM-DD` or the midnight ISO form
 * the API sends, outputs are `YYYY-MM-DD`.
 */

import { addDaysToDateString, daysBetweenDateStrings, toDateOnly } from './date';
import type { StaffAssignment } from '@/types';

/** An inclusive range of calendar days. */
export interface DateSpan {
  start: string;
  end: string;
}

const maxDay = (a: string, b: string): string => (a >= b ? a : b);
const minDay = (a: string, b: string): string => (a <= b ? a : b);

/** Inclusive-day overlap: segments sharing at least one day overlap. */
export function segmentsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return toDateOnly(aStart) <= toDateOnly(bEnd) && toDateOnly(bStart) <= toDateOnly(aEnd);
}

function fitOne(segStart: string, segEnd: string, cardStart: string, cardEnd: string): DateSpan {
  const start = maxDay(segStart, cardStart);
  const end = minDay(segEnd, cardEnd);
  if (start <= end) return { start, end };
  // Fully outside the card: against the nearest edge, original length capped
  // by the card.
  const length = daysBetweenDateStrings(segStart, segEnd) + 1;
  if (segEnd < cardStart) {
    return { start: cardStart, end: minDay(addDaysToDateString(cardStart, length - 1), cardEnd) };
  }
  return { start: maxDay(addDaysToDateString(cardEnd, -(length - 1)), cardStart), end: cardEnd };
}

/** The segments of a card whose dates go from `old*` to `new*`, in input order. */
export function fitSegmentsToCard(
  oldStart: string,
  oldEnd: string,
  newStart: string,
  newEnd: string,
  segments: readonly DateSpan[]
): DateSpan[] {
  const os = toDateOnly(oldStart);
  const oe = toDateOnly(oldEnd);
  const ns = toDateOnly(newStart);
  const ne = toDateOnly(newEnd);
  const days = segments.map((s) => ({ start: toDateOnly(s.start), end: toDateOnly(s.end) }));
  if (os === ns && oe === ne) return days;
  if (ns !== os && daysBetweenDateStrings(ns, ne) === daysBetweenDateStrings(os, oe)) {
    const shift = daysBetweenDateStrings(os, ns);
    return days.map((s) => ({
      start: addDaysToDateString(s.start, shift),
      end: addDaysToDateString(s.end, shift),
    }));
  }
  return days.map((s) => fitOne(s.start, s.end, ns, ne));
}

/**
 * Keep a segment being dragged inside its card: shifted back inside with its
 * duration kept, and shortened to the card only when it is longer than the
 * card. Used by the live drag path and its commit.
 */
export function clampToCard(start: string, end: string, card: DateSpan): DateSpan {
  const s = toDateOnly(start);
  const e = toDateOnly(end);
  const cs = toDateOnly(card.start);
  const ce = toDateOnly(card.end);
  const length = daysBetweenDateStrings(s, e);
  if (length >= daysBetweenDateStrings(cs, ce)) return { start: cs, end: ce };
  if (s < cs) return { start: cs, end: addDaysToDateString(cs, length) };
  if (e > ce) return { start: addDaysToDateString(ce, -length), end: ce };
  return { start: s, end: e };
}

/**
 * Whether a card booking has dates of its own (an unlinked segment). Linked
 * rows -- `linked` true, or absent as in rows built before 1.17.0 -- follow
 * their card.
 */
export function isUnlinkedBooking(a: Pick<StaffAssignment, 'linked' | 'start_date' | 'end_date'>): boolean {
  return a.linked === false && Boolean(a.start_date) && Boolean(a.end_date);
}

/**
 * The days a card booking covers: its own dates when unlinked, the card's
 * otherwise. Reading a linked row's dates from its card keeps a local card
 * move (drag, What-If) consistent before any reload.
 */
export function bookingSpan(
  a: Pick<StaffAssignment, 'linked' | 'start_date' | 'end_date'>,
  card: { start_date: string; end_date: string }
): DateSpan {
  if (isUnlinkedBooking(a)) return { start: toDateOnly(a.start_date), end: toDateOnly(a.end_date) };
  return { start: toDateOnly(card.start_date), end: toDateOnly(card.end_date) };
}

/** A card's bookings per person (`staff_id`), each list in row order; people in order of first row. */
export function groupCardBookings(assignments: readonly StaffAssignment[]): Map<number, StaffAssignment[]> {
  const groups = new Map<number, StaffAssignment[]>();
  for (const a of assignments) {
    const list = groups.get(a.staff_id);
    if (list) list.push(a);
    else groups.set(a.staff_id, [a]);
  }
  return groups;
}

/**
 * Apply the card's new dates (already set on `card`) to its bookings, in
 * place: linked rows take the card's dates, unlinked rows are fitted with
 * `fitSegmentsToCard` from `oldStart` / `oldEnd`. Returns the unlinked rows
 * whose dates changed (pending ones included -- the server fits them too, the
 * caller decides what to persist). Nothing changes when the dates did not.
 */
export function fitCardBookingRows(
  card: { start_date: string; end_date: string; staffAssignments?: StaffAssignment[] },
  oldStart: string,
  oldEnd: string
): StaffAssignment[] {
  const newStart = toDateOnly(card.start_date);
  const newEnd = toDateOnly(card.end_date);
  if (toDateOnly(oldStart) === newStart && toDateOnly(oldEnd) === newEnd) return [];
  const rows = card.staffAssignments ?? [];
  const unlinked = rows.filter(isUnlinkedBooking);
  const fitted = fitSegmentsToCard(
    oldStart,
    oldEnd,
    newStart,
    newEnd,
    unlinked.map((a) => ({ start: a.start_date, end: a.end_date }))
  );
  const changed: StaffAssignment[] = [];
  unlinked.forEach((a, i) => {
    const next = fitted[i];
    if (toDateOnly(a.start_date) !== next.start || toDateOnly(a.end_date) !== next.end) changed.push(a);
    a.start_date = next.start;
    a.end_date = next.end;
  });
  for (const a of rows) {
    if (isUnlinkedBooking(a)) continue;
    a.start_date = newStart;
    a.end_date = newEnd;
  }
  return changed;
}
