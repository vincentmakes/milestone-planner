/**
 * Touch helpers for the Gantt bars and their drag/resize hooks.
 *
 * The bar → hook wiring (PhaseBar, ProjectBar, the assignment bars,
 * useDragAndDrop, useResize) is typed for `React.MouseEvent`. A touch is
 * therefore converted into a mouse-like event once, at the bar, and the
 * hooks' document listeners accept both `mouse*` and `touch*` events.
 *
 * `toMouseLikeEvent` builds its result as an explicit object rather than by
 * spreading the React event: React keeps `preventDefault`, `stopPropagation`
 * & co. on the SyntheticEvent prototype, which a spread drops — the handlers
 * would then throw on `e.stopPropagation()` (the bug fixed in #72).
 *
 * Scrolling is not suppressed from here: React registers `touchstart` and
 * `touchmove` passively on its root, so `preventDefault()` in an
 * `onTouchStart` is a no-op. The bars carry CSS `touch-action: none`, and the
 * document `touchmove` listeners are registered with {@link NON_PASSIVE}.
 */

import type React from 'react';

type AnyPointerEvent = MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent;

/** Options for a document `touchmove` listener that may call `preventDefault()`. */
export const NON_PASSIVE: AddEventListenerOptions = { passive: false };

/** True for a native or React touch event. */
export function isTouchEvent(e: AnyPointerEvent): e is TouchEvent | React.TouchEvent {
  return 'touches' in e;
}

/**
 * Viewport coordinates of a mouse or touch event: the first active touch,
 * else the first changed touch (a `touchend` has no active touches), else
 * the event's own `clientX`/`clientY`.
 */
export function getEventCoordinates(e: AnyPointerEvent): { clientX: number; clientY: number } {
  if ('touches' in e && e.touches.length > 0) {
    return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
  }
  if ('changedTouches' in e && e.changedTouches.length > 0) {
    return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
  }
  return { clientX: (e as MouseEvent).clientX, clientY: (e as MouseEvent).clientY };
}

/** Horizontal viewport coordinate of a mouse or touch event. */
export function getPointerClientX(e: AnyPointerEvent): number {
  return getEventCoordinates(e).clientX;
}

/**
 * A mouse-like event from a React touch event, so the drag/resize/click
 * handlers (typed for React.MouseEvent) work on touch screens. `target` and
 * `currentTarget` are those of the touch event at conversion time; the
 * event methods forward to the touch event.
 */
export function toMouseLikeEvent(
  e: React.TouchEvent,
  type: 'mousedown' | 'mouseup' = 'mousedown'
): React.MouseEvent {
  const touch = e.touches[0] || e.changedTouches[0];
  const synthetic = {
    type,
    target: e.target,
    currentTarget: e.currentTarget,
    nativeEvent: e.nativeEvent,
    bubbles: e.bubbles,
    cancelable: e.cancelable,
    timeStamp: e.timeStamp,
    clientX: touch.clientX,
    clientY: touch.clientY,
    screenX: touch.screenX,
    screenY: touch.screenY,
    pageX: touch.pageX,
    pageY: touch.pageY,
    movementX: 0,
    movementY: 0,
    altKey: e.altKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
    button: 0,
    buttons: 1,
    relatedTarget: null,
    getModifierState: (key: React.ModifierKey) => e.getModifierState(key),
    preventDefault: () => e.preventDefault(),
    stopPropagation: () => e.stopPropagation(),
    isDefaultPrevented: () => e.isDefaultPrevented(),
    isPropagationStopped: () => e.isPropagationStopped(),
    persist: () => {},
  };
  return synthetic as unknown as React.MouseEvent;
}
