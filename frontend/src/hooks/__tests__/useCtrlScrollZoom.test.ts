/**
 * useCtrlScrollZoom: Ctrl+wheel zoom of the timeline cell width, anchored on
 * the date under the cursor, clamped to the zoom limits.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCtrlScrollZoom } from '../useCtrlScrollZoom';
import { resetAllStores, useViewStore } from '@/stores';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

beforeEach(() => {
  resetAllStores();
});

describe('useCtrlScrollZoom', () => {
  function container() {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ left: 100 }) as DOMRect;
    el.scrollLeft = 300;
    return el;
  }
  const wheel = (el: HTMLElement, init: WheelEventInit) => {
    const event = new WheelEvent('wheel', { cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
  };

  it('zooms in on Ctrl+wheel-up and keeps the date under the cursor', async () => {
    useViewStore.setState({ cellWidth: 40 });
    const el = container();
    const { result } = renderHook(() => useCtrlScrollZoom({ containerRef: { current: el }, cellWidth: 40 }));
    expect(result.current).toEqual({ minCellWidth: 12, maxCellWidth: 120, zoomStep: 4 });

    const event = wheel(el, { ctrlKey: true, deltaY: -100, clientX: 200 });
    expect(event.defaultPrevented).toBe(true);
    expect(useViewStore.getState().cellWidth).toBe(44);
    // cursor 100px in + 300 scrolled = cell 10 -> 10 * 44 - 100
    await waitFor(() => expect(el.scrollLeft).toBe(340));
  });

  it('zooms out, and stops at the limits', async () => {
    const el = container();
    const { rerender } = renderHook(({ cw }) => useCtrlScrollZoom({ containerRef: { current: el }, cellWidth: cw }), {
      initialProps: { cw: 40 },
    });
    wheel(el, { ctrlKey: true, deltaY: 100, clientX: 200 });
    expect(useViewStore.getState().cellWidth).toBe(36);
    await nextFrame();

    act(() => useViewStore.setState({ cellWidth: 12 }));
    rerender({ cw: 12 });
    wheel(el, { ctrlKey: true, deltaY: 100, clientX: 200 });
    expect(useViewStore.getState().cellWidth).toBe(12);

    rerender({ cw: 120 });
    act(() => useViewStore.setState({ cellWidth: 120 }));
    wheel(el, { ctrlKey: true, deltaY: -100, clientX: 200 });
    expect(useViewStore.getState().cellWidth).toBe(120);
  });

  it('ignores plain wheel scrolling and rapid repeats, and can be disabled', async () => {
    useViewStore.setState({ cellWidth: 40 });
    const el = container();
    const { unmount } = renderHook(() => useCtrlScrollZoom({ containerRef: { current: el }, cellWidth: 40 }));
    const plain = wheel(el, { deltaY: -100 });
    expect(plain.defaultPrevented).toBe(false);
    expect(useViewStore.getState().cellWidth).toBe(40);

    wheel(el, { ctrlKey: true, deltaY: -100, clientX: 200 });
    act(() => useViewStore.setState({ cellWidth: 40 }));
    wheel(el, { ctrlKey: true, deltaY: -100, clientX: 200 }); // same frame: ignored
    expect(useViewStore.getState().cellWidth).toBe(40);
    unmount();
    await nextFrame();

    const disabled = container();
    renderHook(() => useCtrlScrollZoom({ containerRef: { current: disabled }, cellWidth: 40, enabled: false }));
    expect(wheel(disabled, { ctrlKey: true, deltaY: -100 }).defaultPrevented).toBe(false);
  });
});
