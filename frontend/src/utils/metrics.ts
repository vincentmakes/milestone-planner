/**
 * The dashboards' metric vocabulary on the client (2.1.0): measures and their
 * families, dimension kinds, the measure → valid dimensions and filters
 * matrices, the permission a measure, a dimension or a filter needs, the
 * measures that take no percentage, periods and grains, and the display
 * helpers (numbers, period and dimension labels, colours).
 *
 * The matrix mirrors `app/services/metrics.py` (`MEASURES` with their
 * `FAMILY`, `UNITS`, `MATRIX`, `MEASURE_FILTERS`, `MEASURE_NEEDS`, `NEEDS` /
 * `FILTER_NEEDS` / `ARCHIVED_NEEDS`, `FAMILY_DIMENSION_NEEDS` /
 * `FAMILY_FILTER_NEEDS`, `NO_PERCENT_MEASURES`, `RELATIVE_PERIODS`,
 * `GRAINS`, and the measure / dimension / filter / period labels); the
 * backend writes it to
 * `shared/metric-matrix.json` and `utils/__tests__/metrics.test.ts` fails when
 * this file drifts from it. The server stays the judge (a refused query is a
 * 422 in plain words); the builder uses the matrix to offer only valid
 * choices.
 */

import type {
  DimensionKind,
  Grain,
  InstanceSettings,
  Measure,
  MeasureFamily,
  MetricDimension,
  MetricFilters,
  MetricKey,
  MetricPeriod,
  MetricUnit,
  ProjectField,
  RelativePeriod,
  WidgetOptions,
} from '@/types';
import type { PermissionKey } from '@/types/permissions';
import { builtInFieldLabel, isBuiltInFieldHidden } from './instanceSettings';
import { formatMediumDate } from './date';
import { SKILL_COLOR_SWATCHES } from './colorSwatches';

/** The measure families, in the order the builder groups the measures (`FAMILIES` on the server). */
export const FAMILIES: readonly MeasureFamily[] = ['booking', 'project', 'phase', 'capacity', 'equipment'];

/** A family's name: the group heading of the measure picker. */
export const FAMILY_LABELS: Readonly<Record<MeasureFamily, string>> = {
  booking: 'Bookings',
  project: 'Projects',
  phase: 'Phases',
  capacity: 'Capacity',
  equipment: 'Equipment',
};

/** The public measures in the server's order (families contiguous, in `FAMILIES` order). */
export const MEASURES: readonly { key: Measure; label: string; unit: MetricUnit; family: MeasureFamily }[] = [
  { key: 'booked_days', label: 'Booked days', unit: 'days', family: 'booking' },
  { key: 'booked_weeks', label: 'Booked weeks', unit: 'weeks', family: 'booking' },
  { key: 'booking_count', label: 'Bookings', unit: 'count', family: 'booking' },
  { key: 'people_booked', label: 'People booked', unit: 'people', family: 'booking' },
  { key: 'project_count', label: 'Projects', unit: 'projects', family: 'project' },
  { key: 'project_weeks', label: 'Project weeks', unit: 'weeks', family: 'project' },
  { key: 'project_volume', label: 'Project volume', unit: 'volume', family: 'project' },
  { key: 'phase_count', label: 'Phases', unit: 'phases', family: 'phase' },
  { key: 'phase_weeks', label: 'Phase weeks', unit: 'weeks', family: 'phase' },
  { key: 'phases_due', label: 'Phases due', unit: 'phases', family: 'phase' },
  { key: 'phases_overdue', label: 'Phases overdue', unit: 'phases', family: 'phase' },
  { key: 'capacity_days', label: 'Capacity (days)', unit: 'days', family: 'capacity' },
  { key: 'available_days', label: 'Available days', unit: 'days', family: 'capacity' },
  { key: 'utilisation', label: 'Utilisation', unit: 'percent', family: 'capacity' },
  { key: 'people_over_capacity', label: 'People over capacity', unit: 'people', family: 'capacity' },
  { key: 'equipment_booked_days', label: 'Equipment booked days', unit: 'days', family: 'equipment' },
  { key: 'equipment_booking_count', label: 'Equipment bookings', unit: 'count', family: 'equipment' },
  { key: 'equipment_booked', label: 'Equipment booked', unit: 'equipment', family: 'equipment' },
  { key: 'equipment_utilisation', label: 'Equipment utilisation', unit: 'percent', family: 'equipment' },
];

const MEASURE_BY_KEY: ReadonlyMap<Measure, (typeof MEASURES)[number]> = new Map(MEASURES.map((m) => [m.key, m]));

/** A measure's family (`booking` for a measure the client does not know). */
export function measureFamily(measure: Measure): MeasureFamily {
  return MEASURE_BY_KEY.get(measure)?.family ?? 'booking';
}

/** A measure's name (its key for a measure the client does not know). */
export function measureLabel(measure: Measure): string {
  return MEASURE_BY_KEY.get(measure)?.label ?? measure;
}

/**
 * The measures as `Select` groups, one per family in `FAMILIES` order, the
 * measures in server order; `include` keeps only some (a family left empty
 * is dropped).
 */
export function measuresByFamily(
  include: (measure: Measure) => boolean = () => true
): { label: string; options: { value: Measure; label: string }[] }[] {
  return FAMILIES.map((family) => ({
    label: FAMILY_LABELS[family],
    options: MEASURES.filter((m) => m.family === family && include(m.key)).map((m) => ({ value: m.key, label: m.label })),
  })).filter((group) => group.options.length > 0);
}

export const DIMENSION_KINDS: readonly { key: DimensionKind; label: string }[] = [
  { key: 'site', label: 'Site' },
  { key: 'team', label: 'Team' },
  { key: 'project_team', label: 'Project team' },
  { key: 'person', label: 'Person' },
  { key: 'project', label: 'Project' },
  { key: 'project_manager', label: 'Project manager' },
  { key: 'customer', label: 'Customer' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'tag', label: 'Tag' },
  { key: 'phase_type', label: 'Phase' },
  { key: 'status', label: 'Status' },
  { key: 'equipment', label: 'Equipment' },
  { key: 'equipment_type', label: 'Equipment type' },
  { key: 'field', label: 'Project field' },
  { key: 'period', label: 'Period' },
];

/** The dimensions a project measure accepts (site, project attributes, period). */
const PROJECT_KINDS: readonly DimensionKind[] = [
  'site',
  'project_team',
  'project',
  'project_manager',
  'customer',
  'confirmed',
  'tag',
  'field',
  'period',
];

/** A booking knows the booked person (team, person) and the card (phase type). */
const BOOKING_KINDS: readonly DimensionKind[] = [...PROJECT_KINDS, 'team', 'person', 'phase_type'];

/** A phase has a type and a Kanban status. */
const PHASE_KINDS: readonly DimensionKind[] = [...PROJECT_KINDS, 'phase_type', 'status'];

/** Capacity is a person's: their sites and teams, and time. */
const CAPACITY_KINDS: readonly DimensionKind[] = ['site', 'team', 'person', 'period'];

/** An equipment booking is a project's, of one piece of equipment. */
const EQUIPMENT_BOOKING_KINDS: readonly DimensionKind[] = [...PROJECT_KINDS, 'equipment', 'equipment_type'];

const without = (kinds: readonly DimensionKind[], drop: DimensionKind): DimensionKind[] =>
  kinds.filter((kind) => kind !== drop);

/**
 * Measure → the dimension kinds it can be broken down by. Distinct people,
 * equipment and project volumes are not additive over time (no period);
 * equipment utilisation is the equipment's (its sites, not the project's).
 */
export const MATRIX: Readonly<Record<Measure, readonly DimensionKind[]>> = {
  booked_days: BOOKING_KINDS,
  booked_weeks: BOOKING_KINDS,
  booking_count: BOOKING_KINDS,
  people_booked: without(BOOKING_KINDS, 'period'),
  project_count: PROJECT_KINDS,
  project_weeks: PROJECT_KINDS,
  project_volume: without(PROJECT_KINDS, 'period'),
  phase_count: PHASE_KINDS,
  phase_weeks: PHASE_KINDS,
  phases_due: PHASE_KINDS,
  phases_overdue: PHASE_KINDS,
  capacity_days: CAPACITY_KINDS,
  available_days: CAPACITY_KINDS,
  utilisation: CAPACITY_KINDS,
  people_over_capacity: CAPACITY_KINDS,
  equipment_booked_days: EQUIPMENT_BOOKING_KINDS,
  equipment_booking_count: EQUIPMENT_BOOKING_KINDS,
  equipment_booked: without(EQUIPMENT_BOOKING_KINDS, 'period'),
  equipment_utilisation: ['site', 'equipment', 'equipment_type', 'period'],
};

/** Whether `measure` can be broken down by `kind`. */
export function isValidDimension(measure: Measure, kind: DimensionKind): boolean {
  return MATRIX[measure]?.includes(kind) ?? false;
}

/** A filter of a metric query (the period included). */
export type FilterKey = keyof MetricFilters;

/** Every filter key, in the server's order (`FILTER_KEYS`). */
export const FILTER_KEYS: readonly FilterKey[] = [
  'site_ids',
  'team_ids',
  'project_team_ids',
  'person_ids',
  'project_ids',
  'project_manager_ids',
  'tag_ids',
  'confirmed',
  'field_options',
  'archived',
  'period',
  'equipment_ids',
  'equipment_types',
  'milestones',
];

/** A filter's name (`FILTER_LABELS` on the server; the builder's filter fields). */
export const FILTER_LABELS: Readonly<Record<FilterKey, string>> = {
  site_ids: 'Sites',
  team_ids: 'Teams',
  project_team_ids: 'Project teams',
  person_ids: 'People',
  project_ids: 'Projects',
  project_manager_ids: 'Project managers',
  tag_ids: 'Tags',
  confirmed: 'Confirmed',
  field_options: 'Project fields',
  archived: 'Archived',
  period: 'Period',
  equipment_ids: 'Equipment',
  equipment_types: 'Equipment types',
  milestones: 'Milestones',
};

const filterSet = (...keys: FilterKey[]): readonly FilterKey[] => FILTER_KEYS.filter((key) => keys.includes(key));

const PROJECT_FILTERS: FilterKey[] = [
  'site_ids',
  'project_team_ids',
  'project_ids',
  'project_manager_ids',
  'tag_ids',
  'confirmed',
  'field_options',
  'archived',
  'period',
];
const BOOKING_FILTERS = filterSet(...PROJECT_FILTERS, 'team_ids', 'person_ids');
const PROJECT_ONLY_FILTERS = filterSet(...PROJECT_FILTERS);
const PHASE_FILTERS = filterSet(...PROJECT_FILTERS, 'milestones');
const CAPACITY_FILTERS = filterSet('site_ids', 'team_ids', 'person_ids', 'archived', 'period');
const EQUIPMENT_FILTERS = filterSet(...PROJECT_FILTERS, 'equipment_ids', 'equipment_types');

/**
 * Measure → the filters it takes (the server refuses any other one set to a
 * non-default value): a booking knows the person's teams and the person, a
 * phase its milestone flag, capacity only the person, an equipment booking
 * its equipment; equipment utilisation filters the equipment itself.
 */
export const MEASURE_FILTERS: Readonly<Record<Measure, readonly FilterKey[]>> = {
  booked_days: BOOKING_FILTERS,
  booked_weeks: BOOKING_FILTERS,
  booking_count: BOOKING_FILTERS,
  people_booked: BOOKING_FILTERS,
  project_count: PROJECT_ONLY_FILTERS,
  project_weeks: PROJECT_ONLY_FILTERS,
  project_volume: PROJECT_ONLY_FILTERS,
  phase_count: PHASE_FILTERS,
  phase_weeks: PHASE_FILTERS,
  phases_due: PHASE_FILTERS,
  phases_overdue: PHASE_FILTERS,
  capacity_days: CAPACITY_FILTERS,
  available_days: CAPACITY_FILTERS,
  utilisation: CAPACITY_FILTERS,
  people_over_capacity: CAPACITY_FILTERS,
  equipment_booked_days: EQUIPMENT_FILTERS,
  equipment_booking_count: EQUIPMENT_FILTERS,
  equipment_booked: EQUIPMENT_FILTERS,
  equipment_utilisation: filterSet('site_ids', 'equipment_ids', 'equipment_types', 'archived', 'period'),
};

/** Whether `measure` takes the filter `key`. */
export function takesFilter(measure: Measure, key: FilterKey): boolean {
  return MEASURE_FILTERS[measure]?.includes(key) ?? false;
}

/** The key a measure family needs on top of `views.dashboards` (`MEASURE_NEEDS` on the server). */
const FAMILY_NEEDS: Readonly<Record<MeasureFamily, PermissionKey | null>> = {
  booking: null,
  project: null,
  phase: null,
  capacity: 'views.staff',
  equipment: 'views.equipment',
};

/** The key a measure needs on top of `views.dashboards` (capacity: `views.staff`; equipment: `views.equipment`). */
export function measureNeeds(measure: Measure): PermissionKey | null {
  return FAMILY_NEEDS[measureFamily(measure)];
}

/** The key an `archived: include | only` filter needs. */
export const ARCHIVED_NEEDS: PermissionKey = 'views.archived';

/**
 * The keys a dimension kind or a filter needs, and the archived modes
 * (`needs` of shared/metric-matrix.json: the server's dimension `NEEDS`, its
 * `FILTER_NEEDS` and `archived` in one map).
 */
export const NEEDS: Readonly<Partial<Record<DimensionKind | FilterKey, PermissionKey>>> = {
  person: 'views.staff',
  equipment: 'views.equipment',
  equipment_type: 'views.equipment',
  person_ids: 'views.staff',
  equipment_ids: 'views.equipment',
  equipment_types: 'views.equipment',
  archived: ARCHIVED_NEEDS,
};

/**
 * The keys a dimension kind needs in one family only, on top of `NEEDS`
 * (`FAMILY_DIMENSION_NEEDS` on the server; `dimension_needs` per measure in
 * the JSON): a capacity per person shows that person's absence days, which
 * need `absences.view_others`. Team, site and period stay aggregates.
 */
export const FAMILY_DIMENSION_NEEDS: Readonly<
  Partial<Record<MeasureFamily, Readonly<Partial<Record<DimensionKind, PermissionKey>>>>>
> = {
  capacity: { person: 'absences.view_others' },
};

/** The keys a given filter needs in one family only, on top of `NEEDS` (`FAMILY_FILTER_NEEDS`; `filter_needs`). */
export const FAMILY_FILTER_NEEDS: Readonly<
  Partial<Record<MeasureFamily, Readonly<Partial<Record<FilterKey, PermissionKey>>>>>
> = {
  capacity: { person_ids: 'absences.view_others' },
};

/**
 * The key a dimension needs on top of `views.dashboards` (per-person and
 * equipment loads are gated). With a `measure`, its family's own need wins
 * when there is one (Person on a capacity measure: `absences.view_others`);
 * the common one (`views.staff`) is then the measure's own need, so asking
 * both with and without the measure covers every key.
 */
export function dimensionNeeds(kind: DimensionKind, measure?: Measure): PermissionKey | null {
  const own = measure ? FAMILY_DIMENSION_NEEDS[measureFamily(measure)]?.[kind] : undefined;
  return own ?? NEEDS[kind] ?? null;
}

/**
 * The key a filter needs (People: `views.staff`; Equipment and Equipment
 * types: `views.equipment`; with a capacity `measure`, People:
 * `absences.view_others`); archived see `archivedNeeds`.
 */
export function filterNeeds(key: FilterKey, measure?: Measure): PermissionKey | null {
  if (key === 'archived') return null;
  const own = measure ? FAMILY_FILTER_NEEDS[measureFamily(measure)]?.[key] : undefined;
  return own ?? NEEDS[key] ?? null;
}

/** The key an archived mode needs (`exclude`, the default, needs none). */
export function archivedNeeds(mode: 'exclude' | 'include' | 'only' | undefined): PermissionKey | null {
  return mode === 'include' || mode === 'only' ? ARCHIVED_NEEDS : null;
}

/**
 * The measures that are already a percentage, can be negative, or whose
 * buckets are not parts of the total (people over capacity:
 * `NO_PERCENT_MEASURES`): no *Percent of* on them, and a KPI of one has no
 * dimension (it shows the total).
 */
export const NO_PERCENT_MEASURES: ReadonlySet<Measure> = new Set<Measure>([
  'utilisation',
  'available_days',
  'people_over_capacity',
  'equipment_utilisation',
]);

export const RELATIVE_PERIODS: readonly { key: RelativePeriod; label: string }[] = [
  { key: 'this_year', label: 'This year' },
  { key: 'last_year', label: 'Last year' },
  { key: 'next_year', label: 'Next year' },
  { key: 'this_quarter', label: 'This quarter' },
  { key: 'last_quarter', label: 'Last quarter' },
  { key: 'next_quarter', label: 'Next quarter' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'next_month', label: 'Next month' },
  { key: 'last_12_months', label: 'Last 12 months' },
  { key: 'next_12_months', label: 'Next 12 months' },
  { key: 'all', label: 'All time' },
];

export const GRAINS: readonly { key: Grain; label: string }[] = [
  { key: 'year', label: 'Year' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'month', label: 'Month' },
  { key: 'week', label: 'Week' },
];

/** The unit as a word after a number ("12.5 weeks"); empty for a percentage (the number carries `%`). */
export const UNIT_LABELS: Readonly<Record<MetricUnit, string>> = {
  days: 'days',
  weeks: 'weeks',
  count: 'bookings',
  people: 'people',
  projects: 'projects',
  phases: 'phases',
  volume: 'volume',
  equipment: 'equipment',
  percent: '',
};

/** The unit a query's result comes in: the measure's, or `percent` with a percentage. */
export function queryUnit(query: { measure: Measure; percent_of?: string | null }): MetricUnit {
  if (query.percent_of) return 'percent';
  return MEASURE_BY_KEY.get(query.measure)?.unit ?? 'count';
}

/** The key of the top-N remainder ("Other"). */
export const OTHER_KEY = '__other__';

const THIN_SPACE = ' ';

const fractionDigits = (unit: MetricUnit, format: WidgetOptions['number_format']): [number, number] => {
  if (format === 'integer') return [0, 0];
  if (format === 'decimal') return [2, 2];
  switch (unit) {
    case 'days':
    case 'weeks':
      return [1, 1];
    case 'percent':
      return [0, 1];
    case 'volume':
      return [0, 2];
    default:
      // count, people, projects, phases, equipment: whole numbers
      return [0, 0];
  }
};

/**
 * A metric value for display, in the browser locale: weeks and days with one
 * decimal, counts as integers, volumes with up to two decimals, percentages
 * with up to one decimal and a thin space before `%` ("12.5 %").
 * `options.number_format` overrides the digits (`integer`, `decimal` = two)
 * or shows the value as a percentage.
 */
export function formatMetric(
  value: number | null | undefined,
  unit: MetricUnit,
  options?: Pick<WidgetOptions, 'number_format'> | null
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  const format = options?.number_format ?? null;
  const asPercent = unit === 'percent' || format === 'percent';
  const [min, max] = fractionDigits(asPercent && format === 'percent' ? 'percent' : unit, format === 'percent' ? null : format);
  const text = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  }).format(value);
  return asPercent ? `${text}${THIN_SPACE}%` : text;
}

/** A period for display: the relative period's name, or "1 Jan 2026 – 31 Dec 2026". */
export function periodLabel(period: MetricPeriod | null | undefined): string {
  if (!period) return RELATIVE_PERIODS[0].label;
  if ('relative' in period) {
    return RELATIVE_PERIODS.find((p) => p.key === period.relative)?.label ?? period.relative;
  }
  return resolvedPeriodLabel(period);
}

/** The resolved period of a result (`{from, to}`), shown under a widget title. */
export function resolvedPeriodLabel(period: { from: string; to: string }): string {
  return `${formatMediumDate(period.from)} – ${formatMediumDate(period.to)}`;
}

/**
 * A dimension's name: a project field's own name, the built-in fields
 * (Customer, Confirmed) under their instance labels, a period by its grain.
 */
export function dimensionLabel(
  dimension: MetricDimension,
  fields: readonly Pick<ProjectField, 'id' | 'name'>[],
  settings: InstanceSettings | null | undefined
): string {
  switch (dimension.kind) {
    case 'field':
      return fields.find((f) => f.id === dimension.field_id)?.name ?? 'Project field';
    case 'period':
      return GRAINS.find((g) => g.key === dimension.grain)?.label ?? 'Period';
    case 'customer':
    case 'confirmed':
      return builtInFieldLabel(settings, dimension.kind);
    default:
      return DIMENSION_KINDS.find((d) => d.key === dimension.kind)?.label ?? dimension.kind;
  }
}

/** Whether a dimension kind is hidden instance-wide (a hidden built-in field: Customer). */
export function isDimensionHidden(kind: DimensionKind, settings: InstanceSettings | null | undefined): boolean {
  return kind === 'customer' && isBuiltInFieldHidden(settings, 'customer');
}

/** Colours of the dimension values without one of their own (the chart theme passes its own). */
export const FALLBACK_PALETTE: readonly string[] = SKILL_COLOR_SWATCHES.map((s) => s.value);

/**
 * A dimension value's colour: its own (a team, a tag, a field item), else the
 * palette by position. "Other" takes `otherColor` when given.
 */
export function widgetColor(
  key: MetricKey | null | undefined,
  index: number,
  palette: readonly string[] = FALLBACK_PALETTE,
  otherColor?: string
): string {
  if (key?.color) return key.color;
  if (otherColor && key?.key === OTHER_KEY) return otherColor;
  const colors = palette.length > 0 ? palette : FALLBACK_PALETTE;
  return colors[((index % colors.length) + colors.length) % colors.length];
}

/**
 * A row key or a `kpi_bucket` in one comparable form: numeric strings become
 * numbers and `"true"` / `"false"` booleans, so a bucket stored as `"3"`
 * matches the item id `3` and `"true"` matches Confirmed's `true`.
 */
export function normaliseKey(key: unknown): string | number | boolean | null {
  if (key === null || key === undefined) return null;
  if (typeof key === 'number' || typeof key === 'boolean') return key;
  const text = String(key);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text.trim())) return Number(text);
  return text;
}
