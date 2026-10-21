/**
 * My Todo shows the cards I am assigned to and the cards I asked to join
 * (my booking awaits approval), the latter with a pending badge. Only an
 * approved assignee may drag a card (card_access.py).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { KanbanView } from '../KanbanView';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import { makePhase, makeProject, makeUser } from '@/test/factories';
import type { StaffAssignment } from '@/types';

vi.mock('@/api/endpoints/kanban', () => ({
  getCommentCounts: vi.fn().mockResolvedValue(new Map()),
  getSiteCommentCounts: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ recentChanges: [] }),
}));
vi.mock('@/api/endpoints/roles', () => ({
  rolesApi: { getAll: vi.fn(() => new Promise(() => {})), getApprovalPolicies: vi.fn(() => new Promise(() => {})) },
}));

const me = 4;
const row = (id: number, staffId: number, over: Partial<StaffAssignment> = {}): StaffAssignment => ({
  id,
  staff_id: staffId,
  staff_name: staffId === me ? 'Bob Brown' : 'Carol Chen',
  allocation: 50,
  start_date: '',
  end_date: '',
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  useUIStore.setState({ activeModal: null });
  useViewStore.setState({ kanbanProjectId: null, tagFilters: {}, teamFilters: {}, kanbanMyTodoOnly: true, kanbanGrouping: 'none' });
  useAppStore.setState({
    projects: [
      makeProject({
        id: 1,
        phases: [
          makePhase({ id: 11, name: 'Assigned to me', order_index: 0, staffAssignments: [row(1, me)] }),
          makePhase({
            id: 12,
            name: 'Asked to join',
            order_index: 1,
            staffAssignments: [row(2, me, { approval_status: 'pending' })],
          }),
          makePhase({ id: 13, name: 'Someone else', order_index: 2, staffAssignments: [row(3, 5)] }),
        ],
      }),
    ],
    currentSite: { id: 1, name: 'Basel' } as never,
    currentUser: makeUser({ id: me, role: 'user' }),
    staff: [],
    tags: [],
    tagGroups: [],
    teams: [],
    approvalPolicies: [],
    roles: [],
  });
});

const cardOf = (name: string) => screen.getByRole('button', { name }) as HTMLElement;

describe('KanbanView My Todo with pending bookings', () => {
  it('lists my cards and the cards I asked to join, with a pending badge', async () => {
    render(<KanbanView />);
    await act(async () => {});
    expect(cardOf('Assigned to me')).toBeInTheDocument();
    expect(cardOf('Asked to join')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Someone else' })).not.toBeInTheDocument();

    expect(cardOf('Asked to join')).toHaveTextContent('Pending approval');
    expect(cardOf('Assigned to me')).not.toHaveTextContent('Pending approval');
  });

  it('lets me drag only the card I am approved on', async () => {
    render(<KanbanView />);
    await act(async () => {});
    expect(cardOf('Assigned to me')).toHaveAttribute('draggable', 'true');
    expect(cardOf('Asked to join')).toHaveAttribute('draggable', 'false');
  });

  it('draws a pending assignee with a dashed avatar', async () => {
    useViewStore.setState({ kanbanMyTodoOnly: false });
    render(<KanbanView />);
    await act(async () => {});
    const avatar = screen.getByTitle('Bob Brown - 50% (pending approval)');
    expect(avatar.className).toMatch(/pendingAvatar/);
    expect(screen.getAllByTitle('Bob Brown - 50%')[0].className).not.toMatch(/pendingAvatar/);
  });
});
