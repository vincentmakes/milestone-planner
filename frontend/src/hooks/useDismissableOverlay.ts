/**
 * useDismissableOverlay — the one dismiss behaviour for dropdowns, popovers
 * and menus (UI_GUIDELINES §3, "Dropdowns and popovers").
 *
 * While `open`, the overlay closes on:
 *   - a `mousedown` outside `wrapperRef` (trigger + panel);
 *   - Escape, caught in the capture phase and stopped there, so it wins over
 *     the app-wide shortcut handler and any enclosing dialog, and only this
 *     overlay closes; focus goes back to `triggerRef` when one is given;
 *   - focus leaving the wrapper (Tab out) — wire the returned `onBlur` to the
 *     wrapper. A null `relatedTarget` (focus dropped to the body by a
 *     mousedown on a label inside the panel) is left to the mousedown
 *     handler, or a click on an option's text would close the panel.
 *
 * Nothing is installed while closed, and the listeners are removed on close
 * and on unmount. `onClose` is read through a ref, so an inline arrow is fine.
 *
 * Modals are not overlays: the shared `Modal` never closes on an outside
 * click, by rule — do not use this hook for a dialog.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { FocusEvent, RefObject } from 'react';

interface UseDismissableOverlayOptions {
  open: boolean;
  onClose: () => void;
  /** Wraps the trigger and the panel; a mousedown inside it keeps the overlay open. */
  wrapperRef: RefObject<HTMLElement | null>;
  /** Receives focus again after Escape, so keyboard users land where they were. */
  triggerRef?: RefObject<HTMLElement | null>;
}

export function useDismissableOverlay({ open, onClose, wrapperRef, triggerRef }: UseDismissableOverlayOptions) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) onCloseRef.current();
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
  }, [open, wrapperRef, triggerRef]);

  const onBlur = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const next = e.relatedTarget as Node | null;
      if (open && next && !wrapperRef.current?.contains(next)) onCloseRef.current();
    },
    [open, wrapperRef]
  );

  return { onBlur };
}
