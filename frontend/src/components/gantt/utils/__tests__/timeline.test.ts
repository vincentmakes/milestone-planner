/**
 * Timelines start months before the current date, so they open by centring
 * today; scrollLeft 0 would show the past (the "calendar opens in 2025" bug).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { calculateTodayScrollLeft, generateTimelineCells, generateTimelineHeaders } from '../timeline';
import type { ViewMode } from '@/types';

const VIEW_MODES: ViewMode[] = ['week', 'month', 'quarter', 'year'];

describe('calculateTodayScrollLeft', () => {
  it.each(VIEW_MODES)('centres the today cell in %s view', (mode) => {
    const cells = generateTimelineCells(new Date(), mode, new Set(), []);
    const cellWidth = 30;
    const containerWidth = 900;

    const scrollLeft = calculateTodayScrollLeft(cells, cellWidth, containerWidth);

    const todayIndex = cells.findIndex((c) => c.isToday);
    expect(todayIndex).toBeGreaterThan(0);
    expect(scrollLeft).toBe(Math.max(0, todayIndex * cellWidth + cellWidth / 2 - containerWidth / 2));
    expect(scrollLeft).toBeGreaterThan(0);
  });

  it('returns null when today is outside the timeline', () => {
    const cells = generateTimelineCells(new Date(2000, 0, 1), 'month', new Set(), []);
    expect(calculateTodayScrollLeft(cells, 30, 900)).toBeNull();
  });

  it('never scrolls before the start', () => {
    const cells = generateTimelineCells(new Date(), 'month', new Set(), []);
    expect(calculateTodayScrollLeft(cells, 30, 1_000_000)).toBe(0);
  });
});

/**
 * Company events tint their days; one flagged as a site closure also sets
 * `isSiteClosure` so the grid can paint it stronger and name it as a closure.
 */
describe('generateTimelineCells company events', () => {
  const closure = {
    date: '2026-03-10',
    end_date: '2026-03-11',
    name: 'Site shutdown',
    color: '#f97316',
    counts_as_unavailable: true,
  };
  const audit = { date: '2026-03-12', end_date: null, name: 'ISO Audit', color: '#3b82f6' };
  const eventDates = new Set(['2026-03-10', '2026-03-11', '2026-03-12']);
  const cells = generateTimelineCells(new Date(2026, 2, 10), 'month', new Set(), [], eventDates, [closure, audit]);
  const byDate = (d: string) => cells.find((c) => c.dateStr === d)!;

  it('flags the closure days and keeps the event name and colour', () => {
    expect(byDate('2026-03-10')).toMatchObject({
      isCompanyEvent: true,
      isSiteClosure: true,
      companyEventName: 'Site shutdown',
      companyEventColor: '#f97316',
    });
    expect(byDate('2026-03-11').isSiteClosure).toBe(true);
  });

  it('leaves plain events and ordinary days unflagged', () => {
    expect(byDate('2026-03-12')).toMatchObject({ isCompanyEvent: true, isSiteClosure: false, companyEventName: 'ISO Audit' });
    expect(byDate('2026-03-13')).toMatchObject({ isCompanyEvent: false, isSiteClosure: false });
  });

  it('prefers the closure when a plain event overlaps the same day', () => {
    const overlapping = generateTimelineCells(
      new Date(2026, 2, 10), 'month', new Set(), [], eventDates,
      [{ ...audit, date: '2026-03-10' }, closure]
    );
    expect(overlapping.find((c) => c.dateStr === '2026-03-10')).toMatchObject({
      isSiteClosure: true,
      companyEventName: 'Site shutdown',
    });
  });
});

/**
 * Week labels are ISO 8601 weeks (Monday start, week 1 holds 4 January):
 * date-fns `getWeek` without `firstWeekContainsDate: 4` labelled the first
 * days of 2027 as W1 and the first ISO week as W2.
 */
describe('ISO week numbers', () => {
  const weekOf = (cells: ReturnType<typeof generateTimelineCells>, dateStr: string) =>
    cells.find((c) => c.dateStr === dateStr)?.weekNumber;

  it.each([
    ['2027-01-01', 53], // Friday of ISO week 2026-W53
    ['2027-01-03', 53], // Sunday, still W53
    ['2027-01-04', 1],  // Monday, first ISO week of 2027
    ['2021-01-01', 53],
    ['2021-01-04', 1],
    ['2028-01-02', 52],
    ['2028-01-03', 1],
    ['2026-12-31', 53],
  ])('labels day %s as W%i in month view', (dateStr, iso) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const cells = generateTimelineCells(new Date(y, m - 1, d), 'month', new Set(), []);
    expect(weekOf(cells, dateStr)).toBe(iso);
  });

  it('labels the quarter-view week starting 2027-01-04 as W1 and the one before as W53', () => {
    const cells = generateTimelineCells(new Date(2027, 0, 4), 'quarter', new Set(), []);
    const headers = generateTimelineHeaders(cells, 'quarter').secondary;
    const i = cells.findIndex((c) => c.dateStr === '2027-01-04');
    expect(i).toBeGreaterThan(0);
    expect(headers[i].label).toBe('W1');
    expect(headers[i - 1].label).toBe('W53');
  });
});

/**
 * The month header of the current month is highlighted wherever it sits in
 * the timeline — it used to be flagged only when it was the last header.
 */
describe('current month highlight', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['week', 'month'] as const)('flags exactly the current month header in %s view', (mode) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 15, 12));
    const cells = generateTimelineCells(new Date(2026, 5, 15), mode, new Set(), []);
    const primary = generateTimelineHeaders(cells, mode).primary;

    const current = primary.filter((h) => h.isCurrentPeriod);
    expect(current.map((h) => h.label)).toEqual(['Jun 2026']);
    // Not the last header: the timeline extends past the current month
    expect(primary[primary.length - 1].label).not.toBe('Jun 2026');
  });

  it('flags the last header when it is the current month', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 15, 12));
    const cells = generateTimelineCells(new Date(2026, 5, 15), 'month', new Set(), [])
      .filter((c) => c.dateStr <= '2026-06-30');
    const primary = generateTimelineHeaders(cells, 'month').primary;
    expect(primary[primary.length - 1]).toMatchObject({ label: 'Jun 2026', isCurrentPeriod: true });
    expect(primary.filter((h) => h.isCurrentPeriod)).toHaveLength(1);
  });
});
