/**
 * useDismissableOverlay — the one dismiss behaviour for dropdowns, popovers
 * and menus (UI_GUIDELINES §3, "Dropdowns and popovers").
 *
 * While `open`, the overlay closes on:
 *   - a `mousedown` outside `wrapperRef` (trigger + panel) and outside
 *     `panelRef` (a panel portaled out of the wrapper, see AnchoredPanel);
 *   - Escape, caught in the capture phase and stopped there, so it wins over
 *     the app-wide shortcut handler and any enclosing dialog, and only this
 *     overlay closes; focus goes back to `triggerRef` when one is given;
 *   - focus leaving the wrapper and the panel (Tab out) — wire the returned
 *     `onBlur` to the wrapper (React bubbles a portaled panel's focus events
 *     through it). A null `relatedTarget` (focus dropped to the body by a
 *     mousedown on a label inside the panel) is left to the mousedown
 *     handler, or a click on an option's text would close the panel.
 *
 * Nothing is installed while closed, and the listeners are removed on close
 * and on unmount. `onClose` is read through a ref, so an inline arrow is fine.
 *
 * While an in-app confirmation (`confirmAction()`) is pending, nothing is
 * installed either: the confirm sits on top, Escape and the click on its
 * buttons belong to it, and the overlay that asked stays open underneath
 * until the answer (a cancelled delete leaves the popover where it was).
 *
 * Modals are not overlays: the shared `Modal` never closes on an outside
 * click, by rule — do not use this hook for a dialog.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { FocusEvent, RefObject } from 'react';
import { useConfirmStore } from '@/stores/confirmStore';

interface UseDismissableOverlayOptions {
  open: boolean;
  onClose: () => void;
  /** Wraps the trigger and the panel; a mousedown inside it keeps the overlay open. */
  wrapperRef: RefObject<HTMLElement | null>;
  /** Receives focus again after Escape, so keyboard users land where they were. */
  triggerRef?: RefObject<HTMLElement | null>;
  /**
   * The panel when it is rendered outside the wrapper in the DOM (portaled by
   * AnchoredPanel): a mousedown or a focus move inside it keeps the overlay open.
   */
  panelRef?: RefObject<HTMLElement | null>;
}

/** Whether `node` lies inside the wrapper or the (portaled) panel. */
function isInside(
  node: Node,
  wrapperRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null> | undefined
): boolean {
  return !!wrapperRef.current?.contains(node) || !!panelRef?.current?.contains(node);
}

export function useDismissableOverlay({ open, onClose, wrapperRef, triggerRef, panelRef }: UseDismissableOverlayOptions) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const confirmPending = useConfirmStore((s) => s.queue.length > 0);

  useEffect(() => {
    if (!open || confirmPending) return;

    const onPointerDown = (e: MouseEvent) => {
      if (!isInside(e.target as Node, wrapperRef, panelRef)) onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCloseRef.current();
      triggerRef?.current?.focus();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, confirmPending, wrapperRef, triggerRef, panelRef]);

  const onBlur = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const next = e.relatedTarget as Node | null;
      if (open && !confirmPending && next && !isInside(next, wrapperRef, panelRef)) onCloseRef.current();
    },
    [open, confirmPending, wrapperRef, panelRef]
  );

  return { onBlur };
}
