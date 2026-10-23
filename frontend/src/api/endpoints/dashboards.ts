/**
 * Dashboards API (2.1.0): the dashboards shared with the caller, their
 * widgets, and the metric engine (`/query` for one widget, `/data` for a
 * whole dashboard). Snake_case on both sides, so no field mapping;
 * `transformDashboard` only fills what a widget may lack (options) and keeps
 * the widgets in their `sort_order`.
 *
 * What-If exempt (see ../client.ts): dashboards are configuration and
 * reporting, never part of the sandbox. The reads (`/query`, `/data`) are in
 * the server's broadcast skip list, so a viewer never triggers another's
 * reload.
 */

import { apiDelete, apiGet, apiPost, apiPut } from '../client';
import type {
  Dashboard,
  DashboardData,
  DashboardDraft,
  DashboardSummary,
  DashboardWidget,
  MetricQuery,
  MetricResult,
} from '@/types';

function transformWidget(widget: DashboardWidget): DashboardWidget {
  return { ...widget, options: widget.options ?? {} };
}

/** Normalise a dashboard from the API: options default to `{}`, widgets in order. */
export function transformDashboard(dashboard: Dashboard): Dashboard {
  const widgets = (dashboard.widgets ?? [])
    .map(transformWidget)
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  return { ...dashboard, role_ids: dashboard.role_ids ?? [], widgets };
}

export const dashboardsApi = {
  /** The dashboards the caller may open: the default first, then by name. */
  list: () => apiGet<DashboardSummary[]>('/api/dashboards'),

  /** One dashboard with its widgets (404 "Dashboard not found" when not shared with the caller). */
  get: (id: number) => apiGet<Dashboard>(`/api/dashboards/${id}`).then(transformDashboard),

  /** Create (`dashboards.manage`); `source_id` copies a visible dashboard's widgets. */
  create: (draft: DashboardDraft) => apiPost<Dashboard>('/api/dashboards', draft).then(transformDashboard),

  /** Replace the fields (and the widgets when `widgets` is given). */
  update: (id: number, draft: DashboardDraft) =>
    apiPut<Dashboard>(`/api/dashboards/${id}`, draft).then(transformDashboard),

  remove: (id: number) => apiDelete<void>(`/api/dashboards/${id}`),

  /** One metric query (the builder's preview); 422 with the refusal in plain words. */
  query: (query: MetricQuery) => apiPost<MetricResult>('/api/dashboards/query', query),

  /** Every widget's result (or `{error}`), keyed by widget id. */
  data: (id: number) => apiPost<DashboardData>(`/api/dashboards/${id}/data`),
};
