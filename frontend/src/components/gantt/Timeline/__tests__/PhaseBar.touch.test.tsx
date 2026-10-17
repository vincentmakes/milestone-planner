/**
 * Touch support: PhaseBar converts touch events into mouse-like events for
 * the click / drag / resize handlers. Those handlers call
 * `e.stopPropagation()` / `e.preventDefault()`, which React keeps on the
 * SyntheticEvent prototype — so the converted event must carry them
 * explicitly (spreading the React event dropped them and a tap threw).
 *
 * React 18 registers touchstart passively, so nothing calls preventDefault on
 * it (a no-op Chrome warns about): the converted event of a tap reports
 * isDefaultPrevented() === false even after the consumer called it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, createEvent } from '@testing-library/react';
import type React from 'react';
import { PhaseBar } from '../PhaseBar';

type Handler = (e: React.MouseEvent) => void;

function renderBar(props: Partial<React.ComponentProps<typeof PhaseBar>> = {}) {
  const { container } = render(
    <PhaseBar left={0} width={120} color="#3b82f6" name="Design" phaseId={1} projectId={1} {...props} />
  );
  return container.firstChild as HTMLElement;
}

/** Calls the event methods the real consumers call; throws if any is missing. */
function callEventMethods(e: React.MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
  e.persist();
  return {
    defaultPrevented: e.isDefaultPrevented(),
    propagationStopped: e.isPropagationStopped(),
  };
}

const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y, screenX: x, screenY: y, pageX: x, pageY: y }] });

afterEach(() => {
  // Release any document listeners a test left attached
  fireEvent.touchEnd(document);
});

describe('PhaseBar touch events', () => {
  it('turns a tap into onClick with a working stopPropagation', () => {
    let seen: ReturnType<typeof callEventMethods> | null = null;
    let event: React.MouseEvent | null = null;
    const onClick = vi.fn<Handler>((e) => {
      event = e;
      seen = callEventMethods(e);
    });
    const bar = renderBar({ onClick });

    fireEvent.touchStart(bar, touch(15, 8));
    fireEvent.touchEnd(document);

    expect(onClick).toHaveBeenCalledTimes(1);
    // Neither PhaseBar nor the consumer's preventDefault reached the passive touchstart
    expect(seen).toEqual({ defaultPrevented: false, propagationStopped: true });
    expect(event!).toMatchObject({ type: 'mousedown', clientX: 15, clientY: 8, button: 0, target: bar });
    expect(event!.currentTarget).toBe(bar);
    expect(event!.shiftKey).toBe(false);
  });

  it('starts a drag once the finger moves past the threshold', () => {
    let seen: ReturnType<typeof callEventMethods> | null = null;
    const onDragStart = vi.fn((e: React.MouseEvent, _element: HTMLElement) => {
      seen = callEventMethods(e);
    });
    const onClick = vi.fn();
    const bar = renderBar({ onDragStart, onClick });

    fireEvent.touchStart(bar, touch(10, 10));
    fireEvent.touchMove(document, touch(40, 10));
    fireEvent.touchEnd(document);

    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragStart.mock.calls[0][0]).toMatchObject({ clientX: 10, clientY: 10 });
    expect(onDragStart.mock.calls[0][1]).toBe(bar);
    expect(seen).toEqual({ defaultPrevented: false, propagationStopped: true });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('passes a usable event to onResizeStart once a handle is dragged past the threshold', () => {
    const onResizeStart = vi.fn((e: React.MouseEvent, edge: 'left' | 'right', element: HTMLElement) => {
      callEventMethods(e);
      return [edge, element];
    });
    const bar = renderBar({ onResizeStart });
    const [leftHandle, rightHandle] = Array.from(bar.querySelectorAll(':scope > div'));

    fireEvent.touchStart(leftHandle, touch(1, 5));
    expect(onResizeStart).not.toHaveBeenCalled();
    fireEvent.touchMove(document, touch(20, 5));
    fireEvent.touchEnd(document);
    fireEvent.touchStart(rightHandle, touch(119, 5));
    fireEvent.touchMove(document, touch(100, 5));
    fireEvent.touchEnd(document);

    expect(onResizeStart).toHaveBeenCalledTimes(2);
    // Measured from where the finger touched down
    expect(onResizeStart.mock.calls[0][0]).toMatchObject({ clientX: 1, target: leftHandle });
    expect(onResizeStart.mock.calls[0][1]).toBe('left');
    expect(onResizeStart.mock.calls[0][2]).toBe(bar);
    expect(onResizeStart.mock.calls[1][0]).toMatchObject({ clientX: 119, target: rightHandle });
    expect(onResizeStart.mock.calls[1][1]).toBe('right');
    expect(onResizeStart.mock.calls[1][2]).toBe(bar);
    expect(onResizeStart.mock.results.every((r) => r.type === 'return')).toBe(true);
  });

  it('a jittery tap on a resize handle resizes nothing, nor clicks or drags the bar', () => {
    const onResizeStart = vi.fn();
    const onDragStart = vi.fn();
    const onClick = vi.fn();
    const bar = renderBar({ onResizeStart, onDragStart, onClick });
    const rightHandle = bar.querySelectorAll(':scope > div')[1];

    fireEvent.touchStart(rightHandle, touch(119, 5));
    fireEvent.touchMove(document, touch(116, 7));
    fireEvent.touchEnd(document);
    fireEvent.touchMove(document, touch(60, 7));

    expect(onResizeStart).not.toHaveBeenCalled();
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('starts a mouse resize on mousedown at once', () => {
    const onResizeStart = vi.fn();
    const bar = renderBar({ onResizeStart });
    const leftHandle = bar.querySelectorAll(':scope > div')[0];

    const down = createEvent.mouseDown(leftHandle, { clientX: 2, clientY: 5 });
    fireEvent(leftHandle, down);

    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onResizeStart.mock.calls[0][1]).toBe('left');
    expect(onResizeStart.mock.calls[0][2]).toBe(bar);
    expect(down.defaultPrevented).toBe(true);
  });

  it('neither clicks nor drags on a cancelled touch', () => {
    const onClick = vi.fn<Handler>();
    const onDragStart = vi.fn();
    const remove = vi.spyOn(document, 'removeEventListener');
    const bar = renderBar({ onClick, onDragStart });

    fireEvent.touchStart(bar, touch(10, 10));
    fireEvent.touchCancel(document);
    // The gesture is gone: later events do nothing
    fireEvent.touchMove(document, touch(60, 10));
    fireEvent.touchEnd(document);

    expect(onClick).not.toHaveBeenCalled();
    expect(onDragStart).not.toHaveBeenCalled();
    expect(remove.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['mousemove', 'mouseup', 'touchmove', 'touchend', 'touchcancel'])
    );
    remove.mockRestore();
  });

  it('prevents the synthesized mouse events after a tap so onClick fires once', () => {
    const onClick = vi.fn<Handler>();
    const bar = renderBar({ onClick });

    fireEvent.touchStart(bar, touch(10, 10));
    const end = createEvent.touchEnd(document, { changedTouches: [{ clientX: 10, clientY: 10 }] });
    fireEvent(document, end);

    expect(end.defaultPrevented).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the page from scrolling while a finger drags the bar', () => {
    const bar = renderBar({ onDragStart: vi.fn() });

    fireEvent.touchStart(bar, touch(10, 10));
    const move = createEvent.touchMove(document, touch(12, 10));
    fireEvent(document, move);

    expect(move.defaultPrevented).toBe(true);
    expect(bar.className).toMatch(/interactive/);
  });

  it('keeps the page from scrolling on a resize-only bar', () => {
    const bar = renderBar({ onResizeStart: vi.fn() });

    fireEvent.touchStart(bar, touch(50, 10));
    const move = createEvent.touchMove(document, touch(52, 10));
    fireEvent(document, move);

    expect(move.defaultPrevented).toBe(true);
  });

  it('lets a swipe on a read-only bar scroll the timeline', () => {
    const onClick = vi.fn();
    const bar = renderBar({ onClick });

    fireEvent.touchStart(bar, touch(10, 10));
    const move = createEvent.touchMove(document, touch(12, 10));
    fireEvent(document, move);
    const far = createEvent.touchMove(document, touch(60, 10));
    fireEvent(document, far);
    fireEvent.touchEnd(document);

    expect(move.defaultPrevented).toBe(false);
    expect(far.defaultPrevented).toBe(false);
    // A swipe is not a tap
    expect(onClick).not.toHaveBeenCalled();
    expect(bar.className).not.toMatch(/interactive/);
  });

  it('drags a milestone by touch, and leaves a read-only bar scrollable', () => {
    const onDragStart = vi.fn();
    const milestone = renderBar({ isMilestone: true, onDragStart });
    expect(milestone.className).toMatch(/interactive/);

    fireEvent.touchStart(milestone, touch(10, 10));
    fireEvent.touchMove(document, touch(40, 10));
    fireEvent.touchEnd(document);
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragStart.mock.calls[0][1]).toBe(milestone);

    expect(renderBar({ phaseId: 2 }).className).not.toMatch(/interactive/);
  });

  it('keeps the modifier keys of the touch event', () => {
    const onClick = vi.fn<Handler>();
    const bar = renderBar({ onClick });

    fireEvent.touchStart(bar, { ...touch(5, 5), shiftKey: true, ctrlKey: true });
    fireEvent.touchEnd(document);

    expect(onClick.mock.calls[0][0]).toMatchObject({ shiftKey: true, ctrlKey: true, altKey: false, metaKey: false });
    expect(onClick.mock.calls[0][0].getModifierState('Shift')).toBe(true);
  });
});
