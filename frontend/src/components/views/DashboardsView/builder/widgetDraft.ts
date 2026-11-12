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
 * A calculated widget (2.6.0, `query.formula`) combines named terms — each a
 * summed or counted measure (`isTermMeasure`) with its own filters — with a
 * formula (`utils/formula.ts`), over the widget's period: a KPI and a gauge
 * (no dimension), a bar, a line, a table and a heatmap offer it
 * (`FORMULA_KINDS`; a pie, a treemap and a sankey add their values up, which
 * a formula's do not). A dimension stays while at least one term accepts it
 * (the period only while every term does); a term that refuses it uses its
 * total (`total`). Never with *Percent of* or a stack; *Top N* ranks the
 * formula's values. The top-level measure is the first term's and the
 * top-level filters carry only the period (`normaliseFormula`). A KPI and a
 * gauge keep a target, and may show their value as a percentage of it
 * (`percent_of_target`, only with a target above 0).
 */

import type {
  DashboardVisibility,
  DashboardWidget,
  DimensionKind,
  Measure,
  MetricDimension,
  MetricFilters,
  MetricFormula,
  MetricQuery,
  MetricTerm,
  WidgetKind,
  WidgetLayout,
  WidgetOptions,
} from '@/types';
import {
  dimensionNeeds,
  filterNeeds,
  isTermMeasure,
  isValidDimension,
  measureFamily,
  measureNeeds,
  MEASURES,
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

/** The kinds that may show a calculated widget (`formula`): not those whose values must add up. */
export const FORMULA_KINDS: ReadonlySet<WidgetKind> = new Set<WidgetKind>([
  'kpi',
  'gauge',
  'bar',
  'line',
  'table',
  'heatmap',
]);

/** The kinds that show one number against an optional target (and may show it as % of the target). */
export const TARGET_KINDS: ReadonlySet<WidgetKind> = new Set<WidgetKind>(['gauge', 'kpi']);

/** Whether a widget of `kind` may be a calculation. */
export function offersFormula(kind: WidgetKind): boolean {
  return FORMULA_KINDS.has(kind);
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

/** A term's own filters made valid for its measure (never a period: the widget's applies). */
function termFilters(term: MetricTerm): MetricTerm['filters'] {
  const filters = filtersFor(term.measure, { ...(term.filters ?? {}) } as MetricFilters) ?? {};
  const rest = { ...filters };
  delete rest.period;
  return rest;
}

/** Whether a dimension other than the period is set. */
const splitsBeyondPeriod = (dimensions: readonly MetricDimension[]): boolean =>
  dimensions.some((d) => d.kind !== 'period');

/**
 * A calculated query made consistent, or null when its kind offers none: the
 * measure is the first term's, the top-level filters only the period, no
 * percentage; a dimension stays while at least one term accepts it (the
 * period while every term does); a term that refuses a kept dimension uses
 * its total, and without a dimension beyond the period no term does; each
 * term keeps the filters its measure takes; Top N needs a first dimension
 * that is not a period.
 */
export function normaliseFormula(kind: WidgetKind, query: MetricQuery): MetricQuery | null {
  const formula = query.formula;
  if (!formula || formula.terms.length === 0 || !offersFormula(kind)) return null;
  const terms = formula.terms.map((term) => ({ ...term, filters: termFilters(term) }));
  const dimensions = (query.dimensions ?? [])
    .filter((d) =>
      d.kind === 'period'
        ? terms.every((t) => isValidDimension(t.measure, 'period'))
        : terms.some((t) => isValidDimension(t.measure, d.kind))
    )
    .slice(0, noDimensionKind(kind, terms[0].measure, true) ? 0 : MAX_DIMENSIONS[kind]);
  const split = splitsBeyondPeriod(dimensions);
  const shaped = terms.map((term) => {
    const refuses = dimensions.some((d) => d.kind !== 'period' && !isValidDimension(term.measure, d.kind));
    const next: MetricTerm = { ...term };
    if (split && (refuses || term.total)) next.total = true;
    else delete next.total;
    return next;
  });
  const period = query.filters?.period;
  const topN = dimensions.length === 0 || dimensions[0].kind === 'period' ? null : query.top_n ?? null;
  return {
    ...query,
    measure: shaped[0].measure,
    filters: period ? { period } : {},
    dimensions,
    percent_of: null,
    top_n: topN,
    formula: { ...formula, terms: shaped },
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
  const calculated = normaliseFormula(kind, query);
  if (calculated) return calculated;
  if (query.formula) {
    // A kind that offers no calculation: the plain widget of the first term.
    return normaliseQuery(kind, endFormula(query));
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
  const terms = query.formula?.terms ?? [];
  const termRefused = terms.map((term) =>
    (Object.keys(term.filters ?? {}) as FilterKey[]).filter(
      (key) => !holds(filterNeeds(key)) || !holds(filterNeeds(key, term.measure))
    )
  );
  const anyTermRefused = termRefused.some((keys) => keys.length > 0);
  if (refused.length === 0 && !anyTermRefused && dimensions.length === (query.dimensions ?? []).length) {
    return query;
  }
  const filters = { ...source };
  for (const key of refused) delete filters[key];
  const next: MetricQuery = { ...query, dimensions, filters };
  if (query.formula && anyTermRefused) {
    next.formula = {
      ...query.formula,
      terms: terms.map((term, i) => {
        if (termRefused[i].length === 0) return term;
        const kept = { ...(term.filters ?? {}) };
        for (const key of termRefused[i]) delete kept[key as keyof typeof kept];
        return { ...term, filters: kept };
      }),
    };
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
 * % of target* only with a target above 0; a gauge keeps *Target is a goal*
 * on the same condition.
 */
export function cleanOptions(kind: WidgetKind, query: MetricQuery, options: WidgetOptions): WidgetOptions {
  const clean: WidgetOptions = {};
  if (kind === 'bar') {
    const stackable = !NO_PERCENT_MEASURES.has(query.measure) && !query.formula;
    if (stackable && options.percent) clean.percent = true;
    if (stackable && (options.stacked || options.percent)) clean.stacked = true;
    if (options.orientation === 'horizontal') clean.orientation = 'horizontal';
  }
  if (TARGET_KINDS.has(kind)) {
    const target = gaugeTarget(options.target);
    if (target !== null) clean.target = target;
    if (options.percent_of_target && target !== null && target > 0) clean.percent_of_target = true;
    // Only a gauge draws bands: a goal-gauge keeps the flag (a KPI tile has none).
    if (kind === 'gauge' && options.target_is_goal && target !== null && target > 0) clean.target_is_goal = true;
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
  if (query.formula) clean.formula = cleanFormula(query.formula);
  return clean;
}

/** A formula as stored: each term's empty filters and unset `total` left out, `result` only when a number. */
export function cleanFormula(formula: MetricFormula): MetricFormula {
  const clean: MetricFormula = {
    expression: formula.expression,
    terms: formula.terms.map((term) => {
      const out: MetricTerm = { name: term.name, measure: term.measure };
      const filters = cleanFilters(term.filters ?? {});
      if (Object.keys(filters).length > 0) out.filters = filters;
      if (term.total) out.total = true;
      return out;
    }),
  };
  if (formula.result === 'number') clean.result = 'number';
  return clean;
}

// --- Starting, leaving and the examples of a calculation -----------------------------

/** The measures of booked person time, whose natural partner is the capacity in the same unit. */
const CAPACITY_PARTNER: Partial<Record<Measure, Measure>> = {
  booked_weeks: 'capacity_weeks',
  booked_days: 'capacity_days',
};

/** The first term of a calculation started from a plain query: its measure and filters. */
function firstTermOf(query: MetricQuery): MetricTerm {
  // Utilisation is booked days over capacity days: the calculation starts there.
  const measure: Measure = isTermMeasure(query.measure)
    ? query.measure
    : query.measure === 'utilisation'
      ? 'booked_days'
      : 'booked_weeks';
  const term: MetricTerm = { name: 'a', measure, filters: { ...(query.filters ?? {}) } };
  return { ...term, filters: termFilters(term) };
}

/**
 * The second term beside `first`: the capacity in the same unit for booked
 * person time when the viewer may use it (`canCapacity`: `views.staff`), the
 * same measure otherwise (the result then reads 100 %).
 */
function partnerOf(first: MetricTerm, canCapacity: boolean): MetricTerm {
  const capacity = CAPACITY_PARTNER[first.measure];
  return { name: 'b', measure: capacity && canCapacity ? capacity : first.measure, filters: {} };
}

/**
 * The calculation a plain query starts as: booked person time over the
 * capacity in its unit (`a / b`, a percentage) when the viewer may use it,
 * otherwise the measure alone (`a`, a number) — a valid result either way.
 */
function startingFormula(first: MetricTerm, canCapacity: boolean): MetricFormula {
  const partner = partnerOf(first, canCapacity);
  if (partner.measure === first.measure) return { expression: 'a', terms: [first], result: 'number' };
  return { expression: 'a / b', terms: [first, partner], result: 'percent' };
}

/**
 * A plain query turned into a calculation with nothing to type
 * (`startingFormula`: term `a` is the widget's measure and filters). The
 * kind's rules then apply (`normaliseQuery`).
 */
export function startFormula(kind: WidgetKind, query: MetricQuery, canCapacity: boolean): MetricQuery {
  const first = firstTermOf(query);
  const formula = startingFormula(first, canCapacity);
  const period = query.filters?.period;
  return normaliseQuery(kind, {
    ...query,
    measure: first.measure,
    filters: period ? { period } : {},
    percent_of: null,
    formula,
  });
}

/** A calculation turned back into the plain widget of its first term (its measure and filters). */
export function endFormula(query: MetricQuery): MetricQuery {
  const first = query.formula?.terms[0];
  const plain: MetricQuery = { ...query };
  delete plain.formula;
  if (!first) return plain;
  return {
    ...plain,
    measure: first.measure,
    filters: { ...(first.filters ?? {}), ...(query.filters?.period ? { period: query.filters.period } : {}) },
  };
}

/**
 * Whether a calculation is still the one `startFormula` makes from its first
 * term: leaving it or replacing it by an example loses nothing.
 */
export function isDefaultFormula(query: MetricQuery, canCapacity: boolean): boolean {
  const formula = query.formula;
  if (!formula || formula.terms.length === 0) return true;
  const fresh = startingFormula({ ...formula.terms[0], name: 'a' }, canCapacity);
  const strip = (f: MetricFormula) => {
    const clean = cleanFormula(f);
    return { ...clean, terms: clean.terms.map(({ name, measure, filters }) => ({ name, measure, filters })) };
  };
  return stableKey(strip(formula)) === stableKey(strip(fresh));
}

/** The examples a calculation may start from (the editor's *Examples* menu), each a different formula. */
export const FORMULA_EXAMPLES = [
  { key: 'ratio', label: 'Ratio of two measures', expression: 'a / b' },
  { key: 'capacity_share', label: 'Share of capacity', expression: 'a / b' },
  { key: 'goal', label: 'Against a goal', expression: 'a / (b * 70%)' },
  { key: 'difference', label: 'Difference', expression: 'a - b' },
  { key: 'sum', label: 'Sum', expression: 'a + b' },
] as const;
export type FormulaExampleKey = (typeof FORMULA_EXAMPLES)[number]['key'];

/**
 * The measure *Ratio of two measures* divides a measure by when the
 * calculation has no second measure of its own: a related measure that is
 * not a capacity (*Share of capacity* is the capacity one) — booked weeks
 * per project week, days per booking, weeks per project, ….
 */
const RATIO_PARTNER: Partial<Record<Measure, Measure>> = {
  booked_weeks: 'project_weeks',
  booked_days: 'booking_count',
  booking_count: 'people_booked',
  people_booked: 'project_count',
  project_count: 'people_booked',
  project_weeks: 'project_count',
  project_volume: 'project_count',
  phase_count: 'project_count',
  phase_weeks: 'phase_count',
  phases_due: 'phase_count',
  phases_overdue: 'phase_count',
  capacity_days: 'people_booked',
  capacity_weeks: 'people_booked',
  available_days: 'capacity_days',
  people_over_capacity: 'people_booked',
  equipment_booked_days: 'equipment_booking_count',
  equipment_booking_count: 'equipment_booked',
  equipment_booked: 'equipment_booking_count',
};

const unitOf = (measure: Measure) => MEASURES.find((m) => m.key === measure)?.unit;

/**
 * The calculation of an example, built on the current one (term `a`'s
 * measure and filters):
 *
 * - *Ratio of two measures*: the measure over the calculation's second one
 *   when that is not a capacity, else over `RATIO_PARTNER` (a percentage
 *   when both have one unit, a number otherwise);
 * - *Share of capacity*: booked person time over the capacity in its unit;
 * - *Against a goal*: booked weeks with *Has a customer* over 70 % of the
 *   capacity in weeks — the absorption of the built-in dashboard;
 * - *Difference*: the capacity minus the booked person time (what is free);
 * - *Sum*: phases due plus phases overdue (what needs attention).
 *
 * Only *Ratio* follows the current measure; the others are fixed, so no two
 * examples insert the same formula. `CAPACITY_PARTNER` keeps days with days.
 */
export function exampleFormula(kind: WidgetKind, query: MetricQuery, key: FormulaExampleKey): MetricQuery {
  const example = FORMULA_EXAMPLES.find((e) => e.key === key) ?? FORMULA_EXAMPLES[0];
  const current = query.formula?.terms ?? [];
  const first: MetricTerm = { ...(current[0] ?? firstTermOf(query)), name: 'a' };
  const filters = first.filters ?? {};
  const booked: Measure = first.measure === 'booked_days' ? 'booked_days' : 'booked_weeks';
  const withFilters = (name: string, measure: Measure, extra: MetricTerm['filters'] = {}): MetricTerm => {
    const term: MetricTerm = { name, measure, filters: { ...filters } };
    return { ...term, filters: { ...(termFilters(term) ?? {}), ...extra } };
  };
  let terms: MetricTerm[];
  let result: MetricFormula['result'] = 'percent';
  switch (example.key) {
    case 'capacity_share':
      terms = [withFilters('a', booked), { name: 'b', measure: CAPACITY_PARTNER[booked] ?? 'capacity_weeks', filters: {} }];
      break;
    case 'goal':
      terms = [withFilters('a', 'booked_weeks', { has_customer: true }), { name: 'b', measure: 'capacity_weeks', filters: {} }];
      break;
    case 'difference':
      terms = [{ name: 'a', measure: CAPACITY_PARTNER[booked] ?? 'capacity_weeks', filters: {} }, withFilters('b', booked)];
      result = 'number';
      break;
    case 'sum':
      terms = [withFilters('a', 'phases_due'), withFilters('b', 'phases_overdue')];
      result = 'number';
      break;
    default: {
      const own = current[1];
      const second: MetricTerm =
        own && measureFamily(own.measure) !== 'capacity' && own.measure !== first.measure
          ? { ...own, name: 'b' }
          : { name: 'b', measure: RATIO_PARTNER[first.measure] ?? 'project_count', filters: {} };
      terms = [first, second];
      if (unitOf(first.measure) !== unitOf(second.measure)) result = 'number';
    }
  }
  return normaliseQuery(kind, {
    ...query,
    measure: terms[0].measure,
    formula: { expression: example.expression, terms, result },
  });
}

/** The permission keys an example's measures need (`views.staff` for the capacity, …). */
export function exampleNeeds(kind: WidgetKind, query: MetricQuery, key: FormulaExampleKey): PermissionKey[] {
  const terms = exampleFormula(kind, query, key).formula?.terms ?? [];
  const keys = terms.map((t) => measureNeeds(t.measure)).filter((k): k is PermissionKey => k !== null);
  return [...new Set(keys)];
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
