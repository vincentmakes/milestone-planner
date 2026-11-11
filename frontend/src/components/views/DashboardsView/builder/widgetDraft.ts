/**
 * The dashboard builder's pure rules (2.3.0): the draft shapes, the widget
 * kind rules, the cleaned query a widget stores, where a new widget lands on
 * the grid, and a key-order-free comparison of drafts.
 *
 * Kind rules (the ruling of the plan): a KPI has at most one dimension, and
 * only together with *Percent of = Total* (it then shows one value's share,
 * `options.kpi_bucket`) — except a KPI of a measure that takes no percentage
 * (utilisation, available days: `NO_PERCENT_MEASURES`), which has no
 * dimension and shows the weighted total; a pie has exactly one (never of
 * available days, which can be negative); bar, line and table up to two. The
 * measure → dimension and → filter matrices (`utils/metrics.ts`) decide which
 * dimensions and filters a measure accepts. The server stays the judge: a
 * query it refuses is a 422 in plain words, shown by the editor's preview.
 *
 * The four kinds of round 4: a gauge has no dimension (it shows the total
 * against an optional `options.target`, finite and ≥ 0); a heatmap exactly
 * two (a period allowed, it becomes the x axis); a treemap one or two and a
 * sankey exactly two, neither of them with a period (`normaliseQuery` drops
 * it) nor of a ratio measure (`NO_PERCENT_MEASURES`: its values cannot be
 * added up into boxes or flows — `RATIO_HIERARCHY_PROBLEM`). The server
 * enforces none of the dimension counts; the builder refuses them.
 *
 * A calculated widget (2.6.0, `query.divide_by`) divides a summed or counted
 * measure by another (`isDivisible`), each with its own filters, over the
 * numerator's period: only a KPI, a gauge (no dimension), a bar or a line
 * (no dimension, or one period dimension both measures accept) offer it
 * (`RATIO_KINDS`), never with *Percent of*, *Top N* or a stack. A KPI and a
 * gauge keep a target, and may show their value as a percentage of it
 * (`percent_of_target`, only with a target above 0).
 */

import type {
  DashboardVisibility,
  DashboardWidget,
  DimensionKind,
  Measure,
  MetricDimension,
  MetricDivisor,
  MetricFilters,
  MetricQuery,
  WidgetKind,
  WidgetLayout,
  WidgetOptions,
} from '@/types';
import {
  dimensionNeeds,
  filterNeeds,
  isDivisible,
  isValidDimension,
  NO_PERCENT_MEASURES,
  queryUnit,
  takesFilter,
} from '@/utils/metrics';
import type { FilterKey } from '@/utils/metrics';
import type { PermissionKey } from '@/types/permissions';
import { gaugeTarget } from '../charts/toOption';

/** A widget of the draft: `id` only for a widget the server already holds. */
export type DraftWidget = Omit<DashboardWidget, 'id' | 'sort_order'> & {
  id?: number;
  sort_order?: number;
  /** Stable id on the client: `w<id>` for a saved widget, `n<k>` for a new one */
  clientId: string;
};

/**
 * A dashboard's name, description and sharing: what the dashboard dialog
 * edits (and, in edit mode, the inline name / description fields). The four
 * target lists mean something only for `shared`; a save sends them empty
 * otherwise.
 */
export interface DashboardMeta {
  name: string;
  description: string | null;
  visibility: DashboardVisibility;
  role_ids: number[];
  site_ids: number[];
  team_ids: number[];
  user_ids: number[];
}

/** The four target lists of a dashboard's sharing. */
export const TARGET_KEYS = ['role_ids', 'site_ids', 'team_ids', 'user_ids'] as const;
export type TargetKey = (typeof TARGET_KEYS)[number];

/** Copies of the four target lists (the draft never shares arrays with the store). */
export function copyTargets(meta: Pick<DashboardMeta, TargetKey>): Pick<DashboardMeta, TargetKey> {
  return {
    role_ids: [...meta.role_ids],
    site_ids: [...meta.site_ids],
    team_ids: [...meta.team_ids],
    user_ids: [...meta.user_ids],
  };
}

/** The lists a save sends: as chosen for `shared`, all empty otherwise. */
export function savedTargets(meta: Pick<DashboardMeta, 'visibility' | TargetKey>): Pick<DashboardMeta, TargetKey> {
  if (meta.visibility === 'shared') return copyTargets(meta);
  return { role_ids: [], site_ids: [], team_ids: [], user_ids: [] };
}

/** The builder's draft of a dashboard (`id` undefined for a new one). */
export interface EditorDraft extends DashboardMeta {
  id?: number;
  widgets: DraftWidget[];
}

/** The most widgets a dashboard holds (`MAX_WIDGETS` on the server). */
export const MAX_WIDGETS = 50;

/** The most dimensions per widget kind. */
export const MAX_DIMENSIONS: Readonly<Record<WidgetKind, number>> = {
  kpi: 1,
  pie: 1,
  bar: 2,
  line: 2,
  table: 2,
  gauge: 0,
  heatmap: 2,
  treemap: 2,
  sankey: 2,
};

/** The fewest dimensions per widget kind (the builder's rule; the server takes fewer). */
export const MIN_DIMENSIONS: Readonly<Record<WidgetKind, number>> = {
  kpi: 0,
  pie: 0,
  bar: 0,
  line: 0,
  table: 0,
  gauge: 0,
  heatmap: 2,
  treemap: 1,
  sankey: 2,
};

/**
 * The kinds that add their values up into boxes (treemap) or flows (sankey):
 * no period dimension (a hierarchy or a flow of periods means nothing) and no
 * ratio measure (`RATIO_HIERARCHY_PROBLEM`).
 */
export const SUMMED_KINDS: ReadonlySet<WidgetKind> = new Set<WidgetKind>(['treemap', 'sankey']);

/** The kinds that may show a calculated widget (`divide_by`): one number, or one per period. */
export const RATIO_KINDS: ReadonlySet<WidgetKind> = new Set<WidgetKind>(['kpi', 'gauge', 'bar', 'line']);

/** The kinds that show one number against an optional target (and may show it as % of the target). */
export const TARGET_KINDS: ReadonlySet<WidgetKind> = new Set<WidgetKind>(['gauge', 'kpi']);

/** Whether a widget of `kind` may divide `measure` by another one. */
export function offersDivide(kind: WidgetKind, measure: Measure): boolean {
  return RATIO_KINDS.has(kind) && isDivisible(measure);
}

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

/** The filters a measure takes (`MEASURE_FILTERS`): the others are dropped. */
function filtersFor<F extends MetricFilters>(measure: Measure, filters: F | undefined): F | undefined {
  if (!filters) return filters;
  const refused = (Object.keys(filters) as FilterKey[]).filter((key) => !takesFilter(measure, key));
  if (refused.length === 0) return filters;
  const rest = { ...filters };
  for (const key of refused) delete rest[key];
  return rest;
}

/**
 * Whether a widget of `kind` on `measure` has no dimension: a gauge never
 * has one, and a KPI of a measure that takes no percentage — or of a
 * calculated widget (`divided`) — shows its total.
 */
export function noDimensionKind(kind: WidgetKind, measure: Measure, divided = false): boolean {
  return MAX_DIMENSIONS[kind] === 0 || (kind === 'kpi' && (divided || NO_PERCENT_MEASURES.has(measure)));
}

/** The divisor's own filters made valid for its measure (it never has a period: the numerator's applies). */
function divisorFilters(divisor: MetricDivisor): MetricDivisor['filters'] {
  const filters = filtersFor(divisor.measure, { ...(divisor.filters ?? {}) } as MetricFilters);
  if (!filters) return {};
  const rest = { ...filters };
  delete rest.period;
  return rest;
}

/**
 * A calculated query made consistent: kept only on a kind that offers it and
 * two divisible measures; then no dimension but one period both measures
 * accept (none on a KPI or a gauge), no percentage, no top N, and the
 * divisor's filters those its measure takes.
 */
function normaliseDivided(kind: WidgetKind, query: MetricQuery): MetricQuery | null {
  const divisor = query.divide_by;
  if (!divisor) return null;
  if (!offersDivide(kind, query.measure) || !isDivisible(divisor.measure)) return null;
  const dimensions = (query.dimensions ?? [])
    .filter((d) => d.kind === 'period' && isValidDimension(query.measure, 'period') && isValidDimension(divisor.measure, 'period'))
    .slice(0, noDimensionKind(kind, query.measure, true) ? 0 : 1);
  const filters = filtersFor(query.measure, query.filters);
  return {
    ...query,
    ...(filters ? { filters } : {}),
    dimensions,
    percent_of: null,
    top_n: null,
    divide_by: { ...divisor, filters: divisorFilters(divisor) },
  };
}

/** The former name of `noDimensionKind` (a KPI was the only kind without a dimension). */
export const kpiWithoutDimension = noDimensionKind;

/**
 * The query made consistent with the widget kind and the measure: extra
 * dimensions and refused ones dropped (a period too on a treemap or a
 * sankey), the filters the measure does not take dropped (a measure of
 * another family), a KPI with a dimension shows a share of the total — a
 * gauge, and a KPI of a measure that takes no percentage, have no dimension
 * —, a percentage needs its dimensions and a measure that takes one (and is
 * of the total on a treemap or a sankey), Top N
 * needs a first dimension that is not a period.
 */
export function normaliseQuery(kind: WidgetKind, query: MetricQuery): MetricQuery {
  const divided = normaliseDivided(kind, query);
  if (divided) return divided;
  if (query.divide_by) {
    // A kind or a measure that does not divide: the plain widget of the numerator.
    const plain = { ...query };
    delete plain.divide_by;
    return normaliseQuery(kind, plain);
  }
  const noPercent = NO_PERCENT_MEASURES.has(query.measure);
  const dimensions = (query.dimensions ?? [])
    .filter((d) => isValidDimension(query.measure, d.kind))
    .filter((d) => !(SUMMED_KINDS.has(kind) && d.kind === 'period'))
    .slice(0, noDimensionKind(kind, query.measure) ? 0 : MAX_DIMENSIONS[kind]);
  let percentOf = query.percent_of ?? null;
  if (dimensions.length === 0 || noPercent) percentOf = null;
  else if (kind === 'kpi') percentOf = 'total';
  // A share within each first-dimension value draws every parent box or left
  // node the same size: a treemap or a sankey takes a share of the total only.
  else if (percentOf === 'first_dimension' && (dimensions.length < 2 || SUMMED_KINDS.has(kind))) percentOf = null;
  const topN = dimensions.length === 0 || dimensions[0].kind === 'period' ? null : query.top_n ?? null;
  const filters = filtersFor(query.measure, query.filters);
  return { ...query, ...(filters ? { filters } : {}), dimensions, percent_of: percentOf, top_n: topN };
}

/** The query after a change of measure: dimensions and filters the new measure refuses are dropped. */
export function changeMeasure(kind: WidgetKind, query: MetricQuery, measure: Measure): MetricQuery {
  return normaliseQuery(kind, { ...query, measure });
}

/**
 * The query without the dimensions and filters its measure lets the user
 * not use (`dimensionNeeds` / `filterNeeds` with the measure): after a
 * switch to a capacity measure, Person and People go without
 * `absences.view_others` (the editor no longer shows them).
 */
export function dropUnheld(query: MetricQuery, holds: (key: PermissionKey | null) => boolean): MetricQuery {
  const dimensions = (query.dimensions ?? []).filter((d) => holds(dimensionNeeds(d.kind, query.measure)));
  const source = query.filters ?? {};
  const refused = (Object.keys(source) as FilterKey[]).filter((key) => !holds(filterNeeds(key, query.measure)));
  const divisor = query.divide_by;
  const divisorSource = divisor?.filters ?? {};
  const divisorRefused = divisor
    ? (Object.keys(divisorSource) as FilterKey[]).filter((key) => !holds(filterNeeds(key, divisor.measure)))
    : [];
  if (refused.length === 0 && divisorRefused.length === 0 && dimensions.length === (query.dimensions ?? []).length) {
    return query;
  }
  const filters = { ...source };
  for (const key of refused) delete filters[key];
  const next: MetricQuery = { ...query, dimensions, filters };
  if (divisor && divisorRefused.length > 0) {
    const kept = { ...divisorSource };
    for (const key of divisorRefused) delete kept[key as keyof typeof kept];
    next.divide_by = { ...divisor, filters: kept };
  }
  return next;
}

/** A decimal number as typed: digits, with a decimal point or comma ("85", "12,5", ".5"). */
const DECIMAL_TEXT = /^(\d+([.,]\d*)?|[.,]\d+)$/;

/**
 * The gauge target a typed text stands for, or `null` when it stands for none:
 * an empty field, text that is not a plain decimal number ("abc", "85x",
 * "-5", "1e3", "0x10") or a number past `MAX_GAUGE_TARGET` (`gaugeTarget`).
 */
export function parseTarget(text: string): number | null {
  const trimmed = text.trim();
  if (!DECIMAL_TEXT.test(trimmed)) return null;
  return gaugeTarget(Number(trimmed.replace(',', '.')));
}

/**
 * The options a widget stores: only those its kind uses, and only when they
 * differ from the renderer's default (bar: stacked, 100 % — which implies
 * stacked —, horizontal; line: legend off; pie: legend on; KPI share: the
 * bucket), plus the number format (*Percent* only on a percentage). A bar
 * of a measure that takes no percentage (`NO_PERCENT_MEASURES`: a ratio, a
 * signed number, a per-bucket count), or of a calculated widget, is never
 * stacked nor 100 %: adding ratios up, or sharing out negative days, means
 * nothing. A gauge and a KPI keep their target when it is one (finite, from
 * 0 to `MAX_GAUGE_TARGET`: `gaugeTarget`, the renderer's rule), and *Show as
 * % of target* only with a target above 0.
 */
export function cleanOptions(kind: WidgetKind, query: MetricQuery, options: WidgetOptions): WidgetOptions {
  const clean: WidgetOptions = {};
  if (kind === 'bar') {
    const stackable = !NO_PERCENT_MEASURES.has(query.measure) && !query.divide_by;
    if (stackable && options.percent) clean.percent = true;
    if (stackable && (options.stacked || options.percent)) clean.stacked = true;
    if (options.orientation === 'horizontal') clean.orientation = 'horizontal';
  }
  if (TARGET_KINDS.has(kind)) {
    const target = gaugeTarget(options.target);
    if (target !== null) clean.target = target;
    if (options.percent_of_target && target !== null && target > 0) clean.percent_of_target = true;
  }
  if (kind === 'line' && options.show_legend === false) clean.show_legend = false;
  if (kind === 'pie' && options.show_legend === true) clean.show_legend = true;
  if (kind === 'kpi' && query.percent_of && options.kpi_bucket !== undefined && options.kpi_bucket !== null) {
    clean.kpi_bucket = options.kpi_bucket;
  }
  // "Percent" only formats a percentage (a value shown as % of its target is one): on weeks it would read "12.5 %".
  const percentShown = queryUnit(query) === 'percent' || clean.percent_of_target === true;
  if (options.number_format && (options.number_format !== 'percent' || percentShown)) {
    clean.number_format = options.number_format;
  }
  return clean;
}

/** Why a pie of available days is refused: its values can be negative. */
export const NEGATIVE_PIE_PROBLEM = 'Available days can be negative; choose a bar, line, table or KPI';

/** Why a treemap or a sankey of a ratio measure is refused: its values do not add up. */
export const RATIO_HIERARCHY_PROBLEM =
  'Utilisation, available days and people over capacity cannot be added up into boxes or flows; choose a bar, line, heatmap, table or KPI';

/** What a kind with too few dimensions says. */
const TOO_FEW_DIMENSIONS: Partial<Record<WidgetKind, string>> = {
  heatmap: 'A heatmap needs two dimensions.',
  sankey: 'A sankey needs two dimensions.',
  treemap: 'A treemap needs one or two dimensions.',
};

/** Why a query cannot be previewed or saved yet (client-side), or null. */
export function queryProblem(kind: WidgetKind, query: MetricQuery): string | null {
  const dimensions = query.dimensions ?? [];
  if (kind === 'pie' && query.measure === 'available_days') return NEGATIVE_PIE_PROBLEM;
  if (SUMMED_KINDS.has(kind) && NO_PERCENT_MEASURES.has(query.measure)) return RATIO_HIERARCHY_PROBLEM;
  if (dimensions.length < MIN_DIMENSIONS[kind]) return TOO_FEW_DIMENSIONS[kind] ?? null;
  if (kind === 'pie' && dimensions.length !== 1) return 'A pie chart needs one dimension.';
  if (kind === 'kpi' && dimensions.length > 0 && query.percent_of !== 'total') {
    return 'A KPI with a dimension shows a share: set Percent of to Total.';
  }
  const period = query.filters?.period;
  if (period && 'from' in period && (!period.from || !period.to)) return 'Choose the start and end of the period.';
  return null;
}

const LIST_FILTERS = [
  'site_ids',
  'team_ids',
  'project_team_ids',
  'person_ids',
  'project_ids',
  'tag_ids',
  'equipment_ids',
] as const;

/** Filters as stored: empty ones and defaults (archived `exclude`, milestones `include`) left out, without the period. */
function cleanFilters(source: MetricFilters): MetricFilters {
  const filters: MetricFilters = {};
  for (const key of LIST_FILTERS) {
    const ids = source[key];
    if (ids && ids.length > 0) filters[key] = [...ids];
  }
  const fieldOptions = Object.entries(source.field_options ?? {}).filter(([, ids]) => ids.length > 0);
  if (fieldOptions.length > 0) filters.field_options = Object.fromEntries(fieldOptions);
  if (typeof source.confirmed === 'boolean') filters.confirmed = source.confirmed;
  if (source.archived && source.archived !== 'exclude') filters.archived = source.archived;
  if (source.equipment_types && source.equipment_types.length > 0) filters.equipment_types = [...source.equipment_types];
  if (source.milestones && source.milestones !== 'include') filters.milestones = source.milestones;
  if (typeof source.has_customer === 'boolean') filters.has_customer = source.has_customer;
  return filters;
}

/** The query a widget stores and sends: empty filters, defaults and unset fields left out (a divisor's too). */
export function cleanQuery(query: MetricQuery): MetricQuery {
  const source = query.filters ?? {};
  const filters: MetricFilters = { ...cleanFilters(source), period: source.period ?? { relative: 'this_year' } };
  const clean: MetricQuery = { measure: query.measure, filters };
  if (query.dimensions && query.dimensions.length > 0) clean.dimensions = query.dimensions.map((d) => ({ ...d }));
  if (query.percent_of) clean.percent_of = query.percent_of;
  if (query.top_n) clean.top_n = query.top_n;
  if (query.divide_by) {
    const divisor: MetricDivisor = { measure: query.divide_by.measure };
    const divisorClean = cleanFilters(query.divide_by.filters ?? {});
    if (Object.keys(divisorClean).length > 0) divisor.filters = divisorClean;
    if (query.divide_by.result === 'number') divisor.result = 'number';
    clean.divide_by = divisor;
  }
  return clean;
}

/** How many filters (besides the period) a query sets. */
export function activeFilterCount(filters: MetricFilters | undefined): number {
  if (!filters) return 0;
  let count = LIST_FILTERS.filter((key) => (filters[key]?.length ?? 0) > 0).length;
  count += Object.values(filters.field_options ?? {}).filter((ids) => ids.length > 0).length;
  if (typeof filters.confirmed === 'boolean') count += 1;
  if (filters.archived && filters.archived !== 'exclude') count += 1;
  if ((filters.equipment_types?.length ?? 0) > 0) count += 1;
  if (filters.milestones && filters.milestones !== 'include') count += 1;
  if (typeof filters.has_customer === 'boolean') count += 1;
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

/** A new gauge's size per breakpoint. */
export const NEW_GAUGE_SIZE: Readonly<Record<keyof WidgetLayout, Size>> = {
  lg: { w: 3, h: 4 },
  md: { w: 4, h: 4 },
  sm: { w: 4, h: 4 },
};

const BREAKPOINTS: readonly (keyof WidgetLayout)[] = ['lg', 'md', 'sm'];

/** Where a new widget lands: at the left, under every other widget, at the default size of its kind. */
export function placeNewWidget(kind: WidgetKind, widgets: readonly Pick<DraftWidget, 'layout'>[]): WidgetLayout {
  const size = kind === 'kpi' ? NEW_KPI_SIZE : kind === 'gauge' ? NEW_GAUGE_SIZE : NEW_WIDGET_SIZE;
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

const sortedIds = (ids: readonly number[]): number[] => [...ids].sort((a, b) => a - b);

/** A draft without the client-only parts, for comparing with its baseline (target order ignored). */
export function comparableDraft(draft: EditorDraft): unknown {
  return {
    name: draft.name,
    description: draft.description ?? null,
    visibility: draft.visibility,
    role_ids: sortedIds(draft.role_ids),
    site_ids: sortedIds(draft.site_ids),
    team_ids: sortedIds(draft.team_ids),
    user_ids: sortedIds(draft.user_ids),
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
