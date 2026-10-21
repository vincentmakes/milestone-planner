/**
 * The per-site tag filter narrows the Kanban project picker and the
 * "All projects" board; with nothing matching, the toolbar stays so the
 * filter can be cleared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import { KanbanView } from '../KanbanView';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import type { Project, Tag } from '@/types';
import { tagFilterKey } from '@/utils/tags';
import { makeTeam, makeUser } from '@/test/factories';

vi.mock('@/api/endpoints/kanban', () => ({
  getCommentCounts: vi.fn().mockResolvedValue(new Map()),
  getSiteCommentCounts: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ recentChanges: [] }),
}));

const pilot: Tag = { id: 7, name: 'Pilot', color: '#10b981', group_id: null, all_sites: true, site_ids: [], sort_order: 0 };

function makeProject(id: number, name: string, tagIds: number[]): Project {
  return {
    id,
    name,
    site_id: 1,
    pm_id: null,
    confirmed: true,
    archived: false,
    start_date: '2026-03-01',
    end_date: '2026-03-31',
    phases: [],
    staffAssignments: [],
    equipmentAssignments: [],
    tags: tagIds.map((t) => ({ id: t, name: 'stale', color: '#000000', group_id: null })),
  } as Project;
}

beforeEach(() => {
  localStorage.clear();
  useUIStore.setState({ activeModal: null });
  useViewStore.setState({ kanbanProjectId: null, tagFilters: {}, teamFilters: {} });
  useAppStore.setState({
    projects: [makeProject(1, 'Bioprocess Scale-Up', [7]), makeProject(2, 'Catalyst Optimization', [])],
    currentSite: { id: 1, name: 'Basel' } as never,
    currentUser: makeUser({ id: 1, role: 'admin' }),
    staff: [],
    tags: [pilot],
    tagGroups: [],
    teams: [],
  });
});

function pickerOptions() {
  return within(screen.getByLabelText('Project'))
    .getAllByRole('option')
    .map((o) => o.textContent);
}

describe('KanbanView tag filter', () => {
  it('narrows the project picker to matching projects', async () => {
    render(<KanbanView />);
    await act(async () => {});
    expect(pickerOptions()).toEqual(['All projects', 'Bioprocess Scale-Up', 'Catalyst Optimization']);

    await act(async () => useViewStore.getState().setTagFilter(1, { tagIds: [7], noneGroupIds: [] }));
    expect(pickerOptions()).toEqual(['All projects', 'Bioprocess Scale-Up']);
  });

  it('falls back to all (filtered) projects when the picked project is filtered out', async () => {
    useViewStore.setState({ kanbanProjectId: 2 });
    render(<KanbanView />);
    await act(async () => useViewStore.getState().setTagFilter(1, { tagIds: [7], noneGroupIds: [] }));
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('__all__');
  });

  it('keeps the toolbar when nothing matches', async () => {
    useAppStore.setState({ projects: [makeProject(2, 'Catalyst Optimization', [])] });
    useViewStore.setState({ tagFilters: { ':1': { tagIds: [7], noneGroupIds: [] } } });
    render(<KanbanView />);
    await act(async () => {});
    expect(screen.getByText('No projects in Basel match the tag filter.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tags (1 selected)' })).toBeInTheDocument();
  });

  it('with an active team filter, hides non-matching projects and keeps matching ones', async () => {
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1 })],
      projects: [
        { ...makeProject(1, 'Bioprocess Scale-Up', []), team_ids: [1] },
        { ...makeProject(2, 'Catalyst Optimization', []), team_ids: [] },
      ],
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
    render(<KanbanView />);
    await act(async () => {});
    expect(pickerOptions()).toEqual(['All projects', 'Bioprocess Scale-Up']);
  });
});
