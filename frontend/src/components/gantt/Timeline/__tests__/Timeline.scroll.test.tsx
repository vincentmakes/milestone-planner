/**
 * Horizontal positioning of the Gantt timeline: restore the session's scroll
 * offset (or open on today), scroll-to-today / scroll-to-date triggers
 * (smooth alone, instant when an overview panel is synced), zoom re-centring,
 * keeping the left-edge date across view-mode switches, and the debounced
 * save of the scroll offset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent, waitFor } from '@testing-library/react';
import { Timeline } from '../Timeline';
import { generateTimelineCells, generateTimelineHeaders } from '../../utils';
import { calculateTodayScrollLeft } from '../../utils/timeline';
import { resetAllStores, useUIStore, useViewStore } from '@/stores';
import type { TimelineCell } from '../../utils';
import type { ViewMode } from '@/types';

vi.mock('../ProjectTimeline', () => ({ ProjectTimeline: () => null }));
vi.mock('../DependencyLayer', () => ({ DependencyLayer: () => null }));

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

describe('Timeline initial position', () => {
  it("restores this session's scroll offset", async () => {
    useViewStore.setState({ timelineScrollLeft: 450 });
    const { scroller } = renderTimeline();
    await nextFrame();
    expect(scroller.scrollLeft).toBe(450);
    expect(useViewStore.getState().timelineScrollLeft).toBe(450);
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
  it('saves the scroll offset after a short pause', async () => {
    const { scroller } = renderTimeline();
    await nextFrame();
    const before = useViewStore.getState().timelineScrollLeft;
    scroller.scrollLeft = 210;
    fireEvent.scroll(scroller);
    expect(useViewStore.getState().timelineScrollLeft).toBe(before);
    await waitFor(() => expect(useViewStore.getState().timelineScrollLeft).toBe(210));
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
  });
});
