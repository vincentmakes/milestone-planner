/**
 * App shell: the admin portal never runs the tenant auth check (F1-28), and a
 * failed initial data load shows an error with Retry instead of an empty
 * workspace (F1-16).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { User } from '@/types';

vi.mock('@/components/layout/MainLayout', () => ({ MainLayout: () => <div>main-layout</div> }));
vi.mock('@/components/modals', () => ({ ModalContainer: () => null }));
vi.mock('@/components/gantt/ContextMenuContainer', () => ({ ContextMenuContainer: () => null }));
vi.mock('@/components/admin', () => ({ AdminApp: () => <div>admin-portal</div> }));
vi.mock('@/components/common/ActivityFeed/ActivityFeed', () => ({ ActivityFeed: () => null }));
vi.mock('@/components/screens/LoginScreen', () => ({ LoginScreen: () => <div>login-screen</div> }));
vi.mock('@/contexts/WebSocketContext', () => ({
  WebSocketProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const api = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  getSites: vi.fn(),
}));

vi.mock('@/api', () => ({
  checkAuth: api.checkAuth,
  login: vi.fn(),
  logout: vi.fn(),
  getSites: api.getSites,
  getStaff: vi.fn(async () => []),
  getEquipment: vi.fn(async () => []),
  getEquipmentBlocks: vi.fn(async () => []),
  getVacations: vi.fn(async () => []),
  loadAllProjects: vi.fn(async () => []),
  getBankHolidays: vi.fn(async () => []),
  buildHolidayDateSet: () => new Set(),
  getCompanyEvents: vi.fn(async () => []),
  buildEventDateSet: () => new Set(),
  getInstanceSettings: vi.fn(async () => null),
  getCustomColumnsWithValues: vi.fn(async () => ({ columns: [], values: {} })),
  skillsApi: { getAll: vi.fn(async () => []) },
  tagsApi: { getAll: vi.fn(async () => []) },
  tagGroupsApi: { getAll: vi.fn(async () => []) },
  teamsApi: { getAll: vi.fn(async () => []) },
  absenceTypesApi: { getAll: vi.fn(async () => []) },
}));

import App from '../App';
import { useAppStore } from '@/stores/appStore';
import { confirmAction } from '@/utils/confirmDialog';

function setPath(path: string) {
  window.history.replaceState({}, '', path);
}

describe('App', () => {
  beforeEach(() => {
    useAppStore.getState().reset();
    api.checkAuth.mockReset().mockResolvedValue({ user: { id: 1, role: 'admin' } as User });
    api.getSites.mockReset().mockResolvedValue([]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    setPath('/');
    vi.restoreAllMocks();
  });

  it('renders the admin portal without calling the tenant /api/auth/me', async () => {
    setPath('/admin/tenants');
    render(<App />);

    expect(await screen.findByText('admin-portal')).toBeInTheDocument();
    expect(api.checkAuth).not.toHaveBeenCalled();
  });

  it('checks the tenant session outside /admin', async () => {
    setPath('/t/demo/');
    render(<App />);

    expect(await screen.findByText('main-layout')).toBeInTheDocument();
    expect(api.checkAuth).toHaveBeenCalledTimes(1);
  });

  it('shows the login screen when there is no session', async () => {
    api.checkAuth.mockResolvedValue({ user: null });
    render(<App />);
    expect(await screen.findByText('login-screen')).toBeInTheDocument();
  });

  it('shows an error with Retry when the initial load fails, and retries', async () => {
    api.getSites.mockRejectedValueOnce(new Error('HTTP 500: Internal Server Error'));
    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500: Internal Server Error');
    expect(screen.queryByText('main-layout')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('main-layout')).toBeInTheDocument();
    await waitFor(() => expect(api.getSites).toHaveBeenCalledTimes(2));
  });

  it('goes back to the login screen when the session expires', async () => {
    const { expireSession } = await import('@/stores');
    render(<App />);
    expect(await screen.findByText('main-layout')).toBeInTheDocument();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expireSession();

    expect(await screen.findByText('login-screen')).toBeInTheDocument();
  });

  it.each([
    ['the admin portal', '/admin', 'admin-portal'],
    ['the tenant app', '/t/demo/', 'main-layout'],
  ])('mounts the shared confirm dialog in %s', async (_label, path, marker) => {
    setPath(path);
    render(<App />);
    expect(await screen.findByText(marker)).toBeInTheDocument();

    let answer!: Promise<boolean>;
    act(() => {
      answer = confirmAction('Really?');
    });
    expect(screen.getByRole('dialog', { name: 'Please confirm' })).toHaveTextContent('Really?');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(answer).resolves.toBe(true);
  });
});
