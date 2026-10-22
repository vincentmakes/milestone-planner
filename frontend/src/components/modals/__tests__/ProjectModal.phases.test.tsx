/**
 * ProjectModal predefined phases on create: every active phase is selected
 * by default, or none when the admin turned the pre-selection off (Settings
 * → Features & defaults); the selected phases split the project span evenly,
 * in template order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ProjectModal } from '../ProjectModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { createProject } from '@/api/endpoints/projects';
import { makeUser } from '@/test/factories';
import type { InstanceSettings, Site } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createProject: vi.fn().mockResolvedValue({}),
  updateProject: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn(async () => []),
}));
vi.mock('@/api/endpoints/settings', () => ({
  getPredefinedPhases: vi.fn(async () => [
    { id: 1, name: 'Design', is_active: true },
    { id: 2, name: 'Build', is_active: true },
    { id: 3, name: 'Retired', is_active: false },
    { id: 4, name: 'Test', is_active: true },
  ]),
}));

type Sent = { phases?: { type: string; start_date: string; end_date: string }[] };
const sent = () => vi.mocked(createProject).mock.lastCall?.[0] as Sent;
const isSelected = (name: string) => /selected/.test(screen.getByText(name).className);

async function openNewProject(settings: InstanceSettings | null) {
  useAppStore.setState({ instanceSettings: settings });
  act(() => useUIStore.getState().openProjectModal());
  render(<ProjectModal />);
  await screen.findByText('Design');
  fireEvent.change(screen.getByLabelText('Project Name *'), { target: { value: 'New study' } });
}

const create = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));
  await waitFor(() => expect(createProject).toHaveBeenCalled());
};

beforeEach(() => {
  // The new project spans 2026-03-02 → 2026-04-02 (31 days)
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 2, 2, 9, 0));
  vi.mocked(createProject).mockClear();
  useViewStore.setState({ teamFilters: {} });
  useAppStore.setState({
    currentSite: { id: 1, name: 'Basel' } as Site,
    currentUser: makeUser({ id: 1, role: 'admin' }),
    staff: [],
    projects: [],
    tags: [],
    tagGroups: [],
    teams: [],
  });
});

afterEach(() => {
  useUIStore.getState().closeModal();
  vi.useRealTimers();
});

describe('ProjectModal predefined phases', () => {
  it('selects every active phase by default and splits the span between them', async () => {
    await openNewProject({ new_project_preselect_phases: 'true' });
    expect(['Design', 'Build', 'Test'].map(isSelected)).toEqual([true, true, true]);
    expect(screen.queryByText('Retired')).not.toBeInTheDocument();

    await create();
    expect(sent().phases).toEqual([
      { type: 'Design', start_date: '2026-03-02', end_date: '2026-03-12' },
      { type: 'Build', start_date: '2026-03-12', end_date: '2026-03-22' },
      { type: 'Test', start_date: '2026-03-22', end_date: '2026-04-02' },
    ]);
  });

  it('pre-selects them too before the settings are loaded', async () => {
    await openNewProject(null);
    expect(isSelected('Design')).toBe(true);
  });

  it('selects none when the pre-selection is off, and creates the project without phases', async () => {
    await openNewProject({ new_project_preselect_phases: 'false' });
    expect(['Design', 'Build', 'Test'].map(isSelected)).toEqual([false, false, false]);

    await create();
    expect(sent().phases).toEqual([]);
  });

  it('creates the picked phases, in template order, split over the span', async () => {
    await openNewProject({ new_project_preselect_phases: 'false' });
    fireEvent.click(screen.getByText('Test'));
    fireEvent.click(screen.getByText('Design'));
    expect(isSelected('Test')).toBe(true);
    expect(isSelected('Build')).toBe(false);

    await create();
    expect(sent().phases).toEqual([
      { type: 'Design', start_date: '2026-03-02', end_date: '2026-03-17' },
      { type: 'Test', start_date: '2026-03-17', end_date: '2026-04-02' },
    ]);
  });
});
