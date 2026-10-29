/**
 * Notification bell: loads the inbox on mount and on window focus, merges
 * browser-derived due reminders, opens the card on click (marking a server
 * notification read, dismissing a derived one locally) — or the project on
 * the Gantt, switching site, for a project or when the board is out of
 * reach —, mark-all, delete one (× beside the row) and clear all (behind a
 * confirmation), and closes on outside click (a popover, not a modal).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotificationBell } from '../NotificationBell';
import {
  clearNotifications,
  deleteNotification,
  getNotifications,
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/api/endpoints/notifications';
import { dismissDerivedNotification, useDerivedDueNotifications } from '@/hooks/useDerivedDueNotifications';
import { selectSite } from '@/hooks/useDataLoader';
import { useAppStore } from '@/stores/appStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { resetAllStores } from '@/stores';
import { useWorkStore } from '@/stores/workStore';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { makePhase, makeProject, makeSite, makeSubphase, makeUser } from '@/test/factories';
import { stubConfirm } from '@/test/confirmDialog';
import type { AppNotification } from '@/types';

vi.mock('@/api/endpoints/notifications', () => ({
  getNotifications: vi.fn(),
  getUnreadCount: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  deleteNotification: vi.fn(),
  clearNotifications: vi.fn(),
}));
vi.mock('@/hooks/useDerivedDueNotifications', () => ({
  useDerivedDueNotifications: vi.fn(() => []),
  dismissDerivedNotification: vi.fn(),
}));
vi.mock('@/hooks/useDataLoader', () => ({ selectSite: vi.fn() }));

const BASEL = makeSite({ id: 1, name: 'Basel' });
const BERLIN = makeSite({ id: 2, name: 'Berlin' });
const NO_KANBAN = ['projects.view'];

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
  vi.mocked(deleteNotification).mockReset().mockResolvedValue();
  vi.mocked(clearNotifications).mockReset().mockResolvedValue({ deleted: 2 });
  vi.mocked(useDerivedDueNotifications).mockReset().mockReturnValue([]);
  vi.mocked(dismissDerivedNotification).mockReset();
  vi.mocked(selectSite).mockReset().mockResolvedValue();
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
    expect(screen.getByRole('button', { name: /^Bob commented/ })).toHaveTextContent('Bob commented on Feasibility');

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
      fireEvent.click(screen.getByRole('button', { name: /^Bob commented/ }));
    });
    expect(useViewStore.getState()).toMatchObject({ currentView: 'kanban', kanbanProjectId: 1 });
    expect(useUIStore.getState().activeModal).toBe('kanbanCard');
    expect(useNotificationStore.getState().panelOpen).toBe(false);
    expect(markNotificationRead).toHaveBeenCalledWith(1);
    expect(useNotificationStore.getState().items[0].read_at).toBeTruthy();
  });

  it('opens the card\'s project on the Gantt when views.kanban is missing', async () => {
    useAppStore.setState({
      currentUser: makeUser({ id: 4, role: 'viewer', permissions: NO_KANBAN }),
      sites: [BASEL],
      currentSite: BASEL,
      projects: [makeProject({ id: 1, site_id: 1 })],
    });
    useViewStore.getState().setCurrentView('work');
    vi.mocked(getNotifications).mockResolvedValue([note({ type: 'assignment_changed', title: 'Alice moved Feasibility' })]);
    vi.mocked(getUnreadCount).mockResolvedValue(1);
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Alice moved Feasibility/ }));
    });
    expect(useViewStore.getState().currentView).toBe('gantt');
    expect(useViewStore.getState().expandedProjects.has(1)).toBe(true);
    expect(useUIStore.getState().activeModal).not.toBe('kanbanCard');
    expect(selectSite).not.toHaveBeenCalled();
    expect(markNotificationRead).toHaveBeenCalledWith(1);
  });

  it('opens a project notification on the Gantt, on the current site', async () => {
    useAppStore.setState({ sites: [BASEL], currentSite: BASEL, projects: [makeProject({ id: 1, site_id: 1 })] });
    useViewStore.getState().setCurrentView('kanban');
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 5, type: 'project_changed', entity_type: 'project', entity_id: 1, title: 'Alice changed Bioprocess' }),
    ]);
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Alice changed Bioprocess/ }));
    });
    expect(useViewStore.getState().currentView).toBe('gantt');
    expect(useViewStore.getState().expandedProjects.has(1)).toBe(true);
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(selectSite).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().panelOpen).toBe(false);
    expect(markNotificationRead).toHaveBeenCalledWith(5);
  });

  it('opens a comment on a project thread on the Gantt, even without views.kanban', async () => {
    useAppStore.setState({
      currentUser: makeUser({ id: 4, role: 'viewer', permissions: NO_KANBAN }),
      sites: [BASEL],
      currentSite: BASEL,
      projects: [makeProject({ id: 1, site_id: 1 })],
    });
    useViewStore.getState().setCurrentView('work');
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 5, type: 'mention', entity_type: 'project', entity_id: 1, title: 'Alice mentioned you on Bioprocess' }),
    ]);
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Alice mentioned you on Bioprocess/ }));
    });
    expect(useViewStore.getState().currentView).toBe('gantt');
    expect(useViewStore.getState().expandedProjects.has(1)).toBe(true);
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(markNotificationRead).toHaveBeenCalledWith(5);
  });

  it('opens a thread on a parent phase or subphase on the Gantt: a card is a leaf', async () => {
    const leaf = makeSubphase({ id: 30, children: [] });
    const parentSub = makeSubphase({ id: 20, children: [leaf] });
    useAppStore.setState({
      sites: [BASEL],
      currentSite: BASEL,
      projects: [makeProject({ id: 1, site_id: 1, phases: [makePhase({ id: 10, children: [parentSub] })] })],
    });
    useViewStore.getState().setCurrentView('work');
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 6, type: 'comment', entity_type: 'phase', entity_id: 10, title: 'Bob commented on Feasibility' }),
      note({ id: 7, type: 'mention', entity_type: 'subphase', entity_id: 20, title: 'Bob mentioned you on Review' }),
      note({ id: 8, type: 'comment', entity_type: 'subphase', entity_id: 30, title: 'Bob commented on Leaf' }),
    ]);
    await renderBell();
    for (const name of [/^Bob commented on Feasibility/, /^Bob mentioned you on Review/]) {
      useViewStore.getState().setCurrentView('work');
      fireEvent.click(bell());
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name }));
      });
      expect(useViewStore.getState().currentView).toBe('gantt');
      expect(useViewStore.getState().expandedProjects.has(1)).toBe(true);
      expect(useUIStore.getState().activeModal).not.toBe('kanbanCard');
    }
    // A leaf subphase is still a card.
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Bob commented on Leaf/ }));
    });
    expect(useViewStore.getState().currentView).toBe('kanban');
    expect(useUIStore.getState().activeModal).toBe('kanbanCard');
  });

  it('switches to the project\'s site when it sits on another visible one', async () => {
    useAppStore.setState({
      currentUser: makeUser({ id: 4, role: 'user', site_ids: [1, 2] }),
      sites: [BASEL, BERLIN],
      currentSite: BASEL,
      projects: [makeProject({ id: 1, site_id: 1 }), makeProject({ id: 8, site_id: 2, name: 'Trial' })],
    });
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 5, type: 'project_changed', entity_type: 'project', entity_id: 8, project_id: 8, title: 'Alice changed Trial' }),
    ]);
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Alice changed Trial/ }));
    });
    expect(selectSite).toHaveBeenCalledWith(BERLIN);
    expect(useViewStore.getState().currentView).toBe('gantt');
    expect(useViewStore.getState().expandedProjects.has(8)).toBe(true);
  });

  it.each([
    ['deleted', [] as ReturnType<typeof makeProject>[], [BASEL]],
    ['archived', [makeProject({ id: 1, site_id: 1, archived: true })], [BASEL]],
    ['on a site the user cannot see', [makeProject({ id: 1, site_id: 2 })], [BASEL, BERLIN]],
  ])('flashes when the project is %s, and still marks it read', async (_label, projects, sites) => {
    // A plain user sees only their own site (1).
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user' }), sites, currentSite: BASEL, projects });
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 5, type: 'project_changed', entity_type: 'project', entity_id: 1, title: 'Alice changed Bioprocess' }),
    ]);
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Alice changed Bioprocess/ }));
    });
    expect(useUIStore.getState().flashNotice).toMatchObject({ message: 'This project is no longer available' });
    expect(useViewStore.getState().expandedProjects.has(1)).toBe(false);
    expect(selectSite).not.toHaveBeenCalled();
    expect(markNotificationRead).toHaveBeenCalledWith(5);
  });

  it('only marks read a notification without a project (a deleted project)', async () => {
    useViewStore.getState().setCurrentView('work');
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 6, type: 'assignment_changed', entity_type: null, entity_id: null, project_id: null, title: 'Alice deleted Trial' }),
    ]);
    await renderBell();
    fireEvent.click(bell());
    const row = screen.getByRole('button', { name: /^Alice deleted Trial/ });
    expect(row).toBeEnabled();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(markNotificationRead).toHaveBeenCalledWith(6);
    expect(useViewStore.getState().currentView).toBe('work');
    expect(useUIStore.getState().flashNotice).toBeNull();
    expect(selectSite).not.toHaveBeenCalled();
  });

  it('during What-If, blocks a project on another site but opens one on the current site', async () => {
    useAppStore.setState({
      currentUser: makeUser({ id: 4, role: 'user', site_ids: [1, 2] }),
      sites: [BASEL, BERLIN],
      currentSite: BASEL,
      projects: [makeProject({ id: 1, site_id: 1 }), makeProject({ id: 8, site_id: 2, name: 'Trial' })],
    });
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 5, type: 'project_changed', entity_type: 'project', entity_id: 8, project_id: 8, title: 'Alice changed Trial' }),
      note({ id: 6, type: 'project_changed', entity_type: 'project', entity_id: 1, project_id: 1, title: 'Alice changed Bioprocess' }),
    ]);
    useWhatIfStore.getState().enterWhatIfMode([]);
    await renderBell();
    fireEvent.click(bell());

    const elsewhere = screen.getByRole('button', { name: /^Alice changed Trial/ });
    expect(elsewhere).toBeDisabled();
    expect(elsewhere).toHaveAttribute(
      'title',
      whatIfUnavailableMessage('Opening a project on another site from a notification')
    );
    await act(async () => {
      fireEvent.click(elsewhere);
    });
    expect(selectSite).not.toHaveBeenCalled();
    expect(markNotificationRead).not.toHaveBeenCalled();

    const here = screen.getByRole('button', { name: /^Alice changed Bioprocess/ });
    expect(here).toBeEnabled();
    expect(here).not.toHaveAttribute('title');
    await act(async () => {
      fireEvent.click(here);
    });
    expect(useViewStore.getState().expandedProjects.has(1)).toBe(true);
    expect(markNotificationRead).toHaveBeenCalledWith(6);
  });

  it('refreshes when marking read fails, and skips already-read items', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getNotifications).mockResolvedValue([note(), note({ id: 2, title: 'Old', read_at: minutesAgo(1), project_id: null })]);
    vi.mocked(markNotificationRead).mockRejectedValue(new Error('x'));
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Old/ }));
    });
    expect(markNotificationRead).not.toHaveBeenCalled();
    expect(useViewStore.getState().currentView).toBe('gantt');

    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Bob commented/ }));
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
    const row = screen.getByRole('button', { name: /^Bob commented/ });
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
    const row = screen.getByRole('button', { name: /^Project note/ });
    expect(row).toBeEnabled();
    expect(row).not.toHaveAttribute('title');
    await act(async () => {
      fireEvent.click(row);
    });
    expect(markNotificationRead).toHaveBeenCalledWith(7);
    expect(useNotificationStore.getState().panelOpen).toBe(false);
    expect(useViewStore.getState().currentView).toBe('gantt');
  });

  it.each([
    ['approval_requested', 'approval_request', 'approvals', 'Bob asks to join Feasibility'],
    ['approval_decided', 'approval_request', 'requests', 'Your booking on Feasibility was approved by Alice'],
  ] as const)('opens My Work on the right tab for %s', async (type, entityType, tab, title) => {
    vi.mocked(getNotifications).mockResolvedValue([note({ id: 9, type, entity_type: entityType, entity_id: 31, title })]);
    vi.mocked(getUnreadCount).mockResolvedValue(1);
    // Even a role without views.kanban: My Work is always available.
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'viewer', permissions: ['projects.view'] }) });
    await renderBell();
    fireEvent.click(bell());
    const item = screen.getByRole('button', { name: new RegExp(`^${title}`) });
    await act(async () => {
      fireEvent.click(item);
    });
    expect(useViewStore.getState().currentView).toBe('work');
    expect(useWorkStore.getState().activeTab).toBe(tab);
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(markNotificationRead).toHaveBeenCalledWith(9);
  });

  it('gives each new type its own icon', async () => {
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 1, title: 'A comment' }),
      note({ id: 2, type: 'approval_requested', title: 'A request' }),
      note({ id: 3, type: 'approval_decided', title: 'A decision' }),
      note({ id: 5, type: 'assignment_changed', title: 'A booking change' }),
      note({ id: 6, type: 'project_changed', title: 'A project change' }),
      note({ id: 7, type: 'assigned', title: 'An assignment' }),
    ]);
    await renderBell();
    fireEvent.click(bell());
    const titles = ['A comment', 'A request', 'A decision', 'A booking change', 'A project change', 'An assignment'];
    const icons = titles.map((t) =>
      screen.getByRole('button', { name: new RegExp(`^${t}`) }).querySelector('svg path')?.getAttribute('d')
    );
    expect(new Set(icons).size).toBe(titles.length);
    const iconClass = (t: string) =>
      screen.getByRole('button', { name: new RegExp(`^${t}`) }).querySelector('span')?.className ?? '';
    expect(iconClass('A booking change')).toMatch(/assignmentChanged/);
    expect(iconClass('A project change')).toMatch(/projectChanged/);
  });

  it('opens the card of a decision that names one', async () => {
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 9, type: 'approval_decided', entity_type: 'subphase', entity_id: 20, title: 'Your booking was approved' }),
    ]);
    await renderBell();
    fireEvent.click(bell());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Your booking was approved/ }));
    });
    expect(useViewStore.getState().currentView).toBe('kanban');
    expect(useUIStore.getState().modalContext).toMatchObject({ cardEntityType: 'subphase', cardEntityId: 20 });
  });

  it('does not open My Work while What-If is active', async () => {
    vi.mocked(getNotifications).mockResolvedValue([
      note({ id: 9, type: 'approval_requested', entity_type: 'approval_request', entity_id: 3, title: 'Alice asks to join' }),
    ]);
    useWhatIfStore.getState().enterWhatIfMode([]);
    await renderBell();
    fireEvent.click(bell());
    const item = screen.getByRole('button', { name: /^Alice asks to join/ });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', whatIfUnavailableMessage('Opening My Work from a notification'));
    await act(async () => {
      fireEvent.click(item);
    });
    expect(useViewStore.getState().currentView).toBe('gantt');
    expect(markNotificationRead).not.toHaveBeenCalled();
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
      fireEvent.click(screen.getByRole('button', { name: /^Overdue: Lab work/ }));
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

  describe('delete and clear all', () => {
    const deleteButtons = () => screen.getAllByRole('button', { name: /^Delete "/ });

    async function openWith(list: AppNotification[], unread: number) {
      vi.mocked(getNotifications).mockResolvedValue(list);
      vi.mocked(getUnreadCount).mockResolvedValue(unread);
      await renderBell();
      fireEvent.click(bell());
    }

    it('puts the × beside the row button, never inside it', async () => {
      await openWith([note()], 1);
      const row = screen.getByRole('button', { name: /^Bob commented/ });
      const [remove] = deleteButtons();
      expect(row).not.toContainElement(remove);
      expect(remove.parentElement).toBe(row.parentElement);
      expect(remove.parentElement?.tagName).toBe('LI');
      expect(remove).toHaveAttribute('title', 'Delete notification');
      expect(remove).toHaveAccessibleName('Delete "Bob commented on Feasibility"');
    });

    it('deletes one row optimistically, fixes the badge and keeps focus in the list', async () => {
      await openWith([note({ id: 1 }), note({ id: 2, title: 'Second', read_at: minutesAgo(1) })], 1);
      const [first, second] = deleteButtons();
      first.focus();

      await act(async () => {
        fireEvent.click(first);
      });

      expect(deleteNotification).toHaveBeenCalledWith(1);
      expect(useNotificationStore.getState().items.map((n) => n.id)).toEqual([2]);
      expect(useNotificationStore.getState().unreadCount).toBe(0);
      expect(screen.queryByRole('button', { name: /^Bob commented/ })).not.toBeInTheDocument();
      expect(second).toHaveFocus();
      expect(useNotificationStore.getState().panelOpen).toBe(true);
      // The row was not opened.
      expect(markNotificationRead).not.toHaveBeenCalled();
      expect(useViewStore.getState().currentView).not.toBe('kanban');

      // The last row: focus falls back to the bell.
      await act(async () => {
        fireEvent.click(second);
      });
      expect(bell()).toHaveFocus();
      expect(screen.getByText('Nothing new')).toBeInTheDocument();
    });

    it('reloads the inbox when a delete fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await openWith([note()], 1);
      vi.mocked(deleteNotification).mockRejectedValue(new Error('500'));

      await act(async () => {
        fireEvent.click(deleteButtons()[0]);
      });

      expect(error).toHaveBeenCalledWith('[Notifications] Failed to delete:', expect.any(Error));
      await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(1));
      expect(getNotifications).toHaveBeenCalledTimes(2);
    });

    it('dismisses a derived reminder from its × without calling the API', async () => {
      vi.mocked(useDerivedDueNotifications).mockReturnValue([
        note({ id: -5, type: 'overdue', source: 'derived', title: 'Overdue: Lab work', entity_type: 'subphase', entity_id: 20, body: 'Lab work was due 2026-10-01' }),
      ]);
      await openWith([], 0);

      await act(async () => {
        fireEvent.click(deleteButtons()[0]);
      });

      expect(dismissDerivedNotification).toHaveBeenCalledWith('subphase-20', '2026-10-01');
      expect(deleteNotification).not.toHaveBeenCalled();
      expect(useViewStore.getState().currentView).not.toBe('kanban');
    });

    it('a derived reminder whose card is unknown is left alone', async () => {
      vi.mocked(useDerivedDueNotifications).mockReturnValue([
        note({ id: -6, type: 'due_soon', source: 'derived', title: 'Due soon', entity_type: 'project', body: null }),
      ]);
      await openWith([], 0);
      await act(async () => {
        fireEvent.click(deleteButtons()[0]);
      });
      expect(dismissDerivedNotification).not.toHaveBeenCalled();
      expect(deleteNotification).not.toHaveBeenCalled();
    });

    it('the × works on a row What-If keeps from opening', async () => {
      useAppStore.setState({ sites: [BASEL], currentSite: BASEL });
      useWhatIfStore.getState().enterWhatIfMode([]);
      await openWith([note()], 1);
      expect(screen.getByRole('button', { name: /^Bob commented/ })).toBeDisabled();
      const [remove] = deleteButtons();
      expect(remove).toBeEnabled();
      await act(async () => {
        fireEvent.click(remove);
      });
      expect(deleteNotification).toHaveBeenCalledWith(1);
    });

    it('clears all after a destructive confirmation, keeping derived reminders', async () => {
      const confirm = stubConfirm(true);
      vi.mocked(useDerivedDueNotifications).mockReturnValue([
        note({ id: -1, type: 'due_soon', source: 'derived', title: 'Soon task is due soon' }),
      ]);
      await openWith([note({ id: 1 }), note({ id: 2, title: 'Second' })], 2);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
      });

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Clear all notifications?',
          message: 'Every notification in your inbox is deleted, for you only. Due-soon reminders stay.',
          confirmLabel: 'Clear all',
          destructive: true,
        })
      );
      expect(clearNotifications).toHaveBeenCalledTimes(1);
      expect(useNotificationStore.getState()).toMatchObject({ items: [], unreadCount: 0 });
      expect(screen.getByRole('button', { name: /^Soon task is due soon/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
    });

    it('a cancelled Clear all deletes nothing', async () => {
      stubConfirm(false);
      await openWith([note()], 1);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
      });

      expect(clearNotifications).not.toHaveBeenCalled();
      expect(useNotificationStore.getState().items).toHaveLength(1);
      expect(useNotificationStore.getState().unreadCount).toBe(1);
    });

    it('reloads the inbox when Clear all fails', async () => {
      stubConfirm(true);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await openWith([note()], 1);
      vi.mocked(clearNotifications).mockRejectedValue(new Error('500'));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
      });

      expect(error).toHaveBeenCalledWith('[Notifications] Failed to clear:', expect.any(Error));
      await waitFor(() => expect(useNotificationStore.getState().items).toHaveLength(1));
      expect(useNotificationStore.getState().unreadCount).toBe(1);
    });

    it('offers no Clear all with an empty inbox', async () => {
      await openWith([], 0);
      expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
    });
  });
});
