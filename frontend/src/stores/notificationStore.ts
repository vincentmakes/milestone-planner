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
  /** A live push arrived over the WebSocket. */
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
      // The same notification can arrive twice (push plus a refetch).
      if (state.items.some((n) => n.id === notification.id)) return state;
      return {
        items: [notification, ...state.items],
        unreadCount: state.unreadCount + (notification.read_at ? 0 : 1),
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
