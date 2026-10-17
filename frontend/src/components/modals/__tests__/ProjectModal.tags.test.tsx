/**
 * ProjectModal + TagPicker: "Manage tags…" is disabled while the project save
 * is in flight — otherwise the hub would open and then be closed again by the
 * resolving save's own closeModal().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ProjectModal } from '../ProjectModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { updateProject } from '@/api/endpoints/projects';
import type { Project, Site } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createProject: vi.fn().mockResolvedValue({}),
  updateProject: vi.fn(),
  loadAllProjects: vi.fn(async () => (await import('@/stores/appStore')).useAppStore.getState().projects),
}));
vi.mock('@/api/endpoints/settings', () => ({ getPredefinedPhases: vi.fn(async () => []) }));

const project = {
  id: 9,
  name: 'Bioprocess Scale-Up',
  site_id: 1,
  customer: null,
  pm_id: null,
  sales_pm: null,
  volume: null,
  confirmed: false,
  archived: false,
  start_date: '2026-09-01',
  end_date: '2026-10-01',
  tags: [],
  phases: [],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

beforeEach(() => {
  useAppStore.setState({
    currentSite: { id: 1, name: 'Basel' } as Site,
    currentUser: { id: 1, name: 'Ada Admin', role: 'admin' } as never,
    staff: [],
    projects: [project],
    tags: [],
    tagGroups: [],
  });
  act(() => useUIStore.getState().openProjectModal(project));
});

afterEach(() => {
  useUIStore.getState().closeModal();
  vi.restoreAllMocks();
});

describe('ProjectModal tag picker during save', () => {
  it('disables "Manage tags…" and the tag search until the save settles', async () => {
    let resolve: (v: unknown) => void = () => {};
    vi.mocked(updateProject).mockImplementationOnce(() => new Promise((r) => { resolve = r; }) as never);
    render(<ProjectModal />);

    const link = screen.getByRole('button', { name: 'Manage tags…' });
    expect(link).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(link).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Find a tag' })).toBeDisabled();

    await act(async () => {
      resolve({});
    });
    expect(useUIStore.getState().activeModal).toBeNull();
  });
});
