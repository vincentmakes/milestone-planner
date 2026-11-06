/**
 * Horizontal positioning of the Gantt timeline: open on today, or on the
 * session's anchor date after a view switch (a date, never a pixel offset),
 * scroll-to-today / scroll-to-date triggers (smooth alone, instant when an
 * overview panel is synced), zoom re-centring, keeping the left-edge date
 * across view-mode and weekend switches and navigations, and the debounced
 * save of the position. The "regression guard" block at the end pins the
 * reload-after-refresh race that once opened the Gantt months ahead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useMemo } from 'react';
import { render, act, fireEvent, waitFor } from '@testing-library/react';
import { Timeline } from '../Timeline';
import { generateTimelineCells, generateTimelineHeaders } from '../../utils';
import { calculateTodayScrollLeft } from '../../utils/timeline';
import { resetAllStores, useAppStore, useUIStore, useViewStore } from '@/stores';
import { formatDateISO } from '@/utils/date';
import type { TimelineCell } from '../../utils';
import type { ViewMode } from '@/types';

vi.mock('../ProjectTimeline', () => ({ ProjectTimeline: () => null }));
vi.mock('../DependencyLayer', () => ({ DependencyLayer: () => null }));
// Positioning only: the header and the grid (a node per cell, ~1 500 cells a
// render at month zoom) add nothing here but time.
vi.mock('../TimelineHeader', () => ({ TimelineHeader: () => null }));
vi.mock('../TimelineBody', async () => {
  const { forwardRef } = await import('react');
  return { TimelineBody: forwardRef<HTMLDivElement>(function TimelineBody(_props, ref) { return <div ref={ref} />; }) };
});

const CW = 30;
const marchCells = generateTimelineCells(new Date(2026, 2, 15), 'month', new Set(), []);
const nowCells = generateTimelineCells(new Date(), 'month', new Set(), []);
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

function renderTimeline(cells: TimelineCell[] = marchCells, viewMode: ViewMode = 'month') {
  const utils = render(
    <Timeline
      cells={cells}
      headers={generateTimelineHeaders(cells, viewMode)}
      projects={[]}
      cellWidth={CW}
      viewMode={viewMode}
    />
  );
  const scroller = utils.container.querySelector('[class*="horizontalScroll"]') as HTMLDivElement;
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 600 });
  scroller.scrollTo = vi.fn() as unknown as typeof scroller.scrollTo;
  const rerender = (vm: ViewMode, c: TimelineCell[] = cells) =>
    utils.rerender(
      <Timeline cells={c} headers={generateTimelineHeaders(c, vm)} projects={[]} cellWidth={CW} viewMode={vm} />
    );
  return { ...utils, scroller, rerender };
}

const indexOf = (cells: TimelineCell[], date: string) => cells.findIndex((c) => c.dateStr === date);

beforeEach(() => {
  resetAllStores();
  useViewStore.setState({
    viewMode: 'month',
    timelineScrollLeft: 0,
    timelineAnchorDate: null,
    showStaffOverview: false,
    showEquipmentOverview: false,
  });
});

describe('Timeline scale', () => {
  it('keeps its header and body compact (compact-ui on its root)', () => {
    const { container } = renderTimeline();
    expect(container.firstElementChild).toHaveClass('compact-ui');
  });
});

const anchor = () => useViewStore.getState().timelineAnchorDate;
const weekdayMarchCells = generateTimelineCells(new Date(2026, 2, 15), 'month', new Set(), [], new Set(), [], false);

describe('Timeline initial position', () => {
  it("restores this session's anchor date at the left edge", async () => {
    useViewStore.setState({ timelineAnchorDate: '2026-03-10' });
    const { scroller } = renderTimeline();
    await nextFrame();
    expect(scroller.scrollLeft).toBe(indexOf(marchCells, '2026-03-10') * CW);
    expect(useViewStore.getState().timelineScrollLeft).toBe(scroller.scrollLeft);
  });

  it('restores the anchor date on another cell set; a hidden weekend day falls to the Monday', async () => {
    // Anchored on Saturday 7 March with weekends shown, back with weekends hidden.
    const first = renderTimeline();
    await nextFrame();
    first.scroller.scrollLeft = indexOf(marchCells, '2026-03-07') * CW;
    fireEvent.scroll(first.scroller);
    await waitFor(() => expect(anchor()).toBe('2026-03-07'));
    first.unmount();

    const { scroller } = renderTimeline(weekdayMarchCells);
    await nextFrame();
    expect(weekdayMarchCells[scroller.scrollLeft / CW].dateStr).toBe('2026-03-09');
  });

  it('never opens on a stored pixel offset', async () => {
    useViewStore.setState({ timelineScrollLeft: 450 });
    const { scroller } = renderTimeline(nowCells);
    await nextFrame();
    expect(scroller.scrollLeft).toBe(calculateTodayScrollLeft(nowCells, CW, 600));
  });

  it('does not anchor on its mount', async () => {
    renderTimeline(nowCells);
    await nextFrame();
    expect(anchor()).toBeNull();
  });

  it('a reload (fresh store, rehydrated) opens on today, whatever was anchored', async () => {
    const first = renderTimeline(nowCells);
    await nextFrame();
    first.scroller.scrollLeft = 120;
    fireEvent.scroll(first.scroller);
    await waitFor(() => expect(anchor()).toBe(nowCells[4].dateStr));
    first.unmount();

    // A reload: the initial state, then whatever localStorage holds.
    useViewStore.setState(useViewStore.getInitialState(), true);
    await useViewStore.persist.rehydrate();
    expect(anchor()).toBeNull();
    const { scroller } = renderTimeline(nowCells);
    await nextFrame();
    expect(scroller.scrollLeft).toBe(calculateTodayScrollLeft(nowCells, CW, 600));
  });

  it('opens on today otherwise', async () => {
    const { scroller } = renderTimeline(nowCells);
    await nextFrame();
    // positioned on the next frame, centring today in the 600px viewport
    expect(scroller.scrollLeft).toBe(calculateTodayScrollLeft(nowCells, CW, 600));
    expect(scroller.scrollLeft).toBeGreaterThan(0);
  });
});

describe('Timeline triggers', () => {
  it('scrolls smoothly to a requested date and clears the trigger', async () => {
    const { scroller } = renderTimeline();
    await nextFrame();
    act(() => useUIStore.getState().triggerScrollToDate('2026-03-20'));
    expect(scroller.scrollTo).toHaveBeenCalledWith({
      left: Math.max(0, indexOf(marchCells, '2026-03-20') * CW - 150),
      behavior: 'smooth',
    });
    expect(useUIStore.getState().scrollToDateTrigger).toBeNull();
  });

  it('jumps instantly (and syncs) when an overview panel is open, clamping past the end', async () => {
    useViewStore.setState({ showStaffOverview: true });
    const { scroller } = renderTimeline();
    await nextFrame();
    act(() => useUIStore.getState().triggerScrollToDate('2099-01-01'));
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(scroller.scrollLeft).toBe((marchCells.length - 1) * CW - 150);
  });

  it('centres today on request', async () => {
    const { scroller } = renderTimeline(nowCells);
    await nextFrame();
    act(() => useUIStore.getState().triggerScrollToToday());
    const today = nowCells.findIndex((c) => c.isToday);
    expect(scroller.scrollTo).toHaveBeenCalledWith({
      left: Math.max(0, today * CW - 300 + CW / 2),
      behavior: 'smooth',
    });

    act(() => useViewStore.setState({ showEquipmentOverview: true }));
    act(() => useUIStore.getState().triggerScrollToToday());
    expect(scroller.scrollLeft).toBe(Math.max(0, today * CW - 300 + CW / 2));
  });

  it('centres the next working day when today is a hidden weekend day (Week/Month views)', async () => {
    // Saturday 17 October 2026 with weekends hidden: no cell is "today".
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 17, 10));
    try {
      const noWeekends = generateTimelineCells(new Date(), 'month', new Set(), [], new Set(), [], false);
      expect(noWeekends.some((c) => c.isToday)).toBe(false);
      const { scroller } = renderTimeline(noWeekends);
      await nextFrame();
      act(() => useUIStore.getState().triggerScrollToToday());
      const monday = indexOf(noWeekends, '2026-10-19');
      expect(monday).toBeGreaterThan(0);
      expect(scroller.scrollTo).toHaveBeenCalledWith({
        left: Math.max(0, monday * CW - 300 + CW / 2),
        behavior: 'smooth',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the centre date in view after a zoom', async () => {
    const { scroller } = renderTimeline();
    await nextFrame();
    scroller.scrollLeft = 900; // centre at 1200px -> cell 40
    act(() => useUIStore.getState().triggerZoom(1, 34));
    expect(useUIStore.getState().zoomTrigger).toBeNull();
    await nextFrame();
    expect(scroller.scrollLeft).toBe(40 * CW + CW / 2 - 300);
    expect(useViewStore.getState().timelineScrollLeft).toBe(scroller.scrollLeft);
  });
});

describe('Timeline scrolling and view modes', () => {
  it('saves the scroll offset and its left-edge date after a short pause', async () => {
    const { scroller } = renderTimeline();
    await nextFrame();
    const before = useViewStore.getState().timelineScrollLeft;
    scroller.scrollLeft = 210;
    fireEvent.scroll(scroller);
    expect(useViewStore.getState().timelineScrollLeft).toBe(before);
    expect(anchor()).toBeNull();
    await waitFor(() => expect(useViewStore.getState().timelineScrollLeft).toBe(210));
    expect(anchor()).toBe(marchCells[7].dateStr);
  });

  it('anchors nothing for a pane that is hidden or gone before the save', async () => {
    const hidden = renderTimeline();
    await nextFrame();
    Object.defineProperty(hidden.scroller, 'clientWidth', { configurable: true, value: 0 });
    hidden.scroller.scrollLeft = 210;
    fireEvent.scroll(hidden.scroller);
    await waitFor(() => expect(useViewStore.getState().timelineScrollLeft).toBe(210));
    expect(anchor()).toBeNull();
    hidden.unmount();

    const gone = renderTimeline();
    await nextFrame();
    gone.scroller.scrollLeft = 300;
    fireEvent.scroll(gone.scroller);
    gone.unmount(); // the pending save is dropped
    await new Promise((r) => setTimeout(r, 250));
    expect(anchor()).toBeNull();
  });

  it('moves the anchor with a navigation (same kind of cells, another range); a data reload keeps it', async () => {
    const { scroller, rerender } = renderTimeline();
    await nextFrame();
    scroller.scrollLeft = 10 * CW;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(anchor()).toBe(marchCells[10].dateStr));

    // Same dates regenerated (holidays reloaded): nothing moves.
    rerender('month', generateTimelineCells(new Date(2026, 2, 15), 'month', new Set(), []));
    expect(anchor()).toBe(marchCells[10].dateStr);

    // Next period: the window shifts under the same offset.
    const aprilCells = generateTimelineCells(new Date(2026, 3, 15), 'month', new Set(), []);
    rerender('month', aprilCells);
    expect(scroller.scrollLeft).toBe(10 * CW);
    expect(anchor()).toBe(aprilCells[10].dateStr);
    expect(aprilCells[10].dateStr).not.toBe(marchCells[10].dateStr);
  });

  it('keeps the left-edge date when the view mode changes', async () => {
    const { scroller, rerender } = renderTimeline();
    await nextFrame();
    const target = indexOf(marchCells, '2026-03-10');
    scroller.scrollLeft = target * CW;
    fireEvent.scroll(scroller);
    const leftDate = marchCells[target].dateStr;

    const weekCells = generateTimelineCells(new Date(2026, 2, 15), 'week', new Set(), []);
    rerender('week', weekCells);
    await nextFrame();
    expect(weekCells[scroller.scrollLeft / CW].dateStr).toBe(leftDate);
    expect(anchor()).toBe(leftDate);
  });

  it('keeps the left-edge date when weekends are hidden after the mount', async () => {
    const { scroller, rerender } = renderTimeline();
    await nextFrame();
    scroller.scrollLeft = indexOf(marchCells, '2026-03-10') * CW;
    fireEvent.scroll(scroller);
    rerender('month', weekdayMarchCells);
    await nextFrame();
    expect(weekdayMarchCells[scroller.scrollLeft / CW].dateStr).toBe('2026-03-10');
  });
});

// The Gantt once opened months ahead of today after a reload on instances that
// hide weekends: App renders the Gantt for one commit before the data load
// (no settings yet, so weekends shown), that throw-away mount stored a pixel
// offset measured on weekend-inclusive cells, and the real mount reused it on
// weekday-only cells — the same pixel, ~5/7 further in time. The timeline must
// open from today and the cells it has, and only ever restore a *date*.
describe('opens on today — regression guard, do not weaken', () => {
  const WIDTH = 600;
  // Wednesday 4 and Saturday 7 November 2026 (the Saturday is hidden with weekends off).
  const DAYS: Array<[string, Date, string]> = [
    ['a weekday', new Date(2026, 10, 4, 10), '2026-11-04'],
    ['a hidden Saturday', new Date(2026, 10, 7, 10), '2026-11-09'],
  ];
  const MODES: ViewMode[] = ['month', 'week'];
  const CASES = MODES.flatMap((mode) => DAYS.map(([label, now, centre]) => [mode, label, now, centre] as const));

  const cellsFor = (mode: ViewMode, showWeekends: boolean) =>
    generateTimelineCells(new Date(), mode, new Set(), [], new Set(), [], showWeekends);
  /** The date under the middle of the 600 px viewport. */
  const centreDate = (cells: TimelineCell[], scroller: HTMLDivElement, cw = CW) =>
    cells[Math.floor((scroller.scrollLeft + WIDTH / 2) / cw)].dateStr;

  function GanttLike() {
    // The same inputs as GanttContainer's cells: the instance setting decides
    // the weekend cells, the view store the rest.
    const showWeekends = useAppStore((s) => (s.instanceSettings?.show_weekends ?? 'true') !== 'false');
    const viewMode = useViewStore((s) => s.viewMode);
    const currentDate = useViewStore((s) => s.currentDate);
    const cellWidth = useViewStore((s) => s.cellWidth);
    const cells = useMemo(
      () => generateTimelineCells(currentDate, viewMode, new Set(), [], new Set(), [], showWeekends),
      [currentDate, viewMode, showWeekends]
    );
    return (
      <Timeline
        cells={cells}
        headers={generateTimelineHeaders(cells, viewMode)}
        projects={[]}
        cellWidth={cellWidth}
        viewMode={viewMode}
      />
    );
  }
  function renderGanttLike() {
    const utils = render(<GanttLike />);
    const scroller = utils.container.querySelector('[class*="horizontalScroll"]') as HTMLDivElement;
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: WIDTH });
    scroller.scrollTo = vi.fn() as unknown as typeof scroller.scrollTo;
    return { ...utils, scroller };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const at = (now: Date, mode: ViewMode) => {
    vi.setSystemTime(now);
    useViewStore.getState().setViewMode(mode);
    useViewStore.setState({ currentDate: new Date() });
  };

  it.each(CASES)(
    '%s view, %s: a throw-away mount on weekend cells does not move the next mount on weekday-only cells',
    async (mode, _label, now, centre) => {
      at(now, mode);
      const throwAway = renderTimeline(cellsFor(mode, true), mode);
      await nextFrame();
      throwAway.unmount();

      const weekdays = cellsFor(mode, false);
      const { scroller } = renderTimeline(weekdays, mode);
      await nextFrame();
      expect(scroller.scrollLeft).toBe(calculateTodayScrollLeft(weekdays, CW, WIDTH));
      expect(centreDate(weekdays, scroller)).toBe(centre);
    }
  );

  it.each(CASES)(
    '%s view, %s: the same when the throw-away frame lands after its unmount',
    async (mode, _label, now, centre) => {
      at(now, mode);
      renderTimeline(cellsFor(mode, true), mode).unmount();
      await nextFrame();

      const weekdays = cellsFor(mode, false);
      const { scroller } = renderTimeline(weekdays, mode);
      await nextFrame();
      expect(centreDate(weekdays, scroller)).toBe(centre);
    }
  );

  it.each(CASES)(
    '%s view, %s: App-like reload (no settings, then show_weekends=false) opens on today',
    async (mode, _label, now, centre) => {
      at(now, mode);
      // The commit before the data load: no instance settings yet.
      useAppStore.setState({ instanceSettings: null });
      const throwAway = renderGanttLike();
      await nextFrame();
      throwAway.unmount(); // the loading screen replaces the app

      act(() => useAppStore.setState({ instanceSettings: { show_weekends: 'false' } as never }));
      const { scroller } = renderGanttLike();
      await nextFrame();
      const weekdays = cellsFor(mode, false);
      expect(centreDate(weekdays, scroller, useViewStore.getState().cellWidth)).toBe(centre);
    }
  );

  it.each(CASES)(
    '%s view, %s: weekends hidden after the mount (settings arriving late) keep today in view',
    async (mode, _label, now, centre) => {
      at(now, mode);
      useAppStore.setState({ instanceSettings: null });
      const { scroller } = renderGanttLike();
      await nextFrame();
      const cw = useViewStore.getState().cellWidth;
      expect(centreDate(cellsFor(mode, true), scroller, cw)).toBe(formatDateISO(now));

      act(() => useAppStore.setState({ instanceSettings: { show_weekends: 'false' } as never }));
      await nextFrame();
      const weekdays = cellsFor(mode, false);
      const first = weekdays[Math.floor(scroller.scrollLeft / cw)].dateStr;
      const last = weekdays[Math.floor((scroller.scrollLeft + WIDTH - 1) / cw)].dateStr;
      expect(first <= centre && centre <= last).toBe(true);
    }
  );
});
