/**
 * The dashboards' metric vocabulary on the client (2.1.0): measures,
 * dimension kinds, the measure → valid dimensions matrix, the permission a
 * dimension or an archived filter needs, periods and grains, and the display
 * helpers (numbers, period and dimension labels, colours).
 *
 * The matrix mirrors `app/services/metrics.py` (`MATRIX`, `NEEDS`,
 * `ARCHIVED_NEEDS`, `RELATIVE_PERIODS`, `GRAINS`); the backend writes it to
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
  MetricDimension,
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

export const MEASURES: readonly { key: Measure; label: string; unit: MetricUnit }[] = [
  { key: 'booked_days', label: 'Booked days', unit: 'days' },
  { key: 'booked_weeks', label: 'Booked weeks', unit: 'weeks' },
  { key: 'booking_count', label: 'Bookings', unit: 'count' },
  { key: 'people_booked', label: 'People booked', unit: 'people' },
  { key: 'project_count', label: 'Projects', unit: 'projects' },
  { key: 'project_weeks', label: 'Project weeks', unit: 'weeks' },
  { key: 'project_volume', label: 'Project volume', unit: 'volume' },
  { key: 'phase_count', label: 'Phases', unit: 'phases' },
  { key: 'phase_weeks', label: 'Phase weeks', unit: 'weeks' },
];

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
  { key: 'field', label: 'Project field' },
  { key: 'period', label: 'Period' },
];

const ALL_KINDS: readonly DimensionKind[] = DIMENSION_KINDS.map((d) => d.key);

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

const without = (kinds: readonly DimensionKind[], drop: DimensionKind): DimensionKind[] =>
  kinds.filter((kind) => kind !== drop);

/**
 * Measure → the dimension kinds it can be broken down by. Booking measures
 * take every kind; distinct people and project volumes are not additive over
 * time (no period); phase measures add the phase type.
 */
export const MATRIX: Readonly<Record<Measure, readonly DimensionKind[]>> = {
  booked_days: ALL_KINDS,
  booked_weeks: ALL_KINDS,
  booking_count: ALL_KINDS,
  people_booked: without(ALL_KINDS, 'period'),
  project_count: PROJECT_KINDS,
  project_weeks: PROJECT_KINDS,
  project_volume: without(PROJECT_KINDS, 'period'),
  phase_count: [...PROJECT_KINDS, 'phase_type'],
  phase_weeks: [...PROJECT_KINDS, 'phase_type'],
};

/**
 * The measures that count bookings (`BOOKING_MEASURES` on the server): only
 * they know the booked person, so only they take the Teams (the person's
 * teams) and People filters — the server refuses those on any other measure.
 */
export const BOOKING_MEASURES: ReadonlySet<Measure> = new Set<Measure>([
  'booked_days',
  'booked_weeks',
  'booking_count',
  'people_booked',
]);

/** Whether `measure` can be broken down by `kind`. */
export function isValidDimension(measure: Measure, kind: DimensionKind): boolean {
  return MATRIX[measure].includes(kind);
}

/** The key a dimension needs on top of `views.dashboards` (the per-person load is gated by `views.staff`). */
export function dimensionNeeds(kind: DimensionKind): PermissionKey | null {
  return kind === 'person' ? 'views.staff' : null;
}

/** The key an `archived: include | only` filter needs. */
export const ARCHIVED_NEEDS: PermissionKey = 'views.archived';

/** The key an archived mode needs (`exclude`, the default, needs none). */
export function archivedNeeds(mode: 'exclude' | 'include' | 'only' | undefined): PermissionKey | null {
  return mode === 'include' || mode === 'only' ? ARCHIVED_NEEDS : null;
}

export const RELATIVE_PERIODS: readonly { key: RelativePeriod; label: string }[] = [
  { key: 'this_year', label: 'This year' },
  { key: 'last_year', label: 'Last year' },
  { key: 'this_quarter', label: 'This quarter' },
  { key: 'last_quarter', label: 'Last quarter' },
  { key: 'last_12_months', label: 'Last 12 months' },
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
  percent: '',
};

/** The unit a query's result comes in: the measure's, or `percent` with a percentage. */
export function queryUnit(query: { measure: Measure; percent_of?: string | null }): MetricUnit {
  if (query.percent_of) return 'percent';
  return MEASURES.find((m) => m.key === query.measure)?.unit ?? 'count';
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
      // count, people, projects, phases: whole numbers
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
