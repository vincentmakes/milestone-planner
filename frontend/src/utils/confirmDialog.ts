/**
 * In-app confirmation dialog.
 *
 * Production code always asks through `confirmAction()` and never calls
 * `window.confirm`: the native prompt blocks the page, ignores the theme and
 * cannot be styled as destructive. `confirmAction()` resolves `true` when the
 * user confirms and `false` on Cancel, the close button, Escape, or when the
 * session ends (`resetAllStores()` settles every pending request `false`).
 *
 *   if (!(await confirmAction({ message: `Delete "${name}"?`, destructive: true }))) return;
 *
 * The default handler queues the request in `confirmStore`, which the shared
 * `ConfirmDialog` (mounted once in `App`) renders. Tests swap the handler
 * with `stubConfirm()` from `src/test/confirmDialog.ts`.
 */

import { useConfirmStore } from '@/stores/confirmStore';
import type { ConfirmOptions } from '@/stores/confirmStore';

export type { ConfirmOptions } from '@/stores/confirmStore';

export type ConfirmHandler = (options: ConfirmOptions) => Promise<boolean>;

const storeHandler: ConfirmHandler = (options) =>
  new Promise<boolean>((resolve) => {
    useConfirmStore.getState().enqueue(options, resolve);
  });

let handler: ConfirmHandler = storeHandler;

/** Ask the user to confirm. A bare string is shorthand for `{ message }`. */
export function confirmAction(options: ConfirmOptions | string): Promise<boolean> {
  return handler(typeof options === 'string' ? { message: options } : options);
}

/** Replace the handler (tests); `null` restores the store-backed default. */
export function setConfirmHandler(next: ConfirmHandler | null): void {
  handler = next ?? storeHandler;
}
