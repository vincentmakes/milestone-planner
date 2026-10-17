/**
 * Horizontal scroll sync between timelines (Gantt + staff/equipment
 * overviews): a scroll in one container is mirrored into the others, the
 * source lock prevents feedback loops for 100 ms, and newly mounted
 * containers pick up the current position.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import {
  TimelineScrollProvider,
  useTimelineScrollSync,
  useTimelineScrollValue,
} from '../TimelineScrollContext';

let api: { syncPosition?: (left: number) => void } = {};

function Pane({ id, enabled = true }: { id: string; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { handleScroll, syncScrollPosition } = useTimelineScrollSync(id, ref, enabled);
  if (id === 'gantt') api.syncPosition = syncScrollPosition;
  return <div data-testid={id} ref={ref} onScroll={handleScroll} />;
}

function Probe() {
  const { syncScroll, getScrollLeft } = useTimelineScrollValue();
  return (
    <output data-testid="probe">
      {syncScroll ? 'in-provider' : 'no-provider'}:{getScrollLeft()}
    </output>
  );
}

function scroll(id: string, left: number) {
  const el = screen.getByTestId(id);
  el.scrollLeft = left;
  fireEvent.scroll(el);
}

const flushFrames = () =>
  act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });

beforeEach(() => {
  api = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TimelineScrollProvider', () => {
  it('mirrors a scroll from one container into the others', async () => {
    render(
      <TimelineScrollProvider>
        <Pane id="gantt" />
        <Pane id="staff" />
        <Pane id="disabled" enabled={false} />
      </TimelineScrollProvider>
    );
    await flushFrames();
    scroll('gantt', 240);
    expect(screen.getByTestId('staff').scrollLeft).toBe(240);
    expect(screen.getByTestId('disabled').scrollLeft).toBe(0);
  });

  it('ignores echoes from other containers until the source settles', async () => {
    render(
      <TimelineScrollProvider>
        <Pane id="gantt" />
        <Pane id="staff" />
      </TimelineScrollProvider>
    );
    await flushFrames();
    vi.useFakeTimers();
    scroll('gantt', 100);
    // The mirrored scroll event from "staff" must not bounce back.
    scroll('staff', 50);
    expect(screen.getByTestId('gantt').scrollLeft).toBe(100);

    act(() => {
      vi.advanceTimersByTime(150);
    });
    scroll('staff', 300);
    expect(screen.getByTestId('gantt').scrollLeft).toBe(300);
  });

  it('syncScrollPosition pushes a programmatic position to the other panes', async () => {
    render(
      <TimelineScrollProvider>
        <Pane id="gantt" />
        <Pane id="staff" />
      </TimelineScrollProvider>
    );
    await flushFrames();
    act(() => api.syncPosition?.(420));
    expect(screen.getByTestId('staff').scrollLeft).toBe(420);
  });

  it('brings a newly mounted pane to the current position', async () => {
    const { rerender } = render(
      <TimelineScrollProvider>
        <Pane id="gantt" />
        <Probe />
      </TimelineScrollProvider>
    );
    await flushFrames();
    scroll('gantt', 180);
    rerender(
      <TimelineScrollProvider>
        <Pane id="gantt" />
        <Pane id="equipment" />
        <Probe />
      </TimelineScrollProvider>
    );
    await flushFrames();
    expect(screen.getByTestId('equipment').scrollLeft).toBe(180);
    expect(screen.getByTestId('probe').textContent).toBe('in-provider:180');
  });

  it('is inert outside a provider', () => {
    render(
      <>
        <Pane id="gantt" />
        <Probe />
      </>
    );
    scroll('gantt', 90);
    act(() => api.syncPosition?.(10));
    expect(screen.getByTestId('probe').textContent).toBe('no-provider:0');
  });
});
