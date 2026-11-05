/**
 * Dashboards API: each call hits its route with its body, and a dashboard
 * comes back normalised (options default to `{}`, the sharing lists to
 * empty, widgets in `sort_order`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from '@/api/client';
import { dashboardsApi, transformDashboard, transformSummary } from '../dashboards';
import type { Dashboard, DashboardWidget, MetricQuery } from '@/types';

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

const get = vi.mocked(client.apiGet);
const post = vi.mocked(client.apiPost);
const put = vi.mocked(client.apiPut);
const del = vi.mocked(client.apiDelete);

const layout = { lg: { x: 0, y: 0, w: 3, h: 2 }, md: { x: 0, y: 0, w: 4, h: 2 }, sm: { x: 0, y: 0, w: 4, h: 2 } };
const widget = (id: number, sort_order: number, extra: Partial<DashboardWidget> = {}): DashboardWidget => ({
  id,
  kind: 'kpi',
  title: `W${id}`,
  query: { measure: 'project_count' },
  options: {},
  layout,
  sort_order,
  ...extra,
});
const dashboard = (widgets: DashboardWidget[]): Dashboard => ({
  id: 1,
  name: 'Overview',
  description: null,
  visibility: 'everyone',
  role_ids: [],
  site_ids: [],
  team_ids: [],
  user_ids: [],
  shared_with: { roles: [], sites: [], teams: [], users: [] },
  owner_id: null,
  owner_name: null,
  is_default: true,
  widget_count: widgets.length,
  can_edit: false,
  updated_at: '2026-10-23T10:00:00.000Z',
  widgets,
});

beforeEach(() => {
  for (const fn of [get, post, put, del]) fn.mockReset();
});

describe('transformDashboard', () => {
  it('orders the widgets and fills missing options and role ids', () => {
    const raw = {
      ...dashboard([widget(5, 2), widget(4, 1, { options: undefined as never }), widget(3, 1)]),
      role_ids: undefined as never,
    };
    const out = transformDashboard(raw);
    expect(out.widgets.map((w) => w.id)).toEqual([3, 4, 5]);
    expect(out.widgets[1].options).toEqual({});
    expect(out.role_ids).toEqual([]);
  });

  it('fills missing sharing lists and shared_with, and keeps given ones', () => {
    const bare = {
      ...dashboard([]),
      site_ids: undefined as never,
      team_ids: undefined as never,
      user_ids: undefined as never,
      shared_with: undefined as never,
    };
    const out = transformDashboard(bare);
    expect(out).toMatchObject({ site_ids: [], team_ids: [], user_ids: [] });
    expect(out.shared_with).toEqual({ roles: [], sites: [], teams: [], users: [] });

    const partial = transformSummary({
      ...dashboard([]),
      visibility: 'shared' as const,
      site_ids: [2],
      shared_with: { sites: [{ id: 2, name: 'Frankfurt' }] } as never,
    });
    expect(partial.site_ids).toEqual([2]);
    expect(partial.shared_with).toEqual({ roles: [], sites: [{ id: 2, name: 'Frankfurt' }], teams: [], users: [] });
  });

  it('copes with a dashboard without widgets', () => {
    const raw = { ...dashboard([]), widgets: undefined as never };
    expect(transformDashboard(raw).widgets).toEqual([]);
  });
});

describe('dashboardsApi', () => {
  it('lists the dashboards, each row normalised', async () => {
    get.mockResolvedValue([{ ...dashboard([]), user_ids: undefined, shared_with: undefined }]);
    const rows = await dashboardsApi.list();
    expect(get).toHaveBeenCalledWith('/api/dashboards');
    expect(rows[0].user_ids).toEqual([]);
    expect(rows[0].shared_with.users).toEqual([]);
  });

  it('lists the people a dashboard can be shared with', async () => {
    const people = [{ id: 4, name: 'Leo Test', job_title: 'Chemist', site_names: ['Winterthur'] }];
    get.mockResolvedValue(people);
    await expect(dashboardsApi.shareableUsers()).resolves.toEqual(people);
    expect(get).toHaveBeenCalledWith('/api/dashboards/shareable-users');
  });

  it('gets one dashboard, normalised', async () => {
    get.mockResolvedValue(dashboard([widget(2, 1), widget(1, 0)]));
    const out = await dashboardsApi.get(1);
    expect(get).toHaveBeenCalledWith('/api/dashboards/1');
    expect(out.widgets.map((w) => w.id)).toEqual([1, 2]);
  });

  it('creates, updates and deletes', async () => {
    post.mockResolvedValue(dashboard([]));
    put.mockResolvedValue(dashboard([]));
    del.mockResolvedValue({});
    const draft = { name: 'Copy', visibility: 'private' as const, source_id: 1 };
    await dashboardsApi.create(draft);
    expect(post).toHaveBeenCalledWith('/api/dashboards', draft);
    await dashboardsApi.update(1, { name: 'Overview', visibility: 'everyone' });
    expect(put).toHaveBeenCalledWith('/api/dashboards/1', { name: 'Overview', visibility: 'everyone' });
    await dashboardsApi.remove(1);
    expect(del).toHaveBeenCalledWith('/api/dashboards/1');
  });

  it('runs one query and loads a dashboard’s data', async () => {
    post.mockResolvedValue({});
    const query: MetricQuery = { measure: 'booked_weeks', dimensions: [{ kind: 'team' }] };
    await dashboardsApi.query(query);
    expect(post).toHaveBeenCalledWith('/api/dashboards/query', query);
    await dashboardsApi.data(7);
    expect(post).toHaveBeenLastCalledWith('/api/dashboards/7/data');
  });
});
