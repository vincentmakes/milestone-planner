import { useEffect, useRef } from 'react';

/**
 * Closes a dialog when the user presses Escape.
 *
 * Modals must only close via explicit buttons or the Escape key — never on
 * backdrop/outside clicks. The shared Modal component handles Escape itself;
 * this hook covers standalone dialogs (e.g. the admin-portal modals).
 */
export function useEscapeKey(onEscape: () => void, enabled = true) {
  // Keep the callback in a ref so the listener isn't re-attached on each render
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onEscapeRef.current();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);
}
