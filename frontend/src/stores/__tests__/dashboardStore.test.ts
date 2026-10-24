/**
 * dashboardStore: the list (one shared round trip), the initial pick (last
 * opened in this tenant, else the default, else the first), opening a
 * dashboard (widgets, then data), the 2 s trailing debounce of live reloads,
 * the "no longer shared" path on a 404, saves / deletes / copies, and
 * reset() dropping results that land after a sign-out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '@/api/client';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { LIVE_RELOAD_DELAY_MS, NO_LONGER_SHARED, useDashboardStore } from '../dashboardStore';
import { useViewStore } from '../viewStore';
import type { Dashboard, DashboardData, DashboardSummary, MetricResult } from '@/types';

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

const summary = (id: number, extra: Partial<DashboardSummary> = {}): DashboardSummary => ({
  id,
  name: `Dashboard ${id}`,
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

const detail = (id: number, widgetIds: number[] = [11]): Dashboard => ({
  ...summary(id),
  widgets: widgetIds.map((wid, i) => ({
    id: wid,
    kind: 'kpi',
    title: `Widget ${wid}`,
    query: { measure: 'project_count' },
    options: {},
    layout: { lg: { x: 0, y: 0, w: 3, h: 2 }, md: { x: 0, y: 0, w: 4, h: 2 }, sm: { x: 0, y: 0, w: 4, h: 2 } },
    sort_order: i,
  })),
});

const result = (total: number): MetricResult => ({
  unit: 'projects',
  dimensions: [],
  rows: [{ keys: [], value: total }],
  total,
  truncated: false,
  warnings: [],
});

const data = (entries: Record<number, number>, loaded_at = '2026-10-23T10:00:00.000Z'): DashboardData => ({
  widgets: Object.fromEntries(Object.entries(entries).map(([id, total]) => [id, result(total)])),
  loaded_at,
});

const notFound = () => new ApiError('Dashboard not found', 404);

/** A promise and its resolver, to land a response later. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDashboardStore.getState().reset();
  useViewStore.setState({ lastDashboardId: {} });
  window.history.pushState({}, '', '/');
  api.list.mockResolvedValue([summary(1, { is_default: true }), summary(2)]);
  api.get.mockImplementation(async (id: number) => detail(id));
  api.data.mockResolvedValue(data({ 11: 5 }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('refreshList', () => {
  it('loads the list once for concurrent callers', async () => {
    const pending = deferred<DashboardSummary[]>();
    api.list.mockReturnValueOnce(pending.promise);
    const store = useDashboardStore.getState();
    const a = store.refreshList();
    const b = store.refreshList();
    expect(a).toBe(b);
    pending.resolve([summary(3)]);
    await a;
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().dashboards.map((d) => d.id)).toEqual([3]);
    expect(useDashboardStore.getState().listLoaded).toBe(true);
    // A later call is a new round trip
    await useDashboardStore.getState().refreshList();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('says so in place when the list cannot load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.list.mockRejectedValueOnce(new Error('500'));
    await useDashboardStore.getState().refreshList();
    expect(useDashboardStore.getState().loadError).toBe('The dashboards could not be loaded.');
    expect(useDashboardStore.getState().listLoaded).toBe(true);
    expect(error).toHaveBeenCalled();
  });
});

describe('pickInitial', () => {
  it('is null without dashboards', () => {
    expect(useDashboardStore.getState().pickInitial()).toBeNull();
  });

  it('takes the last opened one of this tenant while it is still listed', async () => {
    await useDashboardStore.getState().refreshList();
    useViewStore.setState({ lastDashboardId: { '': 2, acme: 1 } });
    expect(useDashboardStore.getState().pickInitial()).toBe(2);
    window.history.pushState({}, '', '/t/acme/');
    expect(useDashboardStore.getState().pickInitial()).toBe(1);
  });

  it('falls back to the default when the last one is gone', async () => {
    api.list.mockResolvedValue([summary(5), summary(1, { is_default: true })]);
    await useDashboardStore.getState().refreshList();
    useViewStore.setState({ lastDashboardId: { '': 99 } });
    expect(useDashboardStore.getState().pickInitial()).toBe(1);
  });

  it('falls back to the first without a default', async () => {
    api.list.mockResolvedValue([summary(5), summary(6)]);
    await useDashboardStore.getState().refreshList();
    expect(useDashboardStore.getState().pickInitial()).toBe(5);
  });
});

describe('open', () => {
  it('loads the dashboard, then its data, and remembers it for this tenant', async () => {
    await useDashboardStore.getState().open(1);
    const state = useDashboardStore.getState();
    expect(api.get).toHaveBeenCalledWith(1);
    expect(api.data).toHaveBeenCalledWith(1);
    expect(state.current?.id).toBe(1);
    expect(state.data).toEqual({ 11: result(5) });
    expect(state.loadedAt).toBe('2026-10-23T10:00:00.000Z');
    expect(state.loading).toBe(false);
    expect(state.dataLoading).toBe(false);
    expect(useViewStore.getState().lastDashboardId).toEqual({ '': 1 });
  });

  it('keeps a widget error as the widget’s own result', async () => {
    api.data.mockResolvedValue({ widgets: { 11: { error: 'This widget needs the Staff view permission' } }, loaded_at: 'x' });
    await useDashboardStore.getState().open(1);
    expect(useDashboardStore.getState().data[11]).toEqual({ error: 'This widget needs the Staff view permission' });
  });

  it('clears the previous dashboard while another one opens', async () => {
    await useDashboardStore.getState().open(1);
    const pending = deferred<Dashboard>();
    api.get.mockReturnValueOnce(pending.promise);
    const opening = useDashboardStore.getState().open(2);
    expect(useDashboardStore.getState().current).toBeNull();
    expect(useDashboardStore.getState().data).toEqual({});
    expect(useDashboardStore.getState().loading).toBe(true);
    pending.resolve(detail(2));
    await opening;
    expect(useDashboardStore.getState().current?.id).toBe(2);
  });

  it('keeps the dashboard on screen while the same one reopens', async () => {
    await useDashboardStore.getState().open(1);
    const pending = deferred<Dashboard>();
    api.get.mockReturnValueOnce(pending.promise);
    const opening = useDashboardStore.getState().open(1);
    expect(useDashboardStore.getState().current?.id).toBe(1);
    expect(useDashboardStore.getState().data[11]).toEqual(result(5));
    pending.resolve(detail(1));
    await opening;
  });

  it('lets the newest open win', async () => {
    const slow = deferred<Dashboard>();
    api.get.mockReturnValueOnce(slow.promise);
    const first = useDashboardStore.getState().open(1);
    await useDashboardStore.getState().open(2);
    slow.resolve(detail(1));
    await first;
    expect(useDashboardStore.getState().current?.id).toBe(2);
    expect(api.data).toHaveBeenCalledTimes(1);
  });

  it('says the dashboard is no longer shared on a 404, and reloads the list', async () => {
    api.get.mockRejectedValueOnce(notFound());
    await useDashboardStore.getState().open(2);
    const state = useDashboardStore.getState();
    expect(state.loadError).toBe(NO_LONGER_SHARED);
    expect(NO_LONGER_SHARED).toBe('This dashboard is no longer shared with you');
    expect(state.current).toBeNull();
    expect(state.loading).toBe(false);
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.data).not.toHaveBeenCalled();
  });

  it('says so in place when the dashboard cannot load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.get.mockRejectedValueOnce(new ApiError('Boom', 500));
    await useDashboardStore.getState().open(2);
    expect(useDashboardStore.getState().loadError).toBe('This dashboard could not be loaded.');
    expect(useDashboardStore.getState().loading).toBe(false);
    expect(api.list).not.toHaveBeenCalled();
  });

  it('treats a 404 on the data like one on the dashboard', async () => {
    api.data.mockRejectedValueOnce(notFound());
    await useDashboardStore.getState().open(1);
    expect(useDashboardStore.getState().loadError).toBe(NO_LONGER_SHARED);
    expect(useDashboardStore.getState().current).toBeNull();
  });

  it('keeps the last data when a reload fails, and clears the notice on the next success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await useDashboardStore.getState().open(1);
    api.data.mockRejectedValueOnce(new ApiError('Boom', 500));
    await useDashboardStore.getState().reloadData(true);
    expect(useDashboardStore.getState().data[11]).toEqual(result(5));
    expect(useDashboardStore.getState().loadError).toBe('The dashboard data could not be loaded. Try Refresh.');
    expect(useDashboardStore.getState().dataLoading).toBe(false);

    api.data.mockResolvedValueOnce(data({ 11: 8 }));
    await useDashboardStore.getState().reloadData(true);
    expect(useDashboardStore.getState().data[11]).toEqual(result(8));
    expect(useDashboardStore.getState().loadError).toBeNull();
  });

  it('drops a data answer for a dashboard no longer open', async () => {
    await useDashboardStore.getState().open(1);
    const slow = deferred<DashboardData>();
    api.data.mockReturnValueOnce(slow.promise);
    const reload = useDashboardStore.getState().reloadData(true);
    await useDashboardStore.getState().open(2);
    slow.resolve(data({ 11: 99 }));
    await reload;
    expect(useDashboardStore.getState().current?.id).toBe(2);
    expect(useDashboardStore.getState().data[11]).toEqual(result(5));
  });

  it('never labels the newly opened dashboard "no longer shared" for the previous one’s 404', async () => {
    await useDashboardStore.getState().open(1);
    let rejectData!: (err: unknown) => void;
    api.data.mockReturnValueOnce(
      new Promise<DashboardData>((_, reject) => {
        rejectData = reject;
      })
    );
    const reload = useDashboardStore.getState().reloadData(true);
    // B opens while A's data is in flight; B's own read is still pending.
    const slowB = deferred<Dashboard>();
    api.get.mockReturnValueOnce(slowB.promise);
    const openB = useDashboardStore.getState().open(2);
    rejectData(notFound());
    await reload;
    expect(useDashboardStore.getState().loadError).toBeNull();
    slowB.resolve(detail(2));
    await openB;
    const state = useDashboardStore.getState();
    expect(state.current?.id).toBe(2);
    expect(state.loadError).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(0);
  });
});

describe('reloadData', () => {
  it('does nothing without an open dashboard', async () => {
    await useDashboardStore.getState().reloadData(true);
    await useDashboardStore.getState().reloadData();
    expect(api.data).not.toHaveBeenCalled();
  });

  it('debounces live reloads: one load, 2 s after the last call', async () => {
    await useDashboardStore.getState().open(1);
    api.data.mockClear();
    vi.useFakeTimers();
    const store = useDashboardStore.getState();
    void store.reloadData();
    await vi.advanceTimersByTimeAsync(1500);
    void store.reloadData();
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.data).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS - 1500);
    expect(api.data).toHaveBeenCalledTimes(1);
    expect(LIVE_RELOAD_DELAY_MS).toBe(2000);
  });

  it('loads at once when immediate, replacing a pending live reload', async () => {
    await useDashboardStore.getState().open(1);
    api.data.mockClear();
    vi.useFakeTimers();
    void useDashboardStore.getState().reloadData();
    await useDashboardStore.getState().reloadData(true);
    expect(api.data).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS * 2);
    expect(api.data).toHaveBeenCalledTimes(1);
  });

  it('drops a pending live reload when the view leaves', async () => {
    await useDashboardStore.getState().open(1);
    api.data.mockClear();
    vi.useFakeTimers();
    void useDashboardStore.getState().reloadData();
    useDashboardStore.getState().refreshCurrent();
    useDashboardStore.getState().cancelPendingReload();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS * 2);
    expect(api.data).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});

describe('refreshCurrent', () => {
  it('reloads the dashboard itself (new widget ids) and its data after the debounce', async () => {
    await useDashboardStore.getState().open(1);
    vi.useFakeTimers();
    api.get.mockResolvedValueOnce(detail(1, [21, 22]));
    api.data.mockResolvedValueOnce(data({ 21: 1, 22: 2 }));
    useDashboardStore.getState().refreshCurrent();
    void useDashboardStore.getState().reloadData();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(useDashboardStore.getState().current?.widgets.map((w) => w.id)).toEqual([21, 22]);
    expect(useDashboardStore.getState().data).toEqual({ 21: result(1), 22: result(2) });
  });

  it('turns a pending detail reload into an immediate one on Refresh', async () => {
    await useDashboardStore.getState().open(1);
    vi.useFakeTimers();
    useDashboardStore.getState().refreshCurrent();
    await useDashboardStore.getState().reloadData(true);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.data).toHaveBeenCalledTimes(2);
  });

  it('does nothing without an open dashboard', async () => {
    vi.useFakeTimers();
    useDashboardStore.getState().refreshCurrent();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('says the dashboard is no longer shared when it is gone', async () => {
    await useDashboardStore.getState().open(1);
    vi.useFakeTimers();
    api.get.mockRejectedValueOnce(notFound());
    useDashboardStore.getState().refreshCurrent();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS);
    expect(useDashboardStore.getState().loadError).toBe(NO_LONGER_SHARED);
    expect(useDashboardStore.getState().current).toBeNull();
  });

  it('keeps the dashboard and reloads its data when the dashboard read fails otherwise', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await useDashboardStore.getState().open(1);
    vi.useFakeTimers();
    api.get.mockRejectedValueOnce(new ApiError('Boom', 500));
    api.data.mockResolvedValueOnce(data({ 11: 3 }));
    useDashboardStore.getState().refreshCurrent();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS);
    expect(useDashboardStore.getState().current?.id).toBe(1);
    expect(useDashboardStore.getState().data[11]).toEqual(result(3));
    expect(error).toHaveBeenCalled();
  });
});

describe('editing', () => {
  it('never replaces the open dashboard under the builder, and reloads it once editing ends', async () => {
    await useDashboardStore.getState().open(1);
    useDashboardStore.getState().setEditing(true);
    expect(useDashboardStore.getState().editing).toBe(true);
    vi.useFakeTimers();
    api.get.mockResolvedValue(detail(1, [21, 22]));
    api.data.mockResolvedValue(data({ 21: 1, 22: 2 }));
    useDashboardStore.getState().refreshCurrent();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().current?.widgets.map((w) => w.id)).toEqual([11]);
    // The list still refreshes
    await useDashboardStore.getState().refreshList();
    expect(api.list).toHaveBeenCalledTimes(1);
    // Leaving edit mode runs the skipped reload
    useDashboardStore.getState().setEditing(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(useDashboardStore.getState().current?.widgets.map((w) => w.id)).toEqual([21, 22]);
  });

  it('drops a dashboard read that lands after editing began', async () => {
    await useDashboardStore.getState().open(1);
    const pending = deferred<Dashboard>();
    api.get.mockReturnValueOnce(pending.promise);
    vi.useFakeTimers();
    useDashboardStore.getState().refreshCurrent();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS);
    useDashboardStore.getState().setEditing(true);
    pending.resolve(detail(1, [31]));
    await vi.advanceTimersByTimeAsync(0);
    expect(useDashboardStore.getState().current?.widgets.map((w) => w.id)).toEqual([11]);
  });

  it('runs nothing when editing ends without a skipped reload, and ignores a repeated flag', async () => {
    await useDashboardStore.getState().open(1);
    useDashboardStore.getState().setEditing(true);
    useDashboardStore.getState().setEditing(true);
    useDashboardStore.getState().setEditing(false);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('forgets a skipped reload when a save shows the saved dashboard', async () => {
    await useDashboardStore.getState().open(1);
    useDashboardStore.getState().setEditing(true);
    vi.useFakeTimers();
    useDashboardStore.getState().refreshCurrent();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS);
    api.update.mockResolvedValueOnce(detail(1, [41]));
    await useDashboardStore.getState().save({ id: 1, name: 'Dashboard 1', visibility: 'everyone' });
    useDashboardStore.getState().setEditing(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().current?.widgets.map((w) => w.id)).toEqual([41]);
  });

  it('is reset with the store', () => {
    useDashboardStore.getState().setEditing(true);
    useDashboardStore.getState().reset();
    expect(useDashboardStore.getState().editing).toBe(false);
  });
});

describe('save, remove, duplicate', () => {
  it('creates a dashboard and opens it with fresh data', async () => {
    api.create.mockResolvedValue(detail(7, [70]));
    api.data.mockResolvedValue(data({ 70: 4 }));
    const saved = await useDashboardStore.getState().save({ name: 'Mine', visibility: 'private' });
    expect(api.create).toHaveBeenCalledWith({ name: 'Mine', visibility: 'private' });
    expect(saved.id).toBe(7);
    const state = useDashboardStore.getState();
    expect(state.current?.id).toBe(7);
    expect(state.data).toEqual({ 70: result(4) });
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(useViewStore.getState().lastDashboardId).toEqual({ '': 7 });
  });

  it('updates a dashboard by its id', async () => {
    api.update.mockResolvedValue(detail(1, [30]));
    await useDashboardStore.getState().save({ id: 1, name: 'Overview', visibility: 'everyone' });
    expect(api.update).toHaveBeenCalledWith(1, { name: 'Overview', visibility: 'everyone' });
    expect(useDashboardStore.getState().current?.widgets[0].id).toBe(30);
  });

  it('deletes the open dashboard and opens the next pick', async () => {
    await useDashboardStore.getState().open(2);
    api.remove.mockResolvedValue(undefined);
    api.list.mockResolvedValue([summary(1, { is_default: true })]);
    await useDashboardStore.getState().remove(2);
    expect(api.remove).toHaveBeenCalledWith(2);
    expect(useDashboardStore.getState().current?.id).toBe(1);
    expect(useViewStore.getState().lastDashboardId).toEqual({ '': 1 });
  });

  it('deletes the last dashboard and leaves nothing open', async () => {
    await useDashboardStore.getState().open(2);
    api.remove.mockResolvedValue(undefined);
    api.list.mockResolvedValue([]);
    await useDashboardStore.getState().remove(2);
    expect(useDashboardStore.getState().current).toBeNull();
    expect(useViewStore.getState().lastDashboardId).toEqual({ '': null });
  });

  it('deletes another dashboard without touching the open one', async () => {
    await useDashboardStore.getState().open(1);
    api.remove.mockResolvedValue(undefined);
    await useDashboardStore.getState().remove(2);
    expect(useDashboardStore.getState().current?.id).toBe(1);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('copies a dashboard into a new private one shared with no one, and opens it', async () => {
    api.create.mockResolvedValue(detail(8, [80]));
    const copy = await useDashboardStore.getState().duplicate(1, 'Copy of Overview');
    expect(api.create).toHaveBeenCalledWith({
      name: 'Copy of Overview',
      visibility: 'private',
      role_ids: [],
      site_ids: [],
      team_ids: [],
      user_ids: [],
      source_id: 1,
    });
    expect(copy.id).toBe(8);
    expect(useDashboardStore.getState().current?.id).toBe(8);
  });
});

describe('reset', () => {
  it('drops answers that land after a sign-out', async () => {
    const list = deferred<DashboardSummary[]>();
    api.list.mockReturnValueOnce(list.promise);
    const loading = useDashboardStore.getState().refreshList();
    useDashboardStore.getState().reset();
    list.resolve([summary(9)]);
    await loading;
    expect(useDashboardStore.getState().dashboards).toEqual([]);
    expect(useDashboardStore.getState().listLoaded).toBe(false);
  });

  it('drops a pending live reload', async () => {
    await useDashboardStore.getState().open(1);
    api.data.mockClear();
    vi.useFakeTimers();
    void useDashboardStore.getState().reloadData();
    useDashboardStore.getState().reset();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS * 2);
    expect(api.data).not.toHaveBeenCalled();
  });

  it('drops an open and its data that land after a sign-out', async () => {
    const pending = deferred<Dashboard>();
    api.get.mockReturnValueOnce(pending.promise);
    const opening = useDashboardStore.getState().open(1);
    useDashboardStore.getState().reset();
    pending.resolve(detail(1));
    await opening;
    expect(useDashboardStore.getState().current).toBeNull();
    expect(api.data).not.toHaveBeenCalled();
  });
});
