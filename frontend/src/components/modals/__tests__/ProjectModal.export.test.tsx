/**
 * ProjectModal export buttons (CSV / MS Project XML) need projects.export,
 * which is never in the project-manager bundle: a manager editing their own
 * project does not see them, a superuser does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ProjectModal } from '../ProjectModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { makeProject, makeSite, makeUser } from '@/test/factories';

vi.mock('@/api/endpoints/projects', () => ({
  createProject: vi.fn().mockResolvedValue({}),
  updateProject: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn(async () => []),
}));
vi.mock('@/api/endpoints/settings', () => ({ getPredefinedPhases: vi.fn(async () => []) }));

const project = makeProject({ id: 9, site_id: 1, pm_id: 7 });

beforeEach(() => {
  useAppStore.setState({ currentSite: makeSite({ id: 1 }), staff: [], projects: [project], tags: [], tagGroups: [], teams: [] });
});

afterEach(() => {
  useUIStore.getState().closeModal();
});

describe('ProjectModal export', () => {
  it('offers CSV and XML export with projects.export', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 2, role: 'superuser' }) });
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);
    expect(screen.getByRole('button', { name: /CSV/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /XML/ })).toBeInTheDocument();
  });

  it('hides the export from the project manager without the key', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 7, role: 'user' }) });
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);
    expect(screen.queryByRole('button', { name: /CSV/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /XML/ })).not.toBeInTheDocument();
  });
});
