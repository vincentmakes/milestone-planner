import { describe, it, expect, beforeEach } from 'vitest';
import { useNotificationStore } from '../notificationStore';
import type { AppNotification } from '@/types';

function notification(id: number, over: Partial<AppNotification> = {}): AppNotification {
  return {
    id,
    type: 'assigned',
    title: `Notification ${id}`,
    created_at: new Date().toISOString(),
    read_at: null,
    source: 'server',
    ...over,
  };
}

describe('notificationStore', () => {
  beforeEach(() => {
    useNotificationStore.getState().reset();
  });

  it('prepends a received notification and increments the badge', () => {
    const store = useNotificationStore.getState();
    store.setItems([notification(1)]);
    store.setUnreadCount(1);

    useNotificationStore.getState().receive(notification(2));

    const state = useNotificationStore.getState();
    expect(state.items.map((n) => n.id)).toEqual([2, 1]);
    expect(state.unreadCount).toBe(2);
  });

  it('ignores a duplicate push (the same notification can arrive twice)', () => {
    const store = useNotificationStore.getState();
    store.receive(notification(1));
    store.receive(notification(1));

    const state = useNotificationStore.getState();
    expect(state.items).toHaveLength(1);
    expect(state.unreadCount).toBe(1);
  });

  it('does not increment the badge for an already-read notification', () => {
    useNotificationStore
      .getState()
      .receive(notification(1, { read_at: new Date().toISOString() }));
    expect(useNotificationStore.getState().unreadCount).toBe(0);
  });

  it('marking read decrements the badge once', () => {
    const store = useNotificationStore.getState();
    store.setItems([notification(1)]);
    store.setUnreadCount(1);

    useNotificationStore.getState().markReadLocal(1);
    expect(useNotificationStore.getState().unreadCount).toBe(0);

    // Re-marking must not push the count negative.
    useNotificationStore.getState().markReadLocal(1);
    expect(useNotificationStore.getState().unreadCount).toBe(0);
  });

  it('the badge never goes negative', () => {
    const store = useNotificationStore.getState();
    store.setItems([notification(1)]);
    store.setUnreadCount(0);
    useNotificationStore.getState().markReadLocal(1);
    expect(useNotificationStore.getState().unreadCount).toBe(0);
  });

  it('mark all read zeroes the badge and stamps every item', () => {
    const store = useNotificationStore.getState();
    store.setItems([notification(1), notification(2), notification(3)]);
    store.setUnreadCount(3);

    useNotificationStore.getState().markAllReadLocal();

    const state = useNotificationStore.getState();
    expect(state.unreadCount).toBe(0);
    expect(state.items.every((n) => n.read_at)).toBe(true);
  });

  it('toggles the panel', () => {
    expect(useNotificationStore.getState().panelOpen).toBe(false);
    useNotificationStore.getState().togglePanel();
    expect(useNotificationStore.getState().panelOpen).toBe(true);
  });
});
