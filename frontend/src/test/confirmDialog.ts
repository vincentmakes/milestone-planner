/**
 * Test helpers for `confirmAction()` (utils/confirmDialog.ts).
 *
 *   const confirm = stubConfirm(false);   // every confirmAction() resolves false
 *   ...
 *   expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Delete?' }));
 *
 * `src/test/setup.ts` calls `restoreConfirm()` after every test, so a stub
 * never leaks into the next one.
 */
import { vi } from 'vitest';
import { setConfirmHandler } from '@/utils/confirmDialog';
import type { ConfirmHandler, ConfirmOptions } from '@/utils/confirmDialog';

/** Answer every confirmAction() with `result` (or `result(options)`) and record the calls. */
export function stubConfirm(result: boolean | ((options: ConfirmOptions) => boolean) = true) {
  const spy = vi.fn<ConfirmHandler>(async (options) =>
    typeof result === 'function' ? result(options) : result
  );
  setConfirmHandler(spy);
  return spy;
}

/** Put the store-backed handler (the real ConfirmDialog) back. */
export function restoreConfirm(): void {
  setConfirmHandler(null);
}
