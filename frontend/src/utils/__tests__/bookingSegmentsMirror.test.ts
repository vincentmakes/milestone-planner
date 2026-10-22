/**
 * Mirror of tests/test_booking_segments.py.
 *
 * The Gantt fits a card's unlinked segments locally when the card moves or
 * is resized, and the server fits them again in the card PUT
 * (app/services/booking_segments.py). That is only safe while both produce
 * exactly the same dates -- so FIT_CASES and OVERLAP_CASES below are copied
 * verbatim from the backend test. If you change one, change both.
 */

import { describe, it, expect } from 'vitest';
import {
  bookingSpan,
  clampToCard,
  fitCardBookingRows,
  fitSegmentsToCard,
  groupCardBookings,
  isUnlinkedBooking,
  segmentsOverlap,
} from '../bookingSegments';
import type { StaffAssignment } from '@/types';

type Pair = [string, string];

// (name, old_start, old_end, new_start, new_end, segments, expected)
const FIT_CASES: Array<[string, string, string, string, string, Pair[], Pair[]]> = [
  [
    'identity: unchanged card dates',
    '2026-03-02', '2026-03-13', '2026-03-02', '2026-03-13',
    [['2026-03-03', '2026-03-05'], ['2026-03-09', '2026-03-11']],
    [['2026-03-03', '2026-03-05'], ['2026-03-09', '2026-03-11']],
  ],
  [
    'translate forward: same duration, every segment moves',
    '2026-03-02', '2026-03-13', '2026-03-09', '2026-03-20',
    [['2026-03-03', '2026-03-05'], ['2026-03-09', '2026-03-11']],
    [['2026-03-10', '2026-03-12'], ['2026-03-16', '2026-03-18']],
  ],
  [
    'translate backward across a month boundary',
    '2026-03-02', '2026-03-13', '2026-02-23', '2026-03-06',
    [['2026-03-03', '2026-03-05'], ['2026-03-09', '2026-03-11']],
    [['2026-02-24', '2026-02-26'], ['2026-03-02', '2026-03-04']],
  ],
  [
    'shrink right: the segment past the new end is cut',
    '2026-03-02', '2026-03-13', '2026-03-02', '2026-03-10',
    [['2026-03-03', '2026-03-05'], ['2026-03-09', '2026-03-11']],
    [['2026-03-03', '2026-03-05'], ['2026-03-09', '2026-03-10']],
  ],
  [
    'shrink left: the segment before the new start is cut',
    '2026-03-02', '2026-03-13', '2026-03-04', '2026-03-13',
    [['2026-03-03', '2026-03-05'], ['2026-03-09', '2026-03-11']],
    [['2026-03-04', '2026-03-05'], ['2026-03-09', '2026-03-11']],
  ],
  [
    'grow on both sides: segments stay where they are',
    '2026-03-02', '2026-03-13', '2026-02-27', '2026-03-16',
    [['2026-03-03', '2026-03-05'], ['2026-03-09', '2026-03-11']],
    [['2026-03-03', '2026-03-05'], ['2026-03-09', '2026-03-11']],
  ],
  [
    'grow the end only: segments stay where they are',
    '2026-03-02', '2026-03-13', '2026-03-02', '2026-03-20',
    [['2026-03-09', '2026-03-11']],
    [['2026-03-09', '2026-03-11']],
  ],
  [
    'move and resize at once: clamped, not shifted',
    '2026-03-02', '2026-03-13', '2026-03-04', '2026-03-10',
    [['2026-03-03', '2026-03-05'], ['2026-03-09', '2026-03-11']],
    [['2026-03-04', '2026-03-05'], ['2026-03-09', '2026-03-10']],
  ],
  [
    'segment fully before the new start: against the start, length kept',
    '2026-03-02', '2026-03-13', '2026-03-09', '2026-03-13',
    [['2026-03-03', '2026-03-05']],
    [['2026-03-09', '2026-03-11']],
  ],
  [
    'segment fully after the new end: against the end, length kept',
    '2026-03-02', '2026-03-13', '2026-03-02', '2026-03-06',
    [['2026-03-09', '2026-03-11']],
    [['2026-03-04', '2026-03-06']],
  ],
  [
    'segment fully outside and longer than the card: capped to the card',
    '2026-03-02', '2026-03-13', '2026-03-02', '2026-03-03',
    [['2026-03-09', '2026-03-12']],
    [['2026-03-02', '2026-03-03']],
  ],
  [
    'segment fully before and longer than the card: capped to the card',
    '2026-03-02', '2026-03-13', '2026-03-12', '2026-03-13',
    [['2026-03-02', '2026-03-06']],
    [['2026-03-12', '2026-03-13']],
  ],
  [
    'segment straddling both new edges: cut to the card',
    '2026-03-02', '2026-03-13', '2026-03-04', '2026-03-06',
    [['2026-03-02', '2026-03-13']],
    [['2026-03-04', '2026-03-06']],
  ],
  [
    'one-day card: every segment becomes that day',
    '2026-03-02', '2026-03-13', '2026-03-05', '2026-03-05',
    [['2026-03-03', '2026-03-05'], ['2026-03-09', '2026-03-11']],
    [['2026-03-05', '2026-03-05'], ['2026-03-05', '2026-03-05']],
  ],
  [
    'one-day card moved: its one-day segment moves with it',
    '2026-03-05', '2026-03-05', '2026-03-08', '2026-03-08',
    [['2026-03-05', '2026-03-05']],
    [['2026-03-08', '2026-03-08']],
  ],
  [
    'no segments',
    '2026-03-02', '2026-03-13', '2026-03-09', '2026-03-20',
    [],
    [],
  ],
];

// (name, a_start, a_end, b_start, b_end, overlap)
const OVERLAP_CASES: Array<[string, string, string, string, string, boolean]> = [
  ['adjacent days do not overlap', '2026-03-02', '2026-03-05', '2026-03-06', '2026-03-09', false],
  ['adjacent days, other order', '2026-03-06', '2026-03-09', '2026-03-02', '2026-03-05', false],
  ['touching on one day overlaps', '2026-03-02', '2026-03-05', '2026-03-05', '2026-03-09', true],
  ['touching, other order', '2026-03-05', '2026-03-09', '2026-03-02', '2026-03-05', true],
  ['contained', '2026-03-02', '2026-03-13', '2026-03-05', '2026-03-06', true],
  ['partial', '2026-03-02', '2026-03-06', '2026-03-04', '2026-03-09', true],
  ['same single day', '2026-03-05', '2026-03-05', '2026-03-05', '2026-03-05', true],
  ['disjoint', '2026-03-02', '2026-03-03', '2026-03-10', '2026-03-12', false],
];

const spans = (pairs: Pair[]) => pairs.map(([start, end]) => ({ start, end }));

describe('fitSegmentsToCard (mirror of fit_segments_to_card)', () => {
  it.each(FIT_CASES)('%s', (_name, oldStart, oldEnd, newStart, newEnd, segments, expected) => {
    const result = fitSegmentsToCard(oldStart, oldEnd, newStart, newEnd, spans(segments));
    expect(result).toEqual(spans(expected));
    // Every fitted segment lies inside the new card and never ends before it starts.
    for (const seg of result) {
      expect(newStart <= seg.start && seg.start <= seg.end && seg.end <= newEnd).toBe(true);
    }
  });

  it('returns a new list for the identity case', () => {
    const segments = spans([['2026-03-03', '2026-03-05']]);
    const result = fitSegmentsToCard('2026-03-02', '2026-03-13', '2026-03-02', '2026-03-13', segments);
    expect(result).toEqual(segments);
    expect(result).not.toBe(segments);
  });

  it('reads the midnight ISO form the API sends', () => {
    expect(
      fitSegmentsToCard(
        '2026-03-02T00:00:00.000Z',
        '2026-03-13T00:00:00.000Z',
        '2026-03-09',
        '2026-03-20',
        [{ start: '2026-03-03T00:00:00.000Z', end: '2026-03-05T00:00:00.000Z' }]
      )
    ).toEqual([{ start: '2026-03-10', end: '2026-03-12' }]);
  });
});

describe('segmentsOverlap (mirror of segments_overlap)', () => {
  it.each(OVERLAP_CASES)('%s', (_name, aStart, aEnd, bStart, bEnd, overlap) => {
    expect(segmentsOverlap(aStart, aEnd, bStart, bEnd)).toBe(overlap);
  });
});

describe('clampToCard', () => {
  const card = { start: '2026-03-02', end: '2026-03-13' };

  it.each([
    ['inside: unchanged', '2026-03-04', '2026-03-06', '2026-03-04', '2026-03-06'],
    ['past the start: shifted back in, duration kept', '2026-02-27', '2026-03-03', '2026-03-02', '2026-03-06'],
    ['past the end: shifted back in, duration kept', '2026-03-11', '2026-03-16', '2026-03-08', '2026-03-13'],
    ['longer than the card: shortened to it', '2026-02-20', '2026-03-20', '2026-03-02', '2026-03-13'],
    ['as long as the card: the card', '2026-03-05', '2026-03-16', '2026-03-02', '2026-03-13'],
  ])('%s', (_name, start, end, expStart, expEnd) => {
    expect(clampToCard(start, end, card)).toEqual({ start: expStart, end: expEnd });
  });
});

const row = (over: Partial<StaffAssignment>): StaffAssignment => ({
  id: 1,
  staff_id: 4,
  allocation: 50,
  start_date: '2026-03-02',
  end_date: '2026-03-13',
  ...over,
});

describe('isUnlinkedBooking / bookingSpan', () => {
  const card = { start_date: '2026-03-02T00:00:00.000Z', end_date: '2026-03-13' };

  it('reads only linked: false with dates as unlinked', () => {
    expect(isUnlinkedBooking(row({ linked: false }))).toBe(true);
    expect(isUnlinkedBooking(row({ linked: true }))).toBe(false);
    expect(isUnlinkedBooking(row({}))).toBe(false); // built before 1.17.0: follows the card
    expect(isUnlinkedBooking(row({ linked: false, start_date: '' }))).toBe(false);
  });

  it('spans the card when linked, its own dates otherwise', () => {
    expect(bookingSpan(row({ linked: true, start_date: '2026-01-01', end_date: '2026-01-02' }), card)).toEqual({
      start: '2026-03-02',
      end: '2026-03-13',
    });
    expect(bookingSpan(row({ linked: false, start_date: '2026-03-04T00:00:00.000Z', end_date: '2026-03-05' }), card)).toEqual({
      start: '2026-03-04',
      end: '2026-03-05',
    });
  });
});

describe('groupCardBookings', () => {
  it('groups rows per person in row order, people in order of first row', () => {
    const a = row({ id: 1, staff_id: 7 });
    const b = row({ id: 2, staff_id: 4 });
    const c = row({ id: 3, staff_id: 7 });
    const groups = groupCardBookings([a, b, c]);
    expect(Array.from(groups.keys())).toEqual([7, 4]);
    expect(groups.get(7)).toEqual([a, c]);
    expect(groups.get(4)).toEqual([b]);
  });

  it('is empty without rows', () => {
    expect(groupCardBookings([]).size).toBe(0);
  });
});

describe('fitCardBookingRows', () => {
  it('translates unlinked rows, moves linked rows with the card and returns the changed segments', () => {
    const linked = row({ id: 1, linked: true });
    const seg = row({ id: 2, linked: false, start_date: '2026-03-03', end_date: '2026-03-05' });
    const card = { start_date: '2026-03-09', end_date: '2026-03-20', staffAssignments: [linked, seg] };

    const changed = fitCardBookingRows(card, '2026-03-02', '2026-03-13');

    expect(changed).toEqual([seg]);
    expect([seg.start_date, seg.end_date]).toEqual(['2026-03-10', '2026-03-12']);
    expect([linked.start_date, linked.end_date]).toEqual(['2026-03-09', '2026-03-20']);
  });

  it('leaves a segment the clamp does not touch out of the changed list', () => {
    const seg = row({ id: 2, linked: false, start_date: '2026-03-03', end_date: '2026-03-05' });
    const card = { start_date: '2026-03-02', end_date: '2026-03-10', staffAssignments: [seg] };
    expect(fitCardBookingRows(card, '2026-03-02', '2026-03-13')).toEqual([]);
    expect(seg.end_date).toBe('2026-03-05');
  });

  it('does nothing when the card dates did not change', () => {
    const linked = row({ id: 1, linked: true, start_date: 'stale', end_date: 'stale' });
    const card = { start_date: '2026-03-02', end_date: '2026-03-13', staffAssignments: [linked] };
    expect(fitCardBookingRows(card, '2026-03-02T00:00:00.000Z', '2026-03-13')).toEqual([]);
    expect(linked.start_date).toBe('stale');
  });

  it('copes with a card without bookings', () => {
    expect(fitCardBookingRows({ start_date: '2026-03-03', end_date: '2026-03-13' }, '2026-03-02', '2026-03-13')).toEqual([]);
  });
});
