/**
 * Bell → My Todos, end to end with the real view: a decision lands on My
 * requests with the Done filter (a decided request is not pending, so the
 * Open filter would hide it); an assigned task lands on My tasks, Open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotificationBell } from '../NotificationBell';
import { TodosView } from '@/components/views/TodosView';
import { getNotifications, getUnreadCount, markNotificationRead } from '@/api/endpoints/notifications';
import { todosApi } from '@/api/endpoints/todos';
import { approvalsApi } from '@/api/endpoints/approvals';
import { useAppStore } from '@/stores/appStore';
import { useTodoStore } from '@/stores/todoStore';
import { useViewStore } from '@/stores/viewStore';
import { resetAllStores } from '@/stores';
import { makeApprovalRequest, makeTodo, makeUser } from '@/test/factories';
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
vi.mock('@/hooks/useDataLoader', () => ({
  useDataLoader: () => ({ refreshProjects: vi.fn() }),
}));
vi.mock('@/api/endpoints/todos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/todos')>()),
  todosApi: { getMine: vi.fn() },
}));
vi.mock('@/api/endpoints/approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/approvals')>()),
  approvalsApi: { getMine: vi.fn(), getToDecide: vi.fn() },
}));

function note(overrides: Partial<AppNotification>): AppNotification {
  return {
    id: 9,
    type: 'approval_decided',
    entity_type: 'approval_request',
    entity_id: 41,
    project_id: 1,
    title: 'Your booking on Feasibility was approved by Carol',
    read_at: null,
    created_at: new Date().toISOString(),
    source: 'server',
    ...overrides,
  };
}

/** The bell next to the view MainLayout would render for currentView. */
function Harness() {
  const view = useViewStore((s) => s.currentView);
  return (
    <>
      <NotificationBell />
      {view === 'todos' && <TodosView />}
    </>
  );
}

async function openFromBell(title: RegExp) {
  render(<Harness />);
  await waitFor(() => expect(getUnreadCount).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: title }));
  });
  await waitFor(() => expect(useTodoStore.getState().loaded).toBe(true));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  useViewStore.getState().resetView();
  useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user' }) });
  vi.mocked(getUnreadCount).mockResolvedValue(1);
  vi.mocked(markNotificationRead).mockResolvedValue({ success: true });
  vi.mocked(todosApi.getMine).mockResolvedValue([makeTodo({ id: 1, title: 'Order reagents' })]);
  vi.mocked(approvalsApi.getToDecide).mockResolvedValue([]);
  vi.mocked(approvalsApi.getMine).mockResolvedValue([
    makeApprovalRequest({ id: 41, status: 'approved', decided_by_name: 'Carol' }),
  ]);
});

describe('bell → My Todos', () => {
  it('shows the decided request after a click on its decision, even from the Open filter', async () => {
    vi.mocked(getNotifications).mockResolvedValue([note({})]);
    await openFromBell(/approved by Carol/);
    expect(useTodoStore.getState()).toMatchObject({ activeTab: 'requests', statusFilter: 'done' });
    expect(screen.getByRole('tab', { name: /^My requests/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Approved by Carol');
  });

  it('shows the assigned task on My tasks with the Open filter, even after Done was chosen', async () => {
    useTodoStore.getState().setStatusFilter('done');
    vi.mocked(getNotifications).mockResolvedValue([
      note({ type: 'todo_assigned', entity_type: 'todo', entity_id: 1, title: 'Alice assigned you a task: Order reagents' }),
    ]);
    await openFromBell(/Alice assigned you a task/);
    expect(useTodoStore.getState()).toMatchObject({ activeTab: 'tasks', statusFilter: 'open' });
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Order reagents');
  });
});
