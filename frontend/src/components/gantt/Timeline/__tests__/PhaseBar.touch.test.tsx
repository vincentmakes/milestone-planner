/**
 * Touch support: PhaseBar converts touch events into mouse-like events for
 * the click / drag / resize handlers. Those handlers call
 * `e.stopPropagation()` / `e.preventDefault()`, which React keeps on the
 * SyntheticEvent prototype — so the converted event must carry them
 * explicitly (spreading the React event dropped them and a tap threw).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
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
    expect(seen).toEqual({ defaultPrevented: true, propagationStopped: true });
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
    expect(seen).toEqual({ defaultPrevented: true, propagationStopped: true });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('passes a usable event to onResizeStart from a resize handle', () => {
    const onResizeStart = vi.fn((e: React.MouseEvent, edge: 'left' | 'right', element: HTMLElement) => {
      callEventMethods(e);
      return [edge, element];
    });
    const bar = renderBar({ onResizeStart });
    const [leftHandle, rightHandle] = Array.from(bar.querySelectorAll(':scope > div'));

    fireEvent.touchStart(leftHandle, touch(1, 5));
    fireEvent.touchStart(rightHandle, touch(119, 5));

    expect(onResizeStart).toHaveBeenCalledTimes(2);
    expect(onResizeStart.mock.calls[0][0]).toMatchObject({ clientX: 1, target: leftHandle });
    expect(onResizeStart.mock.calls[0][1]).toBe('left');
    expect(onResizeStart.mock.calls[1][1]).toBe('right');
    expect(onResizeStart.mock.calls[1][2]).toBe(bar);
    expect(onResizeStart.mock.results.every((r) => r.type === 'return')).toBe(true);
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
