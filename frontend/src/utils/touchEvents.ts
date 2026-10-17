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
 * Scrolling is not suppressed from here: React 18 registers `touchstart` and
 * `touchmove` passively on its root, so `preventDefault()` in an
 * `onTouchStart` is a no-op — and Chrome logs an "[Intervention] Unable to
 * preventDefault inside passive event listener" warning for every call. The
 * mouse-like event of a `touchstart` therefore does not forward
 * `preventDefault` at all (the drag/resize hooks call it on the event they
 * receive). Scroll suppression comes from CSS `touch-action: none` on the
 * interactive bars and from the document `touchmove` listeners, registered
 * with {@link NON_PASSIVE}.
 *
 * {@link armTouchGesture} keeps finger jitter during a tap from being
 * committed as a move: the drag/resize starts only once the finger has
 * travelled past a threshold, like PhaseBar's body drag.
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
 * event methods forward to the touch event — except `preventDefault` on a
 * `touchstart`, which React registers passively (see the header comment):
 * there it is a no-op, and `isDefaultPrevented` keeps reporting the touch
 * event's own (unprevented) state.
 */
export function toMouseLikeEvent(
  e: React.TouchEvent,
  type: 'mousedown' | 'mouseup' = 'mousedown'
): React.MouseEvent {
  const touch = e.touches[0] || e.changedTouches[0];
  const passive = e.type === 'touchstart';
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
    preventDefault: () => {
      if (!passive) e.preventDefault();
    },
    stopPropagation: () => e.stopPropagation(),
    isDefaultPrevented: () => e.isDefaultPrevented(),
    isPropagationStopped: () => e.isPropagationStopped(),
    persist: () => {},
  };
  return synthetic as unknown as React.MouseEvent;
}

/** Options for {@link armTouchGesture}. */
export interface TouchGestureOptions {
  /** Distance in px (Euclidean) the finger must travel before the gesture starts. */
  threshold?: number;
  /** Called once, with a mouse-like event at the START coordinate, when the threshold is passed. */
  onStart: (mouseLike: React.MouseEvent) => void;
}

/**
 * Arms a touch drag/resize on an interactive element: nothing happens until
 * the finger has moved more than `threshold` px from where it touched down.
 * Then the gesture's own document listeners are detached and `onStart` gets
 * a mouse-like event built at touchstart (start coordinates, original
 * target/currentTarget), so the drag/resize hook attaches its listeners and
 * measures from the start point — exactly like PhaseBar's body drag. A
 * touchend or touchcancel before the threshold just detaches: a tap does
 * nothing (the touchend is prevented so the browser does not synthesize a
 * mousedown that would start a mouse drag).
 *
 * Cancelable touchmoves are prevented while armed (the element is
 * interactive: the finger drags the bar, not the page).
 *
 * Returns a function that disarms the gesture early.
 */
export function armTouchGesture(
  e: React.TouchEvent,
  { threshold = 5, onStart }: TouchGestureOptions
): () => void {
  const { clientX: startX, clientY: startY } = getEventCoordinates(e);
  const mouseLike = toMouseLikeEvent(e);

  const detach = () => {
    document.removeEventListener('touchmove', handleMove, NON_PASSIVE);
    document.removeEventListener('touchend', handleEnd);
    document.removeEventListener('touchcancel', detach);
  };

  function handleMove(moveEvent: TouchEvent) {
    if (moveEvent.cancelable) moveEvent.preventDefault();
    const { clientX, clientY } = getEventCoordinates(moveEvent);
    if (Math.hypot(clientX - startX, clientY - startY) <= threshold) return;
    detach();
    onStart(mouseLike);
  }

  function handleEnd(endEvent: TouchEvent) {
    if (endEvent.cancelable) endEvent.preventDefault();
    detach();
  }

  document.addEventListener('touchmove', handleMove, NON_PASSIVE);
  document.addEventListener('touchend', handleEnd);
  document.addEventListener('touchcancel', detach);
  return detach;
}
