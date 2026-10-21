/**
 * Notification bell: loads the inbox on mount and on window focus, merges
 * browser-derived due reminders, opens the card on click (marking a server
 * notification read, dismissing a derived one locally), mark-all, and closes
 * on outside click (a popover, not a modal).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotificationBell } from '../NotificationBell';
import {
  getNotifications,
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/api/endpoints/notifications';
import { dismissDerivedNotification, useDerivedDueNotifications } from '@/hooks/useDerivedDueNotifications';
import { useAppStore } from '@/stores/appStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { resetAllStores } from '@/stores';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { makeUser } from '@/test/factories';
import type { AppNotification } from '@/types';

vi.mock('@/api/endpoints/notifications', () => ({
  getNotifications: vi.fn(),
  getUnreadCount: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));
vi.mock('@/hooks/useDerivedDueNotifications', () => ({
  useDerivedDueNotifications: vi.fn(() => []),
  dismissDerivedNotification: vi.fn(),
}));

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function note(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 1,
    type: 'comment',
    entity_type: 'phase',
    entity_id: 10,
    project_id: 1,
    title: 'Bob commented on Feasibility',
    body: 'Looks good',
    read_at: null,
    created_at: minutesAgo(5),
    source: 'server',
    ...overrides,
  };
}

const bell = () => screen.getByRole('button', { name: /^Notifications/ });

async function renderBell() {
  const view = render(<NotificationBell />);
  await waitFor(() => expect(getUnreadCount).toHaveBeenCalled());
  await act(async () => {});
  return view;
}

beforeEach(() => {
  resetAllStores();
  useViewStore.getState().resetView();
  useAppStore.setState({ currentUser: makeUser({ id: 4 }) });
  vi.mocked(getNotifications).mockReset().mockResolvedValue([]);
  vi.mocked(getUnreadCount).mockReset().mockResolvedValue(0);
  vi.mocked(markNotificationRead).mockReset().mockResolvedValue({ success: true });
  vi.mocked(markAllNotificationsRead).mockReset().mockResolvedValue({ success: true });
  vi.mocked(useDerivedDueNotifications).mockReset().mockReturnValue([]);
  vi.mocked(dismissDerivedNotification).mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
});

describe('NotificationBell', () => {
  it('renders nothing when signed out', () => {
    useAppStore.setState({ currentUser: null });
    const view = render(<NotificationBell />);
    expect(view.container).toBeEmptyDOMElement();
    expect(getNotifications).not.toHaveBeenCalled();
  });

  it('loads the inbox and shows the unread badge; refreshes on focus', async () => {
    vi.mocked(getNotifications).mockResolvedValue([note()]);
    vi.mocked(getUnreadCount).mockResolvedValue(3);
    await renderBell();
    expect(bell()).toHaveAccessibleName('Notifications (3 unread)');
    expect(bell()).toHaveTextContent('3');
    expect(useNotificationStore.getState().items).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(getNotifications).toHaveBeenCalledTimes(2);
  });

  it('caps the badge at 99+ and counts derived reminders', async () => {
    vi.mocked(getUnreadCount).mockResolvedValue(99);
    vi.mocked(useDerivedDueNotifications).mockReturnValue([
      note({ id: -1, type: 'due_soon', source: 'derived', title: 'Due soon' }),
    ]);
    await renderBell();
    expect(bell()).toHaveAccessibleName('Notifications (100 unread)');
    expect(bell()).toHaveTextContent('99+');
  });

  it('logs a failed refresh', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getNotifications).mockRejectedValue(new Error('500'));
    await renderBell();
    expect(error).toHaveBeenCalledWith('[Notifications] Failed to refresh:', expect.any(Error));
    expect(bell()).toHaveAccessibleName('Notifications');
  });

  it('owns its panel (aria-controls) and closes it on Escape with focus back on the bell', async () => {
    render(<NotificationBell />);
    await screen.findByRole('button', { name: /^Notifications/ });
    expect(bell()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(bell()).not.toHaveAttribute('aria-controls');

    fireEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(bell()).toHaveAttribute('aria-controls', panel.id);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(bell()).toHaveFocus();
  });

  it('lists notifications with relative times and an empty state', async () => {
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 1, created_at: new Date().toISOString(), body: null }),
      note({ id: 2, type: 'assigned', title: 'Assigned', created_at: minutesAgo(90), read_at: minutesAgo(1) }),
      note({ id: 3, type: 'mention', title: 'Mentioned', created_at: minutesAgo(60 * 50) }),
      note({ id: 4, type: 'status_change', title: 'Bad date', created_at: 'not a date' }),
    ]);
    await renderBell();
    fireEvent.click(bell());
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(panel).toHaveTextContent('just now');
    expect(panel).toHaveTextContent('2h ago');
    expect(panel).toHaveTextContent('2d ago');
    expect(screen.getByRole('button', { name: /Bob commented/ })).toHaveTextContent('Bob commented on Feasibility');

    vi.mocked(getNotifications).mockResolvedValue([]);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByText('Nothing new')).toBeInTheDocument();
  });

  it('opens the card on the Kanban board and marks the notification read', async () => {
    vi.mocked(getNotifications).mockResolvedValue([note()]);
    vi.mocked(getUnreadCount).mockResolvedValue(1);
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Bob commented/ }));
    });
    expect(useViewStore.getState()).toMatchObject({ currentView: 'kanban', kanbanProjectId: 1 });
    expect(useUIStore.getState().activeModal).toBe('kanbanCard');
    expect(useNotificationStore.getState().panelOpen).toBe(false);
    expect(markNotificationRead).toHaveBeenCalledWith(1);
    expect(useNotificationStore.getState().items[0].read_at).toBeTruthy();
  });

  it('marks a card notification read without opening the board when views.kanban is missing', async () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'viewer', permissions: ['projects.view'] }) });
    vi.mocked(getNotifications).mockResolvedValue([note()]);
    vi.mocked(getUnreadCount).mockResolvedValue(1);
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Bob commented/ }));
    });
    expect(useViewStore.getState().currentView).toBe('gantt');
    expect(useUIStore.getState().activeModal).not.toBe('kanbanCard');
    expect(markNotificationRead).toHaveBeenCalledWith(1);
  });

  it('refreshes when marking read fails, and skips already-read items', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getNotifications).mockResolvedValue([note(), note({ id: 2, title: 'Old', read_at: minutesAgo(1), project_id: null })]);
    vi.mocked(markNotificationRead).mockRejectedValue(new Error('x'));
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Old/ }));
    });
    expect(markNotificationRead).not.toHaveBeenCalled();
    expect(useViewStore.getState().currentView).toBe('gantt');

    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Bob commented/ }));
    });
    expect(error).toHaveBeenCalledWith('[Notifications] Failed to mark read:', expect.any(Error));
    expect(getNotifications).toHaveBeenCalledTimes(2);
  });

  it('does not jump to the Kanban board while What-If is active', async () => {
    vi.mocked(getNotifications).mockResolvedValue([note()]);
    vi.mocked(getUnreadCount).mockResolvedValue(1);
    useWhatIfStore.getState().enterWhatIfMode([]);
    await renderBell();
    fireEvent.click(bell());

    const hint = whatIfUnavailableMessage('Opening a card from a notification');
    expect(screen.getByRole('note')).toHaveTextContent(hint);
    const row = screen.getByRole('button', { name: /Bob commented/ });
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute('title', hint);
    // Mark all read has nothing to do with the board and stays usable.
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeEnabled();

    await act(async () => {
      fireEvent.click(row);
    });
    expect(useViewStore.getState().currentView).toBe('gantt');
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(markNotificationRead).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().panelOpen).toBe(true);
  });

  it('still opens a notification without a card during What-If', async () => {
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 7, title: 'Project note', project_id: null, entity_type: null, entity_id: null }),
    ]);
    useWhatIfStore.getState().enterWhatIfMode([]);
    await renderBell();
    fireEvent.click(bell());
    const row = screen.getByRole('button', { name: /Project note/ });
    expect(row).toBeEnabled();
    expect(row).not.toHaveAttribute('title');
    await act(async () => {
      fireEvent.click(row);
    });
    expect(markNotificationRead).toHaveBeenCalledWith(7);
    expect(useNotificationStore.getState().panelOpen).toBe(false);
    expect(useViewStore.getState().currentView).toBe('gantt');
  });

  it('shows no What-If note outside What-If', async () => {
    await renderBell();
    fireEvent.click(bell());
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('dismisses a derived reminder locally instead of calling the API', async () => {
    vi.mocked(useDerivedDueNotifications).mockReturnValue([
      note({ id: -5, type: 'overdue', source: 'derived', title: 'Overdue: Lab work', entity_type: 'subphase', entity_id: 20, body: 'Lab work was due 2026-10-01' }),
    ]);
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Overdue: Lab work/ }));
    });
    expect(dismissDerivedNotification).toHaveBeenCalledWith('subphase-20', '2026-10-01');
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it('marks everything read, refreshing on failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getNotifications).mockResolvedValue([note()]);
    vi.mocked(getUnreadCount).mockResolvedValue(1);
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    });
    expect(markAllNotificationsRead).toHaveBeenCalled();
    expect(useNotificationStore.getState().unreadCount).toBe(0);
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();

    act(() => useNotificationStore.setState({ unreadCount: 2 }));
    vi.mocked(markAllNotificationsRead).mockRejectedValue(new Error('x'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    });
    expect(error).toHaveBeenCalledWith('[Notifications] Failed to mark all read:', expect.any(Error));
  });

  it('closes on an outside click but not on a click inside', async () => {
    await renderBell();
    fireEvent.click(bell());
    expect(bell()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Notifications' }));
    expect(useNotificationStore.getState().panelOpen).toBe(true);
    fireEvent.mouseDown(document.body);
    expect(useNotificationStore.getState().panelOpen).toBe(false);
  });
});
