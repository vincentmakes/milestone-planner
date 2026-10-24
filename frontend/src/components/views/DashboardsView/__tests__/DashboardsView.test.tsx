/**
 * DashboardsView (read mode) over the real dashboardStore with a mocked API:
 * the initial dashboard opens, the picker lists the dashboards grouped by
 * their hint and switches, whom the open one is shared with, Refresh and window focus reload the data, the
 * empty state, the "no longer shared" notice on a 404, the builder slot only
 * for dashboards.manage on wider screens, and the pending live reload
 * dropped when the view leaves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@/api/client';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { useDashboardStore } from '@/stores/dashboardStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { resetAllStores } from '@/stores';
import { makeUser } from '@/test/factories';
import { optionLabel, pickerOptions, pickerTrigger, pickOption } from '@/test/searchableSelect';
import { DashboardsView, EMPTY_TEXT, PHONE_QUERY } from '../DashboardsView';
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

vi.mock('../DashboardGrid', () => ({
  DashboardGrid: ({ widgets, editing }: { widgets: { id: number; title: string }[]; editing: boolean }) => (
    <div data-testid="grid" data-editing={String(editing)}>
      {widgets.map((w) => (
        <p key={w.id}>{w.title}</p>
      ))}
    </div>
  ),
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
  widget_count: 1,
  can_edit: false,
  updated_at: '2026-10-23T10:00:00.000Z',
  ...extra,
});

const LIST = [
  summary(5, 'Team plan', {
    visibility: 'shared',
    role_ids: [2],
    shared_with: { roles: [{ id: 2, name: 'Superuser' }], sites: [], teams: [], users: [] },
    owner_id: 2,
    owner_name: 'Bob Brown',
  }),
  summary(4, 'Zeta', { visibility: 'everyone', owner_id: 2, owner_name: 'Bob Brown' }),
  summary(3, 'My own', { visibility: 'private', owner_id: 1, owner_name: 'Ada Admin' }),
  summary(1, 'Overview', { is_default: true, description: 'The planning at a glance' }),
  summary(6, 'Orphan', { visibility: 'shared' }),
];

const detail = (id: number, extra: Partial<Dashboard> = {}): Dashboard => ({
  ...(LIST.find((d) => d.id === id) ?? summary(id, `Dashboard ${id}`)),
  widgets: [
    {
      id: id * 10,
      kind: 'kpi',
      title: `Widget of ${id}`,
      query: { measure: 'project_count' },
      options: {},
      layout: { lg: { x: 0, y: 0, w: 3, h: 2 }, md: { x: 0, y: 0, w: 4, h: 2 }, sm: { x: 0, y: 0, w: 4, h: 2 } },
      sort_order: 0,
    },
  ],
  ...extra,
});

const picker = () => pickerTrigger(/^Dashboard/);

function mockMatchMedia(phone: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches: phone,
    media: PHONE_QUERY,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => list));
  return {
    set(next: boolean) {
      list.matches = next;
      listeners.forEach((fn) => fn());
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  useViewStore.setState({ lastDashboardId: {}, currentView: 'dashboards' });
  useAppStore.setState({ currentUser: makeUser({ id: 1, role: 'superuser' }) });
  api.list.mockResolvedValue(LIST);
  api.get.mockImplementation(async (id: number) => detail(id));
  api.data.mockResolvedValue({ widgets: {}, loaded_at: '2026-10-23T10:00:00.000Z' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('DashboardsView', () => {
  it('opens the default dashboard first, with its description and widgets', async () => {
    render(<DashboardsView />);
    expect(await screen.findByText('Widget of 1')).toBeInTheDocument();
    expect(screen.getByText('The planning at a glance')).toBeInTheDocument();
    expect(picker()).toHaveTextContent('Overview');
    expect(api.data).toHaveBeenCalledWith(1);
    expect(screen.getByTestId('grid')).toHaveAttribute('data-editing', 'false');
  });

  it('shows whom the open dashboard is shared with, under its description', async () => {
    render(<DashboardsView />);
    await screen.findByText('Widget of 1');
    expect(screen.getByText('Shared with everyone')).toBeInTheDocument();
    pickOption(/^Dashboard/, 'Team plan');
    await screen.findByText('Widget of 5');
    expect(within(screen.getByRole('list', { name: 'Shared with' })).getByText('Superuser')).toBeInTheDocument();
    pickOption(/^Dashboard/, 'My own');
    expect(await screen.findByText('Only you (and administrators)')).toBeInTheDocument();
    pickOption(/^Dashboard/, 'Orphan');
    expect(await screen.findByText('Shared with no one left')).toBeInTheDocument();
  });

  it('reopens the dashboard last opened in this tenant', async () => {
    useViewStore.setState({ lastDashboardId: { '': 4 } });
    render(<DashboardsView />);
    expect(await screen.findByText('Widget of 4')).toBeInTheDocument();
  });

  it('lists the dashboards grouped by where they come from, and switches', async () => {
    render(<DashboardsView />);
    await screen.findByText('Widget of 1');
    const options = pickerOptions(/^Dashboard/);
    expect(options.map(optionLabel)).toEqual(['Overview', 'My own', 'Orphan', 'Team plan', 'Zeta']);
    expect(options.map((o) => o.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Overview Default',
      'My own Mine',
      'Orphan Shared with no one left',
      'Team plan Shared by Bob Brown',
      'Zeta Everyone',
    ]);
    pickOption(/^Dashboard/, 'Team plan');
    expect(await screen.findByText('Widget of 5')).toBeInTheDocument();
    expect(useViewStore.getState().lastDashboardId).toEqual({ '': 5 });
  });

  it('reloads the data on Refresh and on window focus', async () => {
    render(<DashboardsView />);
    await screen.findByText('Widget of 1');
    expect(api.data).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.data).toHaveBeenCalledTimes(2));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(api.data).toHaveBeenCalledTimes(3));
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('reloads the open dashboard’s data instead of reopening it when the view returns', async () => {
    const { unmount } = render(<DashboardsView />);
    await screen.findByText('Widget of 1');
    unmount();
    render(<DashboardsView />);
    await waitFor(() => expect(api.data).toHaveBeenCalledTimes(2));
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('says when no dashboard is shared, with nothing to pick or refresh', async () => {
    api.list.mockResolvedValue([]);
    render(<DashboardsView />);
    expect(await screen.findByText(EMPTY_TEXT)).toBeInTheDocument();
    expect(EMPTY_TEXT).toBe('No dashboard is shared with you yet.');
    expect(picker()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('says the dashboard is no longer shared on a 404', async () => {
    useViewStore.setState({ lastDashboardId: { '': 5 } });
    api.get.mockRejectedValueOnce(new ApiError('Dashboard not found', 404));
    render(<DashboardsView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This dashboard is no longer shared with you');
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('grid')).not.toBeInTheDocument();
  });

  it('says a dashboard has no widgets yet', async () => {
    api.get.mockResolvedValue(detail(1, { widgets: [] }));
    render(<DashboardsView />);
    expect(await screen.findByText('This dashboard has no widgets yet.')).toBeInTheDocument();
  });

  it('says it is loading while the first dashboard opens', async () => {
    let release!: (d: Dashboard) => void;
    api.get.mockReturnValueOnce(new Promise<Dashboard>((r) => (release = r)));
    render(<DashboardsView />);
    expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
    await act(async () => release(detail(1)));
    expect(await screen.findByText('Widget of 1')).toBeInTheDocument();
  });

  it('keeps the builder slot for dashboards.manage', async () => {
    const { container } = render(<DashboardsView />);
    await screen.findByText('Widget of 1');
    expect(container.querySelector('[data-slot="builder-actions"]')).not.toBeNull();
  });

  it('has no builder slot without dashboards.manage', async () => {
    useAppStore.setState({ currentUser: makeUser({ id: 1, role: 'user' }) });
    const { container } = render(<DashboardsView />);
    await screen.findByText('Widget of 1');
    expect(container.querySelector('[data-slot="builder-actions"]')).toBeNull();
  });

  it('is view-only on a phone, and follows the screen width', async () => {
    const media = mockMatchMedia(true);
    const { container } = render(<DashboardsView />);
    await screen.findByText('Widget of 1');
    expect(window.matchMedia).toHaveBeenCalledWith(PHONE_QUERY);
    expect(PHONE_QUERY).toBe('(max-width: 640px)');
    expect(container.querySelector('[data-slot="builder-actions"]')).toBeNull();
    act(() => media.set(false));
    expect(container.querySelector('[data-slot="builder-actions"]')).not.toBeNull();
  });

  it('drops a pending live reload when the view leaves', async () => {
    const { unmount } = render(<DashboardsView />);
    await screen.findByText('Widget of 1');
    vi.useFakeTimers();
    void useDashboardStore.getState().reloadData();
    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.data).toHaveBeenCalledTimes(1);
  });

  it('ignores a list that lands after the view left', async () => {
    let release!: (list: DashboardSummary[]) => void;
    api.list.mockReturnValueOnce(new Promise<DashboardSummary[]>((r) => (release = r)));
    const { unmount } = render(<DashboardsView />);
    unmount();
    await act(async () => release(LIST));
    expect(api.get).not.toHaveBeenCalled();
  });
});
