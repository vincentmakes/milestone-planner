/**
 * Notification Store
 *
 * Deliberately NOT persisted: the server owns this data, and a stale cached
 * inbox is worse than an empty one. The WebSocket push is only a live hint --
 * the connection manager is per-process, so the bell also reloads on mount and
 * on window focus.
 *
 * Derived due-soon/overdue reminders are merged in by the bell itself (see
 * useDerivedDueNotifications); they never reach the server and are dismissed
 * into localStorage.
 */

import { create } from 'zustand';
import type { AppNotification } from '@/types';

interface NotificationState {
  items: AppNotification[];
  unreadCount: number;
  panelOpen: boolean;
  loading: boolean;

  setItems: (items: AppNotification[]) => void;
  setUnreadCount: (count: number) => void;
  setLoading: (loading: boolean) => void;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  /** A live push arrived over the WebSocket: insert it, or replace the stored row with that id. */
  receive: (notification: AppNotification) => void;
  markReadLocal: (id: number) => void;
  markAllReadLocal: () => void;
  reset: () => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  items: [],
  unreadCount: 0,
  panelOpen: false,
  loading: false,

  setItems: (items) => set({ items }),
  setUnreadCount: (count) => set({ unreadCount: Math.max(0, count) }),
  setLoading: (loading) => set({ loading }),
  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),

  receive: (notification) =>
    set((state) => {
      // An upsert by id: a change notification coalesced on the server comes
      // back with the same id, a new title and a later created_at. Pushes can
      // arrive out of order, so an older copy never replaces a newer one; a
      // repeat of the stored copy (push plus a refetch, same created_at)
      // changes nothing, so it cannot undo a local mark-read either.
      const existing = state.items.find((n) => n.id === notification.id);
      if (existing && Date.parse(existing.created_at) >= Date.parse(notification.created_at)) {
        return state;
      }
      const delta = (notification.read_at ? 0 : 1) - (existing && !existing.read_at ? 1 : 0);
      return {
        items: [notification, ...state.items.filter((n) => n.id !== notification.id)],
        unreadCount: Math.max(0, state.unreadCount + delta),
      };
    }),

  markReadLocal: (id) =>
    set((state) => {
      const target = state.items.find((n) => n.id === id);
      if (!target || target.read_at) return state;
      return {
        items: state.items.map((n) =>
          n.id === id ? { ...n, read_at: new Date().toISOString() } : n
        ),
        unreadCount: Math.max(0, state.unreadCount - 1),
      };
    }),

  markAllReadLocal: () =>
    set((state) => ({
      items: state.items.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() })),
      unreadCount: 0,
    })),

  reset: () => set({ items: [], unreadCount: 0, panelOpen: false, loading: false }),
}));
