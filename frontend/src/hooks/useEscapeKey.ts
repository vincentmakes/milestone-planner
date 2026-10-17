import { useEffect, useRef } from 'react';
import { useConfirmStore } from '@/stores/confirmStore';

/**
 * Closes a dialog when the user presses Escape.
 *
 * Modals must only close via explicit buttons or the Escape key — never on
 * backdrop/outside clicks. The shared Modal component handles Escape itself;
 * this hook covers standalone dialogs (e.g. the admin-portal modals).
 *
 * While an in-app confirmation (`confirmAction()`) is open, Escape belongs to
 * it: the shared ConfirmDialog closes and this hook stays quiet, so a
 * cancelled confirmation never also closes the dialog that asked.
 */
export function useEscapeKey(onEscape: () => void, enabled = true) {
  // Keep the callback in a ref so the listener isn't re-attached on each render
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const confirmPending = useConfirmStore((s) => s.queue.length > 0);

  useEffect(() => {
    if (!enabled || confirmPending) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onEscapeRef.current();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enabled, confirmPending]);
}
