/**
 * The per-site project filter (field items and tags) narrows the Kanban
 * project picker and the
 * "All projects" board; with nothing matching, the toolbar stays so the
 * filter can be cleared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import { KanbanView } from '../KanbanView';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import type { Project, ProjectFieldValue } from '@/types';
import { siteKey } from '@/utils/tags';
import { makeProjectField, makeProjectFieldOption, makeTag, makeTeam, makeUser } from '@/test/factories';

vi.mock('@/api/endpoints/kanban', () => ({
  getCommentCounts: vi.fn().mockResolvedValue(new Map()),
  getSiteCommentCounts: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ recentChanges: [] }),
}));

const pilot = makeTag({ id: 7, name: 'Pilot', color: '#10b981' });
const TYPE = makeProjectField({
  id: 1,
  name: 'Project type',
  options: [makeProjectFieldOption({ id: 10, name: 'Internal' }), makeProjectFieldOption({ id: 11, name: 'Customer' })],
});
const empty = { optionIds: [], noneFieldIds: [], tagIds: [] };

function makeProject(id: number, name: string, tagIds: number[], values: Record<number, ProjectFieldValue> = {}): Project {
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
    tags: tagIds.map((t) => ({ id: t, name: 'stale', color: '#000000' })),
    field_values: values,
  } as Project;
}

beforeEach(() => {
  localStorage.clear();
  useUIStore.setState({ activeModal: null });
  useViewStore.setState({ kanbanProjectId: null, projectFilters: {}, teamFilters: {} });
  useAppStore.setState({
    projects: [
      makeProject(1, 'Bioprocess Scale-Up', [7], { 1: 11 }),
      makeProject(2, 'Catalyst Optimization', [], { 1: 10 }),
      makeProject(3, 'Quality System Upgrade', []),
    ],
    currentSite: { id: 1, name: 'Basel' } as never,
    currentUser: makeUser({ id: 1, role: 'admin' }),
    staff: [],
    tags: [pilot],
    projectFields: [TYPE],
    teams: [],
  });
});

function pickerOptions() {
  return within(screen.getByLabelText('Project'))
    .getAllByRole('option')
    .map((o) => o.textContent);
}

describe('KanbanView project filter', () => {
  it('narrows the project picker to matching projects', async () => {
    render(<KanbanView />);
    await act(async () => {});
    expect(pickerOptions()).toEqual([
      'All projects',
      'Bioprocess Scale-Up',
      'Catalyst Optimization',
      'Quality System Upgrade',
    ]);

    await act(async () => useViewStore.getState().setProjectFilter(1, { ...empty, tagIds: [7] }));
    expect(pickerOptions()).toEqual(['All projects', 'Bioprocess Scale-Up']);

    await act(async () => useViewStore.getState().setProjectFilter(1, { ...empty, optionIds: [10] }));
    expect(pickerOptions()).toEqual(['All projects', 'Catalyst Optimization']);

    await act(async () => useViewStore.getState().setProjectFilter(1, { ...empty, noneFieldIds: [1] }));
    expect(pickerOptions()).toEqual(['All projects', 'Quality System Upgrade']);
  });

  it('falls back to all (filtered) projects when the picked project is filtered out', async () => {
    useViewStore.setState({ kanbanProjectId: 2 });
    render(<KanbanView />);
    await act(async () => useViewStore.getState().setProjectFilter(1, { ...empty, tagIds: [7] }));
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('__all__');
  });

  it('keeps the toolbar when nothing matches', async () => {
    useAppStore.setState({ projects: [makeProject(2, 'Catalyst Optimization', [])] });
    useViewStore.setState({ projectFilters: { ':1': { ...empty, tagIds: [7] } } });
    render(<KanbanView />);
    await act(async () => {});
    expect(screen.getByText('No projects in Basel match the filter.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter (1 selected)' })).toBeInTheDocument();
  });

  it('with an active team filter, hides non-matching projects and keeps matching ones', async () => {
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1 })],
      projects: [
        { ...makeProject(1, 'Bioprocess Scale-Up', []), team_ids: [1] },
        { ...makeProject(2, 'Catalyst Optimization', []), team_ids: [] },
      ],
    });
    useViewStore.setState({ teamFilters: { [siteKey(1)]: { teamIds: [1], noTeam: false } } });
    render(<KanbanView />);
    await act(async () => {});
    expect(pickerOptions()).toEqual(['All projects', 'Bioprocess Scale-Up']);
  });
});
