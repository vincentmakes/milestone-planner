/**
 * Comment counts are keyed on the project id (F2-19). Every projects
 * refetch (each WebSocket change) replaces the project objects; keying the
 * fetch on the object re-requested the counts every time. They are now
 * refetched only when they can have changed: another user's comment (a
 * `card_comment` change) or this user closing a card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { KanbanView } from '../KanbanView';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import { getCommentCounts } from '@/api/endpoints/kanban';
import type { ChangePayload } from '@/contexts/WebSocketContext';
import type { Project } from '@/types';
import { makeUser } from '@/test/factories';

vi.mock('@/api/endpoints/kanban', () => ({
  getCommentCounts: vi.fn().mockResolvedValue(new Map()),
  getSiteCommentCounts: vi.fn().mockResolvedValue(new Map()),
}));

const ws = vi.hoisted(() => ({ recentChanges: [] as unknown[] }));
vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ recentChanges: ws.recentChanges }),
}));

function makeProject(): Project {
  return {
    id: 1,
    name: 'Bioprocess Scale-Up',
    site_id: 1,
    pm_id: null,
    confirmed: true,
    archived: false,
    start_date: '2026-03-01',
    end_date: '2026-03-31',
    phases: [
      {
        id: 10,
        name: 'Design',
        start_date: '2026-03-01',
        end_date: '2026-03-31',
        status: 'todo',
        completion: null,
        dependencies: [],
        children: [],
        staffAssignments: [],
        equipmentAssignments: [],
      },
    ],
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Project;
}

const commentChange = (receivedAt: number): ChangePayload =>
  ({
    user_id: 2,
    user_name: 'Bob',
    entity_type: 'card_comment',
    entity_id: 5,
    project_id: 1,
    action: 'create',
    _receivedAt: receivedAt,
  }) as ChangePayload;

beforeEach(() => {
  vi.mocked(getCommentCounts).mockClear();
  ws.recentChanges = [];
  useUIStore.setState({ activeModal: null });
  useViewStore.setState({ kanbanProjectId: 1 });
  useAppStore.setState({
    projects: [makeProject()],
    currentSite: { id: 1, name: 'Basel' } as never,
    currentUser: makeUser({ id: 1, role: 'admin' }),
    staff: [],
  });
});

describe('KanbanView comment counts', () => {
  it('does not refetch when the projects are merely reloaded', async () => {
    render(<KanbanView />);
    await act(async () => {});
    expect(getCommentCounts).toHaveBeenCalledTimes(1);
    expect(getCommentCounts).toHaveBeenCalledWith(1);

    // A WS-driven refetch: same project, new object
    await act(async () => {
      useAppStore.setState({ projects: [makeProject()] });
    });
    await act(async () => {
      useAppStore.setState({ projects: [makeProject()] });
    });

    expect(getCommentCounts).toHaveBeenCalledTimes(1);
  });

  it('refetches after a card is closed and after another user comments', async () => {
    const { rerender } = render(<KanbanView />);
    await act(async () => {});
    expect(getCommentCounts).toHaveBeenCalledTimes(1);

    await act(async () => {
      useUIStore.setState({ activeModal: 'kanbanCard' });
    });
    await act(async () => {
      useUIStore.setState({ activeModal: null });
    });
    expect(getCommentCounts).toHaveBeenCalledTimes(2);

    ws.recentChanges = [commentChange(1000)];
    await act(async () => rerender(<KanbanView />));
    expect(getCommentCounts).toHaveBeenCalledTimes(3);

    // The change expiring from the list does not refetch again
    ws.recentChanges = [];
    await act(async () => rerender(<KanbanView />));
    expect(getCommentCounts).toHaveBeenCalledTimes(3);
  });
});
