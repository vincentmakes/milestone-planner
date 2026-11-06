/**
 * Timelines start months before the current date, so they open by centring
 * today; scrollLeft 0 would show the past (the "calendar opens in 2025" bug).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateTodayCenterScrollLeft,
  calculateTodayPosition,
  calculateTodayScrollLeft,
  findTodayCell,
  generateTimelineCells,
  generateTimelineHeaders,
  leftEdgeDate,
  openingScrollLeft,
  scrollLeftForDate,
} from '../timeline';
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
    id: 1,
    date: '2026-03-10',
    end_date: '2026-03-11',
    name: 'Site shutdown',
    color: '#f97316',
    counts_as_unavailable: true,
  };
  const audit = { id: 2, date: '2026-03-12', end_date: null, name: 'ISO Audit', color: '#3b82f6' };
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

  it('keeps a team-limited closure as a plain event (the header cell is whole-site)', () => {
    const teamClosure = { ...closure, id: 3, name: 'Lab A shutdown', team_ids: [7] };
    const teamCells = generateTimelineCells(new Date(2026, 2, 10), 'month', new Set(), [], eventDates, [teamClosure]);
    expect(teamCells.find((c) => c.dateStr === '2026-03-10')).toMatchObject({
      isCompanyEvent: true,
      isSiteClosure: false,
      companyEventName: 'Lab A shutdown',
    });
  });

  it('shades a whole-site closure even when a team-limited closure shares the day', () => {
    const teamClosure = { ...closure, id: 3, name: 'Lab A shutdown', team_ids: [7] };
    const mixed = generateTimelineCells(
      new Date(2026, 2, 10), 'month', new Set(), [], eventDates,
      [teamClosure, { ...closure, team_ids: [] }]
    );
    expect(mixed.find((c) => c.dateStr === '2026-03-10')).toMatchObject({
      isSiteClosure: true,
      companyEventName: 'Site shutdown',
    });
  });
});

/**
 * Every cell lists all the events overlapping it (`companyEvents`) for the
 * timeline strip: whole-site closures first, then team-limited closures, then
 * plain events, each group by start, then name (plain string order), then id.
 */
describe('generateTimelineCells companyEvents', () => {
  const day = '2026-03-10';
  const at = (cells: ReturnType<typeof generateTimelineCells>, dateStr: string) =>
    cells.find((c) => c.dateStr === dateStr)!;

  it('lists every event of a day in closure-first, start, name, id order', () => {
    const events = [
      { id: 21, date: '2026-03-10', name: 'Alpha', color: '#111111' },
      { id: 20, date: '2026-03-10', name: 'Alpha', color: '#222222' },
      { id: 5, date: '2026-03-10', name: 'alpha' },
      { id: 30, date: '2026-03-08', end_date: '2026-03-12', name: 'Zulu fair' },
      { id: 40, date: '2026-03-09', end_date: '2026-03-10', name: 'Lab A shutdown', counts_as_unavailable: true, team_ids: [7] },
      { id: 50, date: '2026-03-10', name: 'Site shutdown', counts_as_unavailable: true, team_ids: [] },
      { id: 60, date: '2026-03-11', name: 'Tomorrow' },
    ];
    const cells = generateTimelineCells(new Date(2026, 2, 10), 'month', new Set(), [], new Set([day]), events);
    const cell = at(cells, day);
    // 'Alpha' < 'alpha' in plain string order (upper case first), whatever the locale
    expect(cell.companyEvents.map((e) => e.id)).toEqual([50, 40, 30, 20, 21, 5]);
    expect(cell).toMatchObject({ isCompanyEvent: true, isSiteClosure: true, companyEventName: 'Site shutdown' });
    expect(at(cells, '2026-03-11').companyEvents.map((e) => e.id)).toEqual([30, 60]);
    expect(at(cells, '2026-03-13').companyEvents).toEqual([]);
  });

  it('normalises an event into the cell shape', () => {
    const cells = generateTimelineCells(new Date(2026, 2, 10), 'month', new Set(), [], new Set([day]), [
      { id: 9, date: '2026-03-10T00:00:00.000Z', end_date: '2026-03-11T00:00:00.000Z', name: 'Audit' },
      { id: 8, date: '2026-03-10', end_date: null, name: 'Review', color: '#3b82f6', counts_as_unavailable: false, team_ids: [2, 3] },
    ]);
    expect(at(cells, day).companyEvents).toEqual([
      { id: 9, name: 'Audit', color: null, start: '2026-03-10', end: '2026-03-11', isClosure: false, teamIds: [] },
      { id: 8, name: 'Review', color: '#3b82f6', start: '2026-03-10', end: '2026-03-10', isClosure: false, teamIds: [2, 3] },
    ]);
  });

  it('marks a team-limited closure isClosure without making the day a site closure', () => {
    const cells = generateTimelineCells(new Date(2026, 2, 10), 'month', new Set(), [], new Set([day]), [
      { id: 1, date: day, name: 'Lab A shutdown', color: '#f97316', counts_as_unavailable: true, team_ids: [7] },
    ]);
    const cell = at(cells, day);
    expect(cell.companyEvents[0]).toMatchObject({ isClosure: true, teamIds: [7] });
    expect(cell).toMatchObject({ isSiteClosure: false, isCompanyEvent: true, companyEventColor: '#f97316' });
  });

  it('keeps a holiday and the events of the same day', () => {
    const cells = generateTimelineCells(
      new Date(2026, 3, 6), 'month', new Set(['2026-04-06']), [{ date: '2026-04-06', name: 'Easter Monday' }],
      new Set(['2026-04-06']),
      [{ id: 1, date: '2026-04-06', name: 'ISO 9001 audit' }, { id: 2, date: '2026-04-06', name: 'Lab safety walk-through' }]
    );
    expect(at(cells, '2026-04-06')).toMatchObject({
      isBankHoliday: true,
      bankHolidayName: 'Easter Monday',
      isCompanyEvent: true,
      companyEventName: 'ISO 9001 audit',
    });
    expect(at(cells, '2026-04-06').companyEvents.map((e) => e.name)).toEqual(['ISO 9001 audit', 'Lab safety walk-through']);
  });

  it('lists in a quarter week an event on its Wednesday', () => {
    // Week of Monday 9 March 2026; the event is on Wednesday 11 March only
    const cells = generateTimelineCells(new Date(2026, 2, 9), 'quarter', new Set(), [], new Set(['2026-03-11']), [
      { id: 1, date: '2026-03-11', name: 'ISO 9001 audit', color: '#f59e0b', counts_as_unavailable: true },
    ]);
    const week = at(cells, '2026-03-09');
    expect(week.dateEnd).toBeDefined();
    expect(week).toMatchObject({
      isCompanyEvent: true,
      companyEventName: 'ISO 9001 audit',
      companyEventColor: '#f59e0b',
      // span cells never shade as closed
      isSiteClosure: false,
    });
    expect(week.companyEvents.map((e) => e.id)).toEqual([1]);
    // The weeks before and after
    expect(at(cells, '2026-03-02')).toMatchObject({ isCompanyEvent: false, companyEvents: [] });
    expect(at(cells, '2026-03-16')).toMatchObject({ isCompanyEvent: false, companyEvents: [] });
  });

  it('lists in a quarter week an event that ends on its Sunday or starts before its Monday', () => {
    const cells = generateTimelineCells(new Date(2026, 2, 9), 'quarter', new Set(), [], new Set(), [
      { id: 1, date: '2026-03-15', name: 'Sunday' },
      { id: 2, date: '2026-03-01', end_date: '2026-03-09', name: 'Long' },
    ]);
    expect(at(cells, '2026-03-09').companyEvents.map((e) => e.id)).toEqual([2, 1]);
  });

  it('lists in a year month an event on its 20th, and none in a month without', () => {
    const cells = generateTimelineCells(new Date(2026, 2, 1), 'year', new Set(), [], new Set(['2026-03-20']), [
      { id: 1, date: '2026-03-20', name: 'Trade fair', color: '#14b8a6' },
      { id: 2, date: '2026-04-30', end_date: '2026-05-01', name: 'Turn of the month' },
    ]);
    const march = at(cells, '2026-03-01');
    expect(march.dateEnd).toBeUndefined();
    expect(march).toMatchObject({ isCompanyEvent: true, companyEventName: 'Trade fair', companyEventColor: '#14b8a6', isSiteClosure: false });
    expect(march.companyEvents.map((e) => e.id)).toEqual([1]);
    expect(at(cells, '2026-02-01')).toMatchObject({ isCompanyEvent: false, companyEvents: [], companyEventName: undefined });
    expect(at(cells, '2026-04-01').companyEvents.map((e) => e.id)).toEqual([2]);
    expect(at(cells, '2026-05-01').companyEvents.map((e) => e.id)).toEqual([2]);
  });

  it('gives a year month its last day (February in a leap year)', () => {
    const cells = generateTimelineCells(new Date(2028, 1, 1), 'year', new Set(), [], new Set(), [
      { id: 1, date: '2028-02-29', name: 'Leap day' },
    ]);
    expect(at(cells, '2028-02-01').companyEvents.map((e) => e.id)).toEqual([1]);
    expect(at(cells, '2028-03-01').companyEvents).toEqual([]);
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

describe('today on a hidden weekend day', () => {
  // Saturday 17 October 2026; weekends hidden drops its cell in the day views.
  const saturday = new Date(2026, 9, 17, 10, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(saturday);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['week', 'month'] as const)('falls back to the next working day in %s view', (mode) => {
    const cells = generateTimelineCells(saturday, mode, new Set(), [], new Set(), [], false);
    expect(cells.some((c) => c.isToday)).toBe(false);

    const today = findTodayCell(cells);
    expect(today).not.toBeNull();
    expect(today!.exact).toBe(false);
    expect(cells[today!.index].dateStr).toBe('2026-10-19'); // Monday

    // The today line sits on the boundary before Monday; the Today button centres Monday.
    expect(calculateTodayPosition(cells, 30)).toBe(today!.index * 30);
    expect(calculateTodayCenterScrollLeft(cells, 30, 600)).toBe(Math.max(0, today!.index * 30 - 300 + 15));
  });

  it('uses the exact cell when weekends are shown or the cells are weeks', () => {
    const month = generateTimelineCells(saturday, 'month', new Set(), [], new Set(), [], true);
    expect(findTodayCell(month)).toEqual({ index: month.findIndex((c) => c.isToday), exact: true });
    expect(calculateTodayPosition(month, 30)).toBe(month.findIndex((c) => c.isToday) * 30 + 15);

    const quarter = generateTimelineCells(saturday, 'quarter', new Set(), [], new Set(), [], false);
    expect(findTodayCell(quarter)?.exact).toBe(true);
  });

  it('is null when today lies outside the timeline', () => {
    const past = generateTimelineCells(new Date(2024, 0, 15), 'week', new Set(), [], new Set(), [], false);
    const future = generateTimelineCells(new Date(2029, 0, 15), 'week', new Set(), [], new Set(), [], false);
    expect(findTodayCell(past)).toBeNull();
    expect(findTodayCell(future)).toBeNull();
    expect(findTodayCell([])).toBeNull();
    expect(calculateTodayCenterScrollLeft(past, 30, 600)).toBeNull();
  });
});

describe('leftEdgeDate / scrollLeftForDate (a place kept by date, never by pixel)', () => {
  const CW = 30;
  const at = new Date(2026, 2, 15);
  const days = generateTimelineCells(at, 'month', new Set(), []);
  const weekdays = generateTimelineCells(at, 'month', new Set(), [], new Set(), [], false);
  const weeks = generateTimelineCells(at, 'quarter', new Set(), []);
  const months = generateTimelineCells(at, 'year', new Set(), []);

  it.each([
    ['day cells', days],
    ['weekday cells', weekdays],
    ['quarter weeks', weeks],
    ['year months', months],
  ])('round-trips every cell date with %s', (_label, cells) => {
    for (const index of [0, 5, Math.floor(cells.length / 2), cells.length - 1]) {
      const date = cells[index].dateStr;
      expect(scrollLeftForDate(cells, CW, date)).toBe(index * CW);
      expect(leftEdgeDate(cells, CW, index * CW)).toBe(date);
      expect(leftEdgeDate(cells, CW, index * CW + CW - 1)).toBe(date);
    }
  });

  it('sends a hidden weekend day to the next working day', () => {
    // Saturday 7 and Sunday 8 March 2026 have no cell: Monday 9 holds them.
    const monday = weekdays.findIndex((c) => c.dateStr === '2026-03-09');
    expect(scrollLeftForDate(weekdays, CW, '2026-03-07')).toBe(monday * CW);
    expect(scrollLeftForDate(weekdays, CW, '2026-03-08')).toBe(monday * CW);
  });

  it('keeps a day inside the span cell (quarter week, year month) that holds it', () => {
    const week = weeks.findIndex((c) => c.dateStr === '2026-03-09'); // Monday
    expect(scrollLeftForDate(weeks, CW, '2026-03-12')).toBe(week * CW);
    const month = months.findIndex((c) => c.dateStr === '2026-03-01');
    expect(scrollLeftForDate(months, CW, '2026-03-20')).toBe(month * CW);
  });

  it('clamps to the timeline ends and handles no cells', () => {
    expect(scrollLeftForDate(days, CW, '1990-01-01')).toBe(0);
    expect(scrollLeftForDate(days, CW, '2999-01-01')).toBe((days.length - 1) * CW);
    expect(leftEdgeDate(days, CW, -50)).toBe(days[0].dateStr);
    expect(leftEdgeDate(days, CW, 10 ** 9)).toBe(days[days.length - 1].dateStr);
    expect(scrollLeftForDate([], CW, '2026-03-09')).toBe(0);
    expect(leftEdgeDate([], CW, 0)).toBeNull();
  });
});

describe('openingScrollLeft', () => {
  it('opens on the anchor date when there is one, on today otherwise', () => {
    const cells = generateTimelineCells(new Date(), 'month', new Set(), []);
    expect(openingScrollLeft(cells, 30, 900, null)).toBe(calculateTodayScrollLeft(cells, 30, 900));
    expect(openingScrollLeft(cells, 30, 900, cells[40].dateStr)).toBe(40 * 30);
  });

  it('opens at 0 when today is outside the timeline and nothing is anchored', () => {
    const past = generateTimelineCells(new Date(2000, 0, 1), 'month', new Set(), []);
    expect(openingScrollLeft(past, 30, 900, null)).toBe(0);
  });
});
