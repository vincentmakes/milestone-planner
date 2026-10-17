/**
 * useSubmitGuard - one write at a time per dialog.
 *
 * A form-wired dialog submits on Enter, so pressing Enter twice (or Enter
 * plus a click on a button that is about to become disabled) fires the
 * handler twice before React re-renders the disabled state. The guard keeps
 * the "in flight" flag in a ref, which is updated synchronously, and mirrors
 * it into `isSubmitting` for rendering.
 *
 *   const { isSubmitting, begin, end } = useSubmitGuard();
 *   const handleSubmit = async (e) => {
 *     e.preventDefault();
 *     if (!begin()) return;          // a write is already running
 *     try { await save(); } finally { end(); }
 *   };
 *
 * or, for a handler without validation before the write:
 *
 *   const handleDelete = () => guard(async () => { await remove(); });
 *
 * One guard per dialog: submit and delete share it, so a delete cannot start
 * while a save is still running.
 */

import { useCallback, useRef, useState } from 'react';

export interface SubmitGuard {
  /** True while a guarded write is in flight (for disabling buttons) */
  isSubmitting: boolean;
  /** Claim the guard; false when a write is already running */
  begin: () => boolean;
  /** Release the guard (call in `finally`) */
  end: () => void;
  /** Run `fn` under the guard; resolves to undefined when it was already busy */
  guard: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}

export function useSubmitGuard(): SubmitGuard {
  const inFlightRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const begin = useCallback(() => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setIsSubmitting(true);
    return true;
  }, []);

  const end = useCallback(() => {
    inFlightRef.current = false;
    setIsSubmitting(false);
  }, []);

  const guard = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      if (!begin()) return undefined;
      try {
        return await fn();
      } finally {
        end();
      }
    },
    [begin, end]
  );

  return { isSubmitting, begin, end, guard };
}
