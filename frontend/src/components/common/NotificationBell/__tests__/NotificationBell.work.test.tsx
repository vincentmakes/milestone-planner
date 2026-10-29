/**
 * Bell → My Work, end to end with the real view: a decision lands on My
 * Requests with the Done filter (a decided request is not pending, so the
 * Open filter would hide it); a request to decide lands on My Approvals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotificationBell } from '../NotificationBell';
import { WorkView } from '@/components/views/WorkView';
import { getNotifications, getUnreadCount, markNotificationRead } from '@/api/endpoints/notifications';
import { approvalsApi } from '@/api/endpoints/approvals';
import { useAppStore } from '@/stores/appStore';
import { useWorkStore } from '@/stores/workStore';
import { useViewStore } from '@/stores/viewStore';
import { resetAllStores } from '@/stores';
import { makeApprovalRequest, makeUser } from '@/test/factories';
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
      {view === 'work' && <WorkView />}
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
  await waitFor(() => expect(useWorkStore.getState().loaded).toBe(true));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  useViewStore.getState().resetView();
  useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user' }) });
  vi.mocked(getUnreadCount).mockResolvedValue(1);
  vi.mocked(markNotificationRead).mockResolvedValue({ success: true });
  vi.mocked(approvalsApi.getToDecide).mockResolvedValue([
    makeApprovalRequest({ id: 31, requester_id: 7, requester_name: 'Alice Smith', can_decide: true }),
  ]);
  vi.mocked(approvalsApi.getMine).mockResolvedValue([
    makeApprovalRequest({ id: 41, status: 'approved', decided_by_name: 'Carol' }),
  ]);
});

describe('bell → My Work', () => {
  it('shows the decided request after a click on its decision, even from the Open filter', async () => {
    vi.mocked(getNotifications).mockResolvedValue([note({})]);
    await openFromBell(/^Your booking on Feasibility was approved by Carol/);
    expect(useWorkStore.getState()).toMatchObject({ activeTab: 'requests', requestsFilter: 'done' });
    expect(screen.getByRole('tab', { name: /^My Requests/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Approved by Carol');
  });

  it('shows the request to decide on My Approvals', async () => {
    vi.mocked(getNotifications).mockResolvedValue([
      note({ type: 'approval_requested', entity_id: 31, title: 'Alice Smith asks to join Feasibility' }),
    ]);
    await openFromBell(/^Alice Smith asks to join/);
    expect(useWorkStore.getState().activeTab).toBe('approvals');
    expect(screen.getByRole('tab', { name: /^My Approvals/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Alice Smith wants to join');
  });
});
