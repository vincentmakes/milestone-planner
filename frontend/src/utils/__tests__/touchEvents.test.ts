/**
 * Touch helpers shared by the Gantt bars and the drag/resize hooks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEvent, fireEvent } from '@testing-library/react';
import type React from 'react';
import {
  getEventCoordinates,
  getPointerClientX,
  isTouchEvent,
  toMouseLikeEvent,
  armTouchGesture,
  NON_PASSIVE,
} from '../touchEvents';

const point = (x: number, y: number) => ({ clientX: x, clientY: y, screenX: x + 100, screenY: y + 100, pageX: x + 1, pageY: y + 1 });

/** A minimal React.TouchEvent stand-in with spyable methods. */
function reactTouch(overrides: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  const currentTarget = document.createElement('div');
  const e = {
    type: 'touchstart',
    target,
    currentTarget,
    nativeEvent: new Event('touchstart'),
    bubbles: true,
    cancelable: true,
    timeStamp: 123,
    touches: [point(15, 8)],
    changedTouches: [point(15, 8)],
    altKey: true,
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    getModifierState: vi.fn((key: string) => key === 'Alt'),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    isDefaultPrevented: vi.fn(() => true),
    isPropagationStopped: vi.fn(() => false),
    ...overrides,
  };
  return e as unknown as React.TouchEvent & typeof e;
}

describe('getEventCoordinates', () => {
  it('reads the first active touch', () => {
    const e = { touches: [point(3, 4), point(9, 9)], changedTouches: [point(7, 7)] } as unknown as TouchEvent;
    expect(getEventCoordinates(e)).toEqual({ clientX: 3, clientY: 4 });
  });

  it('falls back to the changed touches when none is active (touchend)', () => {
    const e = { touches: [], changedTouches: [point(7, 6)] } as unknown as TouchEvent;
    expect(getEventCoordinates(e)).toEqual({ clientX: 7, clientY: 6 });
  });

  it('uses clientX/clientY of a mouse event', () => {
    expect(getEventCoordinates(new MouseEvent('mousemove', { clientX: 11, clientY: 12 }))).toEqual({ clientX: 11, clientY: 12 });
  });

  it('falls back to clientX/clientY when a touch event carries no touch at all', () => {
    const e = { touches: [], changedTouches: [], clientX: 5, clientY: 2 } as unknown as TouchEvent;
    expect(getEventCoordinates(e)).toEqual({ clientX: 5, clientY: 2 });
  });

  it('getPointerClientX returns the horizontal coordinate', () => {
    expect(getPointerClientX({ touches: [point(21, 1)] } as unknown as TouchEvent)).toBe(21);
    expect(getPointerClientX(new MouseEvent('mouseup', { clientX: 4 }))).toBe(4);
  });
});

describe('isTouchEvent', () => {
  it('tells touch from mouse events', () => {
    expect(isTouchEvent({ touches: [] } as unknown as TouchEvent)).toBe(true);
    expect(isTouchEvent(reactTouch())).toBe(true);
    expect(isTouchEvent(new MouseEvent('mousedown'))).toBe(false);
  });
});

describe('toMouseLikeEvent', () => {
  it('carries coordinates, modifiers, the primary button and the targets', () => {
    const e = reactTouch();
    const m = toMouseLikeEvent(e);

    expect(m).toMatchObject({
      type: 'mousedown',
      clientX: 15,
      clientY: 8,
      screenX: 115,
      screenY: 108,
      pageX: 16,
      pageY: 9,
      movementX: 0,
      movementY: 0,
      altKey: true,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
      button: 0,
      buttons: 1,
      relatedTarget: null,
      bubbles: true,
      cancelable: true,
      timeStamp: 123,
    });
    expect(m.target).toBe(e.target);
    expect(m.currentTarget).toBe(e.currentTarget);
    expect(m.nativeEvent).toBe(e.nativeEvent);
    expect(m.getModifierState('Alt')).toBe(true);
    expect(e.getModifierState).toHaveBeenCalledWith('Alt');
  });

  it('forwards the event methods to the touch event', () => {
    const e = reactTouch({ type: 'touchend' });
    const m = toMouseLikeEvent(e, 'mouseup');

    expect(m.type).toBe('mouseup');
    m.preventDefault();
    m.stopPropagation();
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
    expect(m.isDefaultPrevented()).toBe(true);
    expect(m.isPropagationStopped()).toBe(false);
    expect(() => m.persist()).not.toThrow();
  });

  it('does not forward preventDefault to the passive touchstart', () => {
    // React 18 registers touchstart passively: preventDefault there is a
    // no-op that Chrome warns about on every tap.
    const e = reactTouch({ isDefaultPrevented: vi.fn(() => false) });
    const m = toMouseLikeEvent(e);

    m.preventDefault();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(m.isDefaultPrevented()).toBe(false);
    m.stopPropagation();
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('uses the changed touch when no finger is down any more', () => {
    const m = toMouseLikeEvent(reactTouch({ touches: [], changedTouches: [point(30, 2)] }));
    expect(m.clientX).toBe(30);
    expect(m.clientY).toBe(2);
  });

  it('is a plain object, not a spread of the React event', () => {
    const m = toMouseLikeEvent(reactTouch());
    expect(typeof m.stopPropagation).toBe('function');
    expect(Object.keys(m)).not.toContain('touches');
  });
});

describe('NON_PASSIVE', () => {
  it('lets a touchmove listener call preventDefault', () => {
    expect(NON_PASSIVE).toEqual({ passive: false });
  });
});

describe('armTouchGesture', () => {
  const at = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });
  let disarm: (() => void) | null = null;

  afterEach(() => {
    disarm?.();
    disarm = null;
    vi.restoreAllMocks();
  });

  function arm(threshold?: number) {
    const onStart = vi.fn();
    disarm = armTouchGesture(reactTouch({ touches: [point(20, 30)] }), { threshold, onStart });
    return onStart;
  }

  const listenerTypes = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c[0]);

  it('does nothing on a tap that stays below the threshold, then detaches', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const onStart = arm();

    fireEvent.touchMove(document, at(23, 33)); // ~4.2 px: jitter
    const end = createEvent.touchEnd(document, { changedTouches: [{ clientX: 23, clientY: 33 }] });
    fireEvent(document, end);

    expect(onStart).not.toHaveBeenCalled();
    // The tap must not become a synthesized mousedown (a mouse drag)
    expect(end.defaultPrevented).toBe(true);
    expect(listenerTypes(remove)).toEqual(expect.arrayContaining(['touchmove', 'touchend', 'touchcancel']));

    // Detached: a later long move starts nothing
    fireEvent.touchMove(document, at(200, 30));
    expect(onStart).not.toHaveBeenCalled();
  });

  it('starts once, at the start coordinates, past the threshold', () => {
    const onStart = arm();

    fireEvent.touchMove(document, at(24, 34)); // ~5.7 px (Euclidean) > 5
    fireEvent.touchMove(document, at(80, 34));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0][0]).toMatchObject({ type: 'mousedown', clientX: 20, clientY: 30, button: 0 });
  });

  it('honours a custom threshold', () => {
    const onStart = arm(20);
    fireEvent.touchMove(document, at(35, 30));
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.touchMove(document, at(41, 30));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('keeps the page from scrolling while armed', () => {
    arm();
    const move = createEvent.touchMove(document, at(21, 30));
    fireEvent(document, move);
    expect(move.defaultPrevented).toBe(true);
  });

  it('forgets the gesture on touchcancel', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const onStart = arm();

    fireEvent.touchCancel(document);
    fireEvent.touchMove(document, at(200, 30));

    expect(onStart).not.toHaveBeenCalled();
    expect(listenerTypes(remove)).toEqual(expect.arrayContaining(['touchmove', 'touchend', 'touchcancel']));
  });

  it('registers its touchmove listener non-passively', () => {
    const add = vi.spyOn(document, 'addEventListener');
    arm();
    expect(add).toHaveBeenCalledWith('touchmove', expect.any(Function), NON_PASSIVE);
  });
});
