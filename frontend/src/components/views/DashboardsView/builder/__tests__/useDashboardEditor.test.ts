/**
 * useDashboardEditor over the real dashboardStore with a mocked API: the
 * draft of an open or a new dashboard, dirty tracking (key order ignored),
 * the grid's layouts mapped back onto the widgets (a report that moves
 * nothing is ignored), widgets added / replaced / removed with their
 * previews, the inline meta (`setMeta` takes a part), a widget save that
 * sends no sharing (the New POST does), the discard confirm, save success and failure, the
 * store's editing flag and the view's leave guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ApiError } from '@/api/client';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { useDashboardStore } from '@/stores/dashboardStore';
import { stubConfirm } from '@/test/confirmDialog';
import { viewLeaveGuard } from '@/utils/viewLeaveGuard';
import type { Dashboard, DashboardWidget, MetricResult, WidgetLayout } from '@/types';
import { DISCARD_CONFIRM, plainError, useDashboardEditor } from '../useDashboardEditor';
import type { DraftWidget } from '../widgetDraft';

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

const layout = (y: number): WidgetLayout => ({
  lg: { x: 0, y, w: 6, h: 5 },
  md: { x: 0, y, w: 4, h: 5 },
  sm: { x: 0, y, w: 4, h: 5 },
});

const widget = (id: number, y = 0): DashboardWidget => ({
  id,
  kind: 'bar',
  title: `Widget ${id}`,
  query: { measure: 'booked_weeks', filters: { period: { relative: 'this_year' } } },
  options: {},
  layout: layout(y),
  sort_order: 0,
});

const dashboard = (extra: Partial<Dashboard> = {}): Dashboard => ({
  id: 7,
  name: 'Team plan',
  description: null,
  visibility: 'shared',
  role_ids: [3, 2],
  site_ids: [5],
  team_ids: [8, 6],
  user_ids: [4],
  shared_with: { roles: [], sites: [], teams: [], users: [] },
  owner_id: 1,
  owner_name: 'Ada',
  is_default: false,
  widget_count: 2,
  can_edit: true,
  updated_at: '2026-10-23T10:00:00.000Z',
  widgets: [widget(11, 0), widget(12, 5)],
  ...extra,
});

const metric = (total: number): MetricResult => ({
  unit: 'weeks',
  dimensions: [],
  rows: [{ keys: [], value: total }],
  total,
  truncated: false,
  warnings: [],
});

const newWidget = (clientId: string, y = 10): DraftWidget => ({
  clientId,
  kind: 'kpi',
  title: 'New KPI',
  query: { measure: 'project_count', filters: { period: { relative: 'this_year' } } },
  options: {},
  layout: layout(y),
});

beforeEach(() => {
  vi.clearAllMocks();
  useDashboardStore.getState().reset();
  api.list.mockResolvedValue([]);
  api.data.mockResolvedValue({ widgets: {}, loaded_at: '2026-10-23T10:00:00.000Z' });
});

function editing(current: Dashboard | null = dashboard()) {
  const hook = renderHook(({ c }) => useDashboardEditor(c), { initialProps: { c: current } });
  act(() => hook.result.current.startEdit());
  return hook;
}

describe('useDashboardEditor', () => {
  it('starts outside edit mode', () => {
    const { result } = renderHook(() => useDashboardEditor(dashboard()));
    expect(result.current.editing).toBe(false);
    expect(result.current.draft).toBeNull();
    expect(result.current.dirty).toBe(false);
    expect(result.current.gridWidgets).toEqual([]);
    expect(useDashboardStore.getState().editing).toBe(false);
    expect(viewLeaveGuard()).toBeNull();
  });

  it('does nothing on startEdit without a dashboard', () => {
    const { result } = renderHook(() => useDashboardEditor(null));
    act(() => result.current.startEdit());
    expect(result.current.editing).toBe(false);
  });

  it('drafts the open dashboard, unchanged until edited, and flags the store', () => {
    const { result } = editing();
    expect(result.current.editing).toBe(true);
    expect(result.current.dirty).toBe(false);
    expect(result.current.draft?.widgets.map((w) => w.clientId)).toEqual(['w11', 'w12']);
    expect(result.current.gridWidgets.map((w) => [w.id, w.sort_order])).toEqual([
      [11, 0],
      [12, 1],
    ]);
    expect(useDashboardStore.getState().editing).toBe(true);
    expect(viewLeaveGuard()).not.toBeNull();
  });

  it('tracks dirty against what was opened, whatever the key order', () => {
    const { result } = editing();
    // The targets in another order are no change
    act(() => result.current.setMeta({ role_ids: [2, 3], team_ids: [6, 8] }));
    expect(result.current.dirty).toBe(false);
    act(() => result.current.setMeta({ name: 'Renamed' }));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.setMeta({ name: 'Team plan' }));
    expect(result.current.dirty).toBe(false);
    act(() => result.current.setMeta({ user_ids: [] }));
    expect(result.current.dirty).toBe(true);
  });

  it('changes only the part of the meta given', () => {
    const { result } = editing();
    act(() => result.current.setMeta({ description: 'Per team' }));
    expect(result.current.draft).toMatchObject({
      name: 'Team plan',
      description: 'Per team',
      visibility: 'shared',
      role_ids: [3, 2],
      site_ids: [5],
      team_ids: [8, 6],
      user_ids: [4],
    });
  });

  it('ignores setMeta outside edit mode', () => {
    const { result } = renderHook(() => useDashboardEditor(dashboard()));
    act(() => result.current.setMeta({ name: 'Nope' }));
    expect(result.current.draft).toBeNull();
  });

  it('never shares its target lists with the dashboard it drafts', () => {
    const open = dashboard();
    const { result } = editing(open);
    expect(result.current.draft?.site_ids).toEqual(open.site_ids);
    expect(result.current.draft?.site_ids).not.toBe(open.site_ids);
    expect(result.current.draft?.user_ids).not.toBe(open.user_ids);
  });

  it('maps the grid layouts back onto the widgets', () => {
    const { result } = editing();
    const moved: WidgetLayout = { lg: { x: 6, y: 0, w: 6, h: 5 }, md: { x: 4, y: 0, w: 4, h: 5 }, sm: layout(5).sm };
    act(() => result.current.setLayouts({ 11: layout(0), 12: moved }));
    expect(result.current.draft?.widgets[1].layout).toEqual(moved);
    expect(result.current.draft?.widgets[0].layout).toEqual(layout(0));
    expect(result.current.dirty).toBe(true);
  });

  it('ignores a layout report that moves nothing (mount, compaction): same state, not dirty', () => {
    const { result } = editing();
    const before = result.current.draft;
    // The library reports the same positions with its keys in another order
    const reordered = (y: number) => {
      const l = layout(y);
      return {
        lg: { h: l.lg.h, w: l.lg.w, y: l.lg.y, x: l.lg.x },
        md: { h: l.md.h, w: l.md.w, y: l.md.y, x: l.md.x },
        sm: { h: l.sm.h, w: l.sm.w, y: l.sm.y, x: l.sm.x },
      };
    };
    act(() => result.current.setLayouts({ 11: reordered(0), 12: reordered(5), 99: layout(20) }));
    expect(result.current.draft).toBe(before);
    expect(result.current.dirty).toBe(false);
  });

  it('adds a widget with its preview under a negative grid id, replaces and removes it', () => {
    const { result } = editing();
    act(() => result.current.upsertWidget(newWidget('n4'), metric(9)));
    expect(result.current.gridWidgets.map((w) => w.id)).toEqual([11, 12, -4]);
    expect(result.current.gridData[-4]).toEqual(metric(9));
    expect(result.current.widgetByGridId(-4)?.title).toBe('New KPI');
    expect(result.current.widgetByGridId(11)?.clientId).toBe('w11');
    expect(result.current.dirty).toBe(true);

    act(() => result.current.upsertWidget({ ...newWidget('n4'), title: 'Renamed KPI' }, null));
    expect(result.current.gridWidgets.map((w) => w.title)).toEqual(['Widget 11', 'Widget 12', 'Renamed KPI']);
    expect(result.current.gridData[-4]).toBeUndefined();

    act(() => result.current.removeWidget('n4'));
    expect(result.current.gridWidgets.map((w) => w.id)).toEqual([11, 12]);
    expect(result.current.dirty).toBe(false);
  });

  it('shows the stored data of a saved widget until the widget editor replaces it', () => {
    useDashboardStore.setState({ data: { 11: metric(1), 12: metric(2) } });
    const { result } = editing();
    expect(result.current.gridData).toEqual({ 11: metric(1), 12: metric(2) });
    const edited = { ...result.current.draft!.widgets[0], title: 'Edited' };
    act(() => result.current.upsertWidget(edited, metric(5)));
    expect(result.current.gridData).toEqual({ 11: metric(5), 12: metric(2) });
    // Saved without a preview: the stored result no longer matches, none is shown
    act(() => result.current.upsertWidget({ ...result.current.draft!.widgets[1], title: 'Other' }));
    expect(result.current.gridData).toEqual({ 11: metric(5) });
  });

  it('starts a new dashboard dirty, with no widgets', () => {
    const { result } = renderHook(() => useDashboardEditor(dashboard()));
    act(() =>
      result.current.startNew({
        name: 'Mine',
        description: 'Desc',
        visibility: 'private',
        role_ids: [],
        site_ids: [],
        team_ids: [],
        user_ids: [],
      })
    );
    expect(result.current.draft).toEqual({
      name: 'Mine',
      description: 'Desc',
      visibility: 'private',
      role_ids: [],
      site_ids: [],
      team_ids: [],
      user_ids: [],
      widgets: [],
    });
    expect(result.current.dirty).toBe(true);
  });

  it('leaves at once when nothing changed', async () => {
    const confirm = stubConfirm(true);
    const { result } = editing();
    let left = false;
    await act(async () => {
      left = await result.current.cancel();
    });
    expect(left).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(result.current.editing).toBe(false);
    expect(useDashboardStore.getState().editing).toBe(false);
    expect(viewLeaveGuard()).toBeNull();
  });

  it('asks before discarding changes, and stays when refused', async () => {
    const confirm = stubConfirm(false);
    const { result } = editing();
    act(() => result.current.removeWidget('w12'));
    let left = true;
    await act(async () => {
      left = await result.current.cancel();
    });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: DISCARD_CONFIRM.message }));
    expect(confirm).toHaveBeenCalledWith({
      message: 'Discard the changes to this dashboard?',
      destructive: true,
      confirmLabel: 'Discard',
    });
    expect(left).toBe(false);
    expect(result.current.editing).toBe(true);

    confirm.mockResolvedValueOnce(true);
    await act(async () => {
      left = await result.current.cancel();
    });
    expect(left).toBe(true);
    expect(result.current.editing).toBe(false);
  });

  it('asks through the view leave guard while dirty', async () => {
    const confirm = stubConfirm(false);
    const { result } = editing();
    await expect(viewLeaveGuard()!()).resolves.toBe(true);
    act(() => result.current.removeWidget('w11'));
    await expect(viewLeaveGuard()!()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('a widget save sends no sharing', async () => {
    api.update.mockResolvedValue(dashboard());
    const { result } = editing();
    act(() => result.current.upsertWidget(newWidget('n3'), metric(1)));
    // Even a changed sharing in the draft is not sent: only Share... changes it.
    act(() => result.current.setMeta({ visibility: 'private', user_ids: [] }));
    await act(async () => {
      await result.current.save();
    });
    const body = api.update.mock.calls[0][1];
    expect(Object.keys(body).sort()).toEqual(['description', 'name', 'widgets']);
    for (const key of ['visibility', 'role_ids', 'site_ids', 'team_ids', 'user_ids']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('sends the name and description trimmed (a blank description as none)', async () => {
    api.update.mockResolvedValue(dashboard());
    const { result } = editing();
    act(() => result.current.setMeta({ name: '  Spaced  ', description: '   ' }));
    await act(async () => {
      await result.current.save();
    });
    expect(api.update.mock.calls[0][1]).toMatchObject({ name: 'Spaced', description: null });
  });

  it('saves a PUT of the whole dashboard, then leaves edit mode', async () => {
    const saved = dashboard({ widgets: [widget(21, 0)] });
    api.update.mockResolvedValue(saved);
    const { result } = editing();
    act(() => result.current.removeWidget('w12'));
    let returned: Dashboard | null = null;
    await act(async () => {
      returned = await result.current.save();
    });
    expect(returned).toEqual(saved);
    expect(api.update).toHaveBeenCalledWith(7, {
      name: 'Team plan',
      description: null,
      widgets: [
        {
          kind: 'bar',
          title: 'Widget 11',
          query: widget(11).query,
          options: {},
          layout: layout(0),
          sort_order: 0,
        },
      ],
    });
    expect(result.current.editing).toBe(false);
    expect(useDashboardStore.getState().current).toEqual(saved);
    expect(useDashboardStore.getState().editing).toBe(false);
  });

  it('creates a new shared dashboard with a POST carrying its sharing', async () => {
    api.create.mockResolvedValue(dashboard({ id: 9 }));
    const { result } = renderHook(() => useDashboardEditor(null));
    act(() =>
      result.current.startNew({
        name: 'Ours',
        description: null,
        visibility: 'shared',
        role_ids: [4],
        site_ids: [1],
        team_ids: [2],
        user_ids: [3],
      })
    );
    await act(async () => {
      await result.current.save();
    });
    expect(api.create).toHaveBeenCalledWith({
      name: 'Ours',
      description: null,
      visibility: 'shared',
      role_ids: [4],
      site_ids: [1],
      team_ids: [2],
      user_ids: [3],
      widgets: [],
    });
  });

  it('creates a new dashboard with a POST, without targets unless shared', async () => {
    api.create.mockResolvedValue(dashboard({ id: 9, visibility: 'private', role_ids: [] }));
    const { result } = renderHook(() => useDashboardEditor(null));
    act(() =>
      result.current.startNew({
        name: 'Mine',
        description: null,
        visibility: 'private',
        role_ids: [4],
        site_ids: [1],
        team_ids: [2],
        user_ids: [3],
      })
    );
    act(() => result.current.upsertWidget(newWidget('n8', 0), metric(3)));
    await act(async () => {
      await result.current.save();
    });
    expect(api.create).toHaveBeenCalledWith({
      name: 'Mine',
      description: null,
      visibility: 'private',
      role_ids: [],
      site_ids: [],
      team_ids: [],
      user_ids: [],
      widgets: [
        {
          kind: 'kpi',
          title: 'New KPI',
          query: newWidget('n8').query,
          options: {},
          layout: layout(0),
          sort_order: 0,
        },
      ],
    });
    expect(useDashboardStore.getState().current?.id).toBe(9);
  });

  it('stays in edit mode with the server’s words when the save fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.update.mockRejectedValue(new ApiError('body: "Bar": A pie chart needs one dimension', 422));
    const { result } = editing();
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.editing).toBe(true);
    expect(result.current.error).toBe('"Bar": A pie chart needs one dimension');
    expect(result.current.saving).toBe(false);
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it('saves once on a double click', async () => {
    let release!: (d: Dashboard) => void;
    api.update.mockReturnValue(new Promise<Dashboard>((r) => (release = r)));
    const { result } = editing();
    await act(async () => {
      void result.current.save();
      void result.current.save();
    });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(result.current.saving).toBe(true);
    await act(async () => release(dashboard()));
  });

  it('saves nothing outside edit mode', async () => {
    const { result } = renderHook(() => useDashboardEditor(dashboard()));
    await act(async () => {
      expect(await result.current.save()).toBeNull();
    });
    expect(api.update).not.toHaveBeenCalled();
  });

  it('clears the store flag when unmounted while editing', () => {
    const { unmount } = editing();
    expect(useDashboardStore.getState().editing).toBe(true);
    unmount();
    expect(useDashboardStore.getState().editing).toBe(false);
    expect(viewLeaveGuard()).toBeNull();
  });

  it('words an unknown failure plainly', () => {
    expect(plainError(new Error('a, body: b'), 'x')).toBe('a, b');
    expect(plainError(new Error('absolute: A period can cover at most five years'), 'x')).toBe(
      'A period can cover at most five years'
    );
    expect(plainError(new Error('body.filters.period.absolute: A period cannot end before it starts'), 'x')).toBe(
      'A period cannot end before it starts'
    );
    expect(plainError(new Error('body: absolute: Too long'), 'x')).toBe('Too long');
    expect(plainError(new Error('The dashboard could not be saved.'), 'x')).toBe('The dashboard could not be saved.');
    expect(plainError(new Error('"Per week": People booked cannot be broken down by period'), 'x')).toBe(
      '"Per week": People booked cannot be broken down by period'
    );
    expect(plainError(new Error('Widget 2: Top N needs a dimension'), 'x')).toBe('Widget 2: Top N needs a dimension');
    expect(plainError('nope', 'Fallback')).toBe('Fallback');
  });
});
