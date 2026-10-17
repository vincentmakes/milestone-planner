/**
 * Confirm Store
 * The queue of pending confirmation requests shown by the shared
 * ConfirmDialog (components/common/ConfirmDialog). Not persisted.
 *
 * Production code never touches this store directly: it calls
 * `confirmAction()` from `utils/confirmDialog.ts`, which enqueues here and
 * returns a promise that settles when the dialog answers. The dialog always
 * shows `queue[0]`, so two requests made at once are asked one after the
 * other.
 *
 * `reset()` answers every pending request with `false` (registered in
 * `resetAllStores()`), so a logout or an expired session never leaves a
 * caller waiting forever.
 */

import { create } from 'zustand';

export interface ConfirmOptions {
  /** The question. A blank line (`\n\n`) starts a new paragraph, `\n` a new line. */
  message: string;
  /** Dialog title; defaults to "Please confirm". */
  title?: string;
  /** Confirm button label; defaults to "Delete" when destructive, else "Confirm". */
  confirmLabel?: string;
  /** Cancel button label; defaults to "Cancel". */
  cancelLabel?: string;
  /** Renders the confirm button as a `danger` Button. */
  destructive?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

interface ConfirmState {
  queue: ConfirmRequest[];
  /** Queue a request; `resolve` is called exactly once, by settle() or reset(). */
  enqueue: (options: ConfirmOptions, resolve: (ok: boolean) => void) => number;
  /** Answer one request and drop it from the queue (unknown ids are ignored). */
  settle: (id: number, ok: boolean) => void;
  /** Answer every pending request with `false` and empty the queue. */
  reset: () => void;
}

let nextId = 1;

export const useConfirmStore = create<ConfirmState>()((set, get) => ({
  queue: [],

  enqueue: (options, resolve) => {
    const id = nextId++;
    set((state) => ({ queue: [...state.queue, { ...options, id, resolve }] }));
    return id;
  },

  settle: (id, ok) => {
    const request = get().queue.find((r) => r.id === id);
    if (!request) return;
    set((state) => ({ queue: state.queue.filter((r) => r.id !== id) }));
    request.resolve(ok);
  },

  reset: () => {
    const pending = get().queue;
    if (pending.length === 0) return;
    set({ queue: [] });
    pending.forEach((r) => r.resolve(false));
  },
}));
