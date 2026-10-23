/**
 * The dashboard builder's pure rules (2.1.0): the draft shapes, the widget
 * kind rules, the cleaned query a widget stores, where a new widget lands on
 * the grid, and a key-order-free comparison of drafts.
 *
 * Kind rules (the ruling of the plan): a KPI has at most one dimension, and
 * only together with *Percent of = Total* (it then shows one value's share,
 * `options.kpi_bucket`); a pie has exactly one; bar, line and table up to
 * two. The measure → dimension matrix (`utils/metrics.ts`) decides which
 * kinds of dimension a measure accepts. The server stays the judge: a query
 * it refuses is a 422 in plain words, shown by the editor's preview.
 */

import type {
  DashboardVisibility,
  DashboardWidget,
  DimensionKind,
  Measure,
  MetricDimension,
  MetricFilters,
  MetricQuery,
  WidgetKind,
  WidgetLayout,
  WidgetOptions,
} from '@/types';
import { BOOKING_MEASURES, MATRIX, queryUnit } from '@/utils/metrics';

/** A widget of the draft: `id` only for a widget the server already holds. */
export type DraftWidget = Omit<DashboardWidget, 'id' | 'sort_order'> & {
  id?: number;
  sort_order?: number;
  /** Stable id on the client: `w<id>` for a saved widget, `n<k>` for a new one */
  clientId: string;
};

/** What the dashboard dialog edits. */
export interface DashboardMeta {
  name: string;
  description: string | null;
  visibility: DashboardVisibility;
  role_ids: number[];
}

/** The builder's draft of a dashboard (`id` undefined for a new one). */
export interface EditorDraft extends DashboardMeta {
  id?: number;
  widgets: DraftWidget[];
}

/** The most widgets a dashboard holds (`MAX_WIDGETS` on the server). */
export const MAX_WIDGETS = 50;

/** The most dimensions per widget kind. */
export const MAX_DIMENSIONS: Readonly<Record<WidgetKind, number>> = { kpi: 1, pie: 1, bar: 2, line: 2, table: 2 };

let lastClientId = 0;

/** A client id for a new widget. */
export function newClientId(): string {
  lastClientId += 1;
  return `n${lastClientId}`;
}

/** A saved widget as a draft widget. */
export function toDraftWidget(widget: DashboardWidget): DraftWidget {
  return { ...widget, clientId: `w${widget.id}` };
}

/** The id a draft widget carries on the grid: its own, or a negative one for a new widget. */
export function gridIdOf(widget: DraftWidget): number {
  if (widget.id !== undefined) return widget.id;
  return -Number(widget.clientId.slice(1));
}

/** The default query of a new widget. */
export function defaultQuery(): MetricQuery {
  return {
    measure: 'booked_weeks',
    dimensions: [],
    filters: { period: { relative: 'this_year' } },
    percent_of: null,
    top_n: null,
  };
}

/** The filters a measure takes: the Teams and People filters only on a booking measure. */
function filtersFor(measure: Measure, filters: MetricFilters | undefined): MetricFilters | undefined {
  if (!filters || BOOKING_MEASURES.has(measure)) return filters;
  if (filters.team_ids === undefined && filters.person_ids === undefined) return filters;
  const rest = { ...filters };
  delete rest.team_ids;
  delete rest.person_ids;
  return rest;
}

/**
 * The query made consistent with the widget kind and the measure: extra
 * dimensions and refused ones dropped, the Teams and People filters dropped
 * off a booking measure, a KPI with a dimension shows a share of the total,
 * a percentage needs its dimensions, Top N needs a first dimension that is
 * not a period.
 */
export function normaliseQuery(kind: WidgetKind, query: MetricQuery): MetricQuery {
  const dimensions = (query.dimensions ?? [])
    .filter((d) => MATRIX[query.measure].includes(d.kind))
    .slice(0, MAX_DIMENSIONS[kind]);
  let percentOf = query.percent_of ?? null;
  if (dimensions.length === 0) percentOf = null;
  else if (kind === 'kpi') percentOf = 'total';
  else if (percentOf === 'first_dimension' && dimensions.length < 2) percentOf = null;
  const topN = dimensions.length === 0 || dimensions[0].kind === 'period' ? null : query.top_n ?? null;
  const filters = filtersFor(query.measure, query.filters);
  return { ...query, ...(filters ? { filters } : {}), dimensions, percent_of: percentOf, top_n: topN };
}

/** The query after a change of measure: dimensions the new measure refuses are dropped. */
export function changeMeasure(kind: WidgetKind, query: MetricQuery, measure: Measure): MetricQuery {
  return normaliseQuery(kind, { ...query, measure });
}

/**
 * The options a widget stores: only those its kind uses, and only when they
 * differ from the renderer's default (bar: stacked, 100 % — which implies
 * stacked —, horizontal; line: legend off; pie: legend on; KPI share: the
 * bucket), plus the number format (*Percent* only on a percentage).
 */
export function cleanOptions(kind: WidgetKind, query: MetricQuery, options: WidgetOptions): WidgetOptions {
  const clean: WidgetOptions = {};
  if (kind === 'bar') {
    if (options.percent) clean.percent = true;
    if (options.stacked || options.percent) clean.stacked = true;
    if (options.orientation === 'horizontal') clean.orientation = 'horizontal';
  }
  if (kind === 'line' && options.show_legend === false) clean.show_legend = false;
  if (kind === 'pie' && options.show_legend === true) clean.show_legend = true;
  if (kind === 'kpi' && query.percent_of && options.kpi_bucket !== undefined && options.kpi_bucket !== null) {
    clean.kpi_bucket = options.kpi_bucket;
  }
  // "Percent" only formats a percentage: on weeks it would read "12.5 %".
  if (options.number_format && (options.number_format !== 'percent' || queryUnit(query) === 'percent')) {
    clean.number_format = options.number_format;
  }
  return clean;
}

/** Why a query cannot be previewed or saved yet (client-side), or null. */
export function queryProblem(kind: WidgetKind, query: MetricQuery): string | null {
  const dimensions = query.dimensions ?? [];
  if (kind === 'pie' && dimensions.length !== 1) return 'A pie chart needs one dimension.';
  if (kind === 'kpi' && dimensions.length > 0 && query.percent_of !== 'total') {
    return 'A KPI with a dimension shows a share: set Percent of to Total.';
  }
  const period = query.filters?.period;
  if (period && 'from' in period && (!period.from || !period.to)) return 'Choose the start and end of the period.';
  return null;
}

const LIST_FILTERS = ['site_ids', 'team_ids', 'project_team_ids', 'person_ids', 'project_ids', 'tag_ids'] as const;

/** The query a widget stores and sends: empty filters and unset fields left out. */
export function cleanQuery(query: MetricQuery): MetricQuery {
  const source = query.filters ?? {};
  const filters: MetricFilters = {};
  for (const key of LIST_FILTERS) {
    const ids = source[key];
    if (ids && ids.length > 0) filters[key] = [...ids];
  }
  const fieldOptions = Object.entries(source.field_options ?? {}).filter(([, ids]) => ids.length > 0);
  if (fieldOptions.length > 0) filters.field_options = Object.fromEntries(fieldOptions);
  if (typeof source.confirmed === 'boolean') filters.confirmed = source.confirmed;
  if (source.archived && source.archived !== 'exclude') filters.archived = source.archived;
  filters.period = source.period ?? { relative: 'this_year' };
  const clean: MetricQuery = { measure: query.measure, filters };
  if (query.dimensions && query.dimensions.length > 0) clean.dimensions = query.dimensions.map((d) => ({ ...d }));
  if (query.percent_of) clean.percent_of = query.percent_of;
  if (query.top_n) clean.top_n = query.top_n;
  return clean;
}

/** How many filters (besides the period) a query sets. */
export function activeFilterCount(filters: MetricFilters | undefined): number {
  if (!filters) return 0;
  let count = LIST_FILTERS.filter((key) => (filters[key]?.length ?? 0) > 0).length;
  count += Object.values(filters.field_options ?? {}).filter((ids) => ids.length > 0).length;
  if (typeof filters.confirmed === 'boolean') count += 1;
  if (filters.archived && filters.archived !== 'exclude') count += 1;
  return count;
}

type Size = { w: number; h: number };

/** A new chart's size per breakpoint (`lg` 12 columns, `md` 8, `sm` 4). */
export const NEW_WIDGET_SIZE: Readonly<Record<keyof WidgetLayout, Size>> = {
  lg: { w: 6, h: 5 },
  md: { w: 4, h: 5 },
  sm: { w: 4, h: 5 },
};

/** A new KPI's size per breakpoint. */
export const NEW_KPI_SIZE: Readonly<Record<keyof WidgetLayout, Size>> = {
  lg: { w: 3, h: 2 },
  md: { w: 4, h: 2 },
  sm: { w: 4, h: 2 },
};

const BREAKPOINTS: readonly (keyof WidgetLayout)[] = ['lg', 'md', 'sm'];

/** Where a new widget lands: at the left, under every other widget, at the default size of its kind. */
export function placeNewWidget(kind: WidgetKind, widgets: readonly Pick<DraftWidget, 'layout'>[]): WidgetLayout {
  const size = kind === 'kpi' ? NEW_KPI_SIZE : NEW_WIDGET_SIZE;
  const layout = {} as WidgetLayout;
  for (const bp of BREAKPOINTS) {
    const y = widgets.reduce((max, w) => Math.max(max, w.layout[bp].y + w.layout[bp].h), 0);
    layout[bp] = { x: 0, y, ...size[bp] };
  }
  return layout;
}

/** JSON with sorted keys: two values that differ only in key order give the same text. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

/** A draft without the client-only parts, for comparing with its baseline. */
export function comparableDraft(draft: EditorDraft): unknown {
  return {
    name: draft.name,
    description: draft.description ?? null,
    visibility: draft.visibility,
    role_ids: [...draft.role_ids].sort((a, b) => a - b),
    widgets: draft.widgets.map(({ kind, title, query, options, layout }) => ({ kind, title, query, options, layout })),
  };
}

/** Whether two layouts hold the same positions. */
export function sameLayout(a: WidgetLayout, b: WidgetLayout): boolean {
  return BREAKPOINTS.every(
    (bp) => a[bp].x === b[bp].x && a[bp].y === b[bp].y && a[bp].w === b[bp].w && a[bp].h === b[bp].h
  );
}

/** A dimension's identity for the pickers (the grain of a period is chosen beside it). */
export function dimensionKey(dimension: MetricDimension): string {
  return dimension.kind === 'field' ? `field:${dimension.field_id}` : dimension.kind;
}

export type { DimensionKind };
