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

/** An ISO timestamp `minute` minutes into a fixed hour. */
const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 10, minute)).toISOString();

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

  it('an identical repeat changes nothing (the same notification can arrive twice)', () => {
    const store = useNotificationStore.getState();
    const first = notification(1);
    store.receive(first);
    store.receive(notification(2));
    const before = useNotificationStore.getState();

    useNotificationStore.getState().receive({ ...first });

    const state = useNotificationStore.getState();
    expect(state.items).toBe(before.items);
    expect(state.items.map((n) => n.id)).toEqual([2, 1]);
    expect(state.unreadCount).toBe(2);
  });

  it('a repeat cannot undo a local mark-read', () => {
    const first = notification(1);
    useNotificationStore.getState().receive(first);
    useNotificationStore.getState().markReadLocal(1);

    useNotificationStore.getState().receive({ ...first });

    const state = useNotificationStore.getState();
    expect(state.items[0].read_at).toBeTruthy();
    expect(state.unreadCount).toBe(0);
  });

  it('a newer copy replaces the stored row and moves it to the top', () => {
    const store = useNotificationStore.getState();
    store.setItems([
      notification(2, { created_at: at(5) }),
      notification(1, { created_at: at(1), title: 'Alice changed Trial' }),
    ]);
    store.setUnreadCount(2);

    useNotificationStore
      .getState()
      .receive(notification(1, { created_at: at(9), title: '2 changes by Alice on Trial', body: 'dates moved' }));

    const state = useNotificationStore.getState();
    expect(state.items.map((n) => n.id)).toEqual([1, 2]);
    expect(state.items[0]).toMatchObject({ title: '2 changes by Alice on Trial', body: 'dates moved' });
    expect(state.unreadCount).toBe(2);
  });

  it('ignores a copy older than the stored row (out-of-order pushes)', () => {
    const store = useNotificationStore.getState();
    store.setItems([notification(2), notification(1, { created_at: at(9), title: '2 changes' })]);
    store.setUnreadCount(2);

    useNotificationStore.getState().receive(notification(1, { created_at: at(1), title: 'First change' }));

    const state = useNotificationStore.getState();
    expect(state.items.map((n) => n.id)).toEqual([2, 1]);
    expect(state.items[1].title).toBe('2 changes');
    expect(state.unreadCount).toBe(2);
  });

  it.each([
    // Row 2 is unread throughout, so the badge starts at 2 (stored unread) or 1.
    ['unread over unread', null, null, 2],
    ['unread over read', at(2), null, 2],
    ['read over unread', null, at(9), 1],
    ['read over read', at(2), at(9), 1],
  ])('moves the badge by the unread difference: %s', (_label, storedRead, incomingRead, expected) => {
    const store = useNotificationStore.getState();
    store.setItems([notification(1, { created_at: at(1), read_at: storedRead }), notification(2)]);
    store.setUnreadCount(storedRead ? 1 : 2);

    useNotificationStore.getState().receive(notification(1, { created_at: at(9), read_at: incomingRead }));

    expect(useNotificationStore.getState().unreadCount).toBe(expected);
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

  it('removing an unread row drops it and decrements the badge; a read one leaves the badge', () => {
    const store = useNotificationStore.getState();
    store.setItems([notification(1), notification(2, { read_at: at(5) }), notification(3)]);
    store.setUnreadCount(2);

    useNotificationStore.getState().removeLocal(1);
    expect(useNotificationStore.getState().items.map((n) => n.id)).toEqual([2, 3]);
    expect(useNotificationStore.getState().unreadCount).toBe(1);

    useNotificationStore.getState().removeLocal(2);
    expect(useNotificationStore.getState().items.map((n) => n.id)).toEqual([3]);
    expect(useNotificationStore.getState().unreadCount).toBe(1);
  });

  it('removing an unknown id or a derived reminder changes nothing', () => {
    const store = useNotificationStore.getState();
    store.setItems([notification(-1, { source: 'derived' }), notification(2)]);
    store.setUnreadCount(1);
    const before = useNotificationStore.getState().items;

    useNotificationStore.getState().removeLocal(99);
    useNotificationStore.getState().removeLocal(-1);

    expect(useNotificationStore.getState().items).toBe(before);
    expect(useNotificationStore.getState().unreadCount).toBe(1);
  });

  it('clearing empties the inbox and zeroes the badge, keeping the panel open', () => {
    const store = useNotificationStore.getState();
    store.setItems([notification(1), notification(2)]);
    store.setUnreadCount(7);
    store.setPanelOpen(true);

    useNotificationStore.getState().clearLocal();

    expect(useNotificationStore.getState()).toMatchObject({ items: [], unreadCount: 0, panelOpen: true });
  });
});
