/**
 * The sidebar's Dashboards entry (2.3.0): below Equipment, a chevron that
 * shows / hides the dashboards the user may open (viewStore
 * `sidebarDashboardsExpanded`, persisted, default open), each opening the
 * view on that dashboard through the view leave guard. The list is loaded on
 * mount when the entry is shown and the store has not loaded it yet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Navigation } from '../Navigation';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { useDashboardStore } from '@/stores/dashboardStore';
import { resetAllStores } from '@/stores';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { setViewLeaveGuard } from '@/utils/viewLeaveGuard';
import { makeSite, makeUser } from '@/test/factories';
import type { Dashboard, DashboardSummary } from '@/types';

vi.mock('@/api/endpoints/dashboards', () => ({
  dashboardsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    query: vi.fn(),
    data: vi.fn(),
  },
}));

const api = vi.mocked(dashboardsApi);

const summary = (id: number, name: string, extra: Partial<DashboardSummary> = {}): DashboardSummary => ({
  id,
  name,
  description: null,
  visibility: 'everyone',
  role_ids: [],
  site_ids: [],
  team_ids: [],
  user_ids: [],
  shared_with: { roles: [], sites: [], teams: [], users: [] },
  owner_id: null,
  owner_name: null,
  is_default: false,
  widget_count: 0,
  can_edit: true,
  updated_at: '2026-10-25T08:00:00.000Z',
  ...extra,
});

const full = (s: DashboardSummary): Dashboard => ({ ...s, widgets: [] });

const OVERVIEW = summary(1, 'Overview', { is_default: true });
const CAPACITY = summary(4, 'Capacity and flows');
const LONG = summary(9, 'A dashboard with a rather long name that will not fit the sidebar');

const twoSites = [makeSite({ id: 1 }), makeSite({ id: 2, name: 'Zurich' })];

const signIn = (permissions?: string[]) =>
  useAppStore.setState({
    currentUser: permissions
      ? makeUser({ role: 'viewer', permissions, site_ids: [1, 2] })
      : makeUser({ role: 'user', site_ids: [1, 2] }),
  });

/** The store as if the list had loaded */
const listed = (dashboards: DashboardSummary[]) => useDashboardStore.setState({ dashboards, listLoaded: true });

const list = () => screen.getByRole('list', { name: 'Dashboards' });
const chevron = () => screen.queryByRole('button', { name: /dashboards$/ });

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  useViewStore.getState().resetView();
  useAppStore.setState({ sites: twoSites });
  api.list.mockResolvedValue([]);
  api.get.mockImplementation(async (id: number) => full([OVERVIEW, CAPACITY, LONG].find((d) => d.id === id)!));
  api.data.mockResolvedValue({ widgets: {}, loaded_at: '2026-10-25T08:00:00.000Z' });
});

afterEach(async () => {
  if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
});

describe('Navigation — the Dashboards entry', () => {
  it('sits below Equipment, with a chevron that controls the open list', () => {
    signIn();
    listed([OVERVIEW, CAPACITY]);
    render(<Navigation />);
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual([
      'Gantt Chart',
      'Kanban Board',
      'My Work',
      'Staff & Calendar',
      'Equipment',
      'Dashboards',
      'Hide dashboards',
      'Overview',
      'Capacity and flows',
      'Cross-Site',
      'Archived',
    ]);
    const toggle = chevron()!;
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', list().id);
    expect(toggle.querySelector('[data-testid="ChevronRightIcon"]')).not.toBeNull();
    // No "Badge" in its class: the phone-size touch target rule applies.
    expect(toggle.className).not.toMatch(/Badge/);
  });

  it('has no chevron and no list without views.dashboards, and loads nothing', () => {
    signIn(['projects.view', 'views.staff']);
    render(<Navigation />);
    expect(chevron()).toBeNull();
    expect(screen.queryByRole('list', { name: 'Dashboards' })).toBeNull();
    expect(api.list).not.toHaveBeenCalled();
  });

  it('shows the row alone in the icons-only sidebar', () => {
    signIn();
    listed([OVERVIEW]);
    render(<Navigation collapsed />);
    expect(screen.getByRole('button', { name: 'Dashboards' })).toBeInTheDocument();
    expect(chevron()).toBeNull();
    expect(screen.queryByRole('list', { name: 'Dashboards' })).toBeNull();
  });

  it('collapses and expands the list, remembered in the view store', () => {
    signIn();
    listed([OVERVIEW, CAPACITY]);
    render(<Navigation />);
    fireEvent.click(chevron()!);
    expect(useViewStore.getState().sidebarDashboardsExpanded).toBe(false);
    expect(screen.queryByRole('list', { name: 'Dashboards' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Overview' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show dashboards' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.className).not.toMatch(/expanded/);
    fireEvent.click(toggle);
    expect(useViewStore.getState().sidebarDashboardsExpanded).toBe(true);
    expect(screen.getByRole('button', { name: 'Hide dashboards' }).className).toMatch(/expanded/);
    expect(within(list()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Overview', 'Capacity and flows']);
  });

  it('starts collapsed when the store says so', () => {
    signIn();
    listed([OVERVIEW]);
    useViewStore.setState({ sidebarDashboardsExpanded: false });
    render(<Navigation />);
    expect(screen.getByRole('button', { name: 'Show dashboards' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Overview' })).toBeNull();
  });

  it("lists the store's dashboards in its order, a long name with its full title", () => {
    signIn();
    listed([OVERVIEW, LONG, CAPACITY]);
    render(<Navigation />);
    const items = within(list()).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([OVERVIEW.name, LONG.name, CAPACITY.name]);
    expect(items[1]).toHaveAttribute('title', LONG.name);
    expect(items.every((b) => b.getAttribute('type') === 'button')).toBe(true);
  });

  it('says "No dashboards" once an empty list has loaded, nothing before or on an error', () => {
    signIn();
    useDashboardStore.setState({ listLoaded: false });
    api.list.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<Navigation />);
    expect(within(list()).queryByText('No dashboards')).toBeNull();
    act(() => listed([]));
    rerender(<Navigation />);
    expect(within(list()).getByText('No dashboards')).toBeInTheDocument();
    act(() => useDashboardStore.setState({ loadError: 'The dashboards could not be loaded.' }));
    expect(within(list()).queryByText('No dashboards')).toBeNull();
    expect(within(list()).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('opens the view on the clicked dashboard and marks it current', async () => {
    signIn();
    listed([OVERVIEW, CAPACITY]);
    render(<Navigation />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Capacity and flows' }));
    });
    expect(useViewStore.getState().currentView).toBe('dashboards');
    expect(api.get).toHaveBeenCalledWith(CAPACITY.id);
    expect(useDashboardStore.getState().current?.id).toBe(CAPACITY.id);
    expect(useViewStore.getState().lastDashboardId['']).toBe(CAPACITY.id);
    expect(screen.getByRole('button', { name: 'Capacity and flows' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Dashboards' })).toHaveAttribute('aria-current', 'page');
    // The current one again: nothing to do
    api.get.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Capacity and flows' }));
    expect(api.get).not.toHaveBeenCalled();
  });

  it('marks no dashboard current outside the Dashboards view', () => {
    signIn();
    listed([OVERVIEW]);
    useDashboardStore.setState({ current: full(OVERVIEW) });
    render(<Navigation />);
    expect(screen.getByRole('button', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Gantt Chart' })).toHaveAttribute('aria-current', 'page');
  });

  it('asks the view leave guard first, and opens nothing when it refuses', async () => {
    signIn();
    listed([OVERVIEW, CAPACITY]);
    useViewStore.setState({ currentView: 'dashboards' });
    useDashboardStore.setState({ current: full(OVERVIEW) });
    let answer = false;
    const guard = vi.fn(async () => answer);
    const unregister = setViewLeaveGuard(guard);
    render(<Navigation />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Capacity and flows' }));
    });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(api.get).not.toHaveBeenCalled();
    expect(useDashboardStore.getState().current?.id).toBe(OVERVIEW.id);
    answer = true;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Capacity and flows' }));
    });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenCalledWith(CAPACITY.id);
    expect(useDashboardStore.getState().current?.id).toBe(CAPACITY.id);
    unregister();
  });

  it('disables the dashboards with the What-If reason', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'admin', site_ids: [1, 2] }) });
    listed([OVERVIEW, CAPACITY]);
    useWhatIfStore.getState().enterWhatIfMode([]);
    render(<Navigation />);
    for (const name of ['Overview', 'Capacity and flows']) {
      const item = screen.getByRole('button', { name });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute('title', whatIfUnavailableMessage('Switching views'));
      fireEvent.click(item);
    }
    expect(useViewStore.getState().currentView).toBe('gantt');
    expect(api.get).not.toHaveBeenCalled();
    // The chevron still shows / hides the list
    expect(chevron()).not.toBeDisabled();
  });

  it('loads the list once on mount when the entry is shown and the list is not loaded', async () => {
    signIn();
    api.list.mockResolvedValue([OVERVIEW, CAPACITY]);
    const { rerender } = render(<Navigation />);
    await act(async () => {});
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(within(list()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Overview', 'Capacity and flows']);
    rerender(<Navigation />);
    await act(async () => {});
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('does not reload a list already loaded', () => {
    signIn();
    listed([OVERVIEW]);
    render(<Navigation />);
    expect(api.list).not.toHaveBeenCalled();
  });
});
