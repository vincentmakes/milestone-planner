/**
 * Typed readers of the instance settings (appStore.instanceSettings).
 *
 * The backend stores the admin defaults in a canonical form (compact JSON
 * arrays, `true` / `false`, `none` / `staff` / `equipment`) but validates
 * their shape only: a skill may have been deleted or an equipment type
 * renamed since, and rows written before validation may hold anything. So
 * the readers never throw, and the consumers drop ids and names they do not
 * know.
 */

import type { InstanceSettings } from '@/types';

/** The on/off settings: on unless the value is exactly `false`. */
export type SwitchSettingKey =
  | 'show_weekends'
  | 'kanban_enabled'
  | 'nager_enabled'
  | 'new_project_preselect_phases'
  | 'gantt_completion_badges';

export type GanttDefaultPanel = 'none' | 'staff' | 'equipment';

function parseArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A JSON array of ids → its unique positive integers, in order. */
export function parseIdList(value: string | null | undefined): number[] {
  const ids: number[] = [];
  for (const item of parseArray(value)) {
    if (typeof item === 'number' && Number.isInteger(item) && item > 0 && !ids.includes(item)) {
      ids.push(item);
    }
  }
  return ids;
}

/** A JSON array of names → its unique trimmed non-empty strings, in order. */
export function parseNameList(value: string | null | undefined): string[] {
  const names: string[] = [];
  for (const item of parseArray(value)) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Whether a switch is on: anything but `false` (an unloaded or missing value
 * reads as on, every switch's default — the backend's `flag_enabled` rule).
 */
export function isSettingOn(
  settings: InstanceSettings | null | undefined,
  key: SwitchSettingKey
): boolean {
  return settings?.[key] !== 'false';
}

/**
 * Weekends shown on the timelines (the `show_weekends` switch) — the one
 * selector the cell generators use: `useAppStore(selectShowWeekends)`.
 */
export function selectShowWeekends(state: { instanceSettings: InstanceSettings | null }): boolean {
  return isSettingOn(state.instanceSettings, 'show_weekends');
}

/**
 * Saturdays and Sundays are working days (Settings → General → Weekends are
 * working days, 2.5.0). **Not a switch**: it is off by default, so only the
 * value `true` (case-insensitive, trimmed — the backend's
 * `weekends_working_from`) turns it on --
 * never read it with {@link isSettingOn}. The one selector the working-day
 * rule's callers use: `useAppStore(selectWeekendsWorking)`.
 */
export function selectWeekendsWorking(state: { instanceSettings: InstanceSettings | null }): boolean {
  return state.instanceSettings?.weekend_working_days?.trim().toLowerCase() === 'true';
}

/** The overview panel the Gantt opens with; anything unknown is `none`. */
export function ganttDefaultPanel(settings: InstanceSettings | null | undefined): GanttDefaultPanel {
  const value = settings?.gantt_default_panel;
  return value === 'staff' || value === 'equipment' ? value : 'none';
}

// =============================================================================
// BUILT-IN PROJECT FIELDS
// =============================================================================

/** The four fixed project fields whose label an admin can change. */
export type BuiltInFieldKey = 'customer' | 'sales_pm' | 'volume' | 'confirmed';

/** Built-in fields that can be hidden: Confirmed drives the status, ordering and counts. */
export type HideableBuiltInFieldKey = Exclude<BuiltInFieldKey, 'confirmed'>;

/** Display order and default names (Settings → Project fields) of the built-in fields. */
export const BUILT_IN_PROJECT_FIELDS: readonly { key: BuiltInFieldKey; label: string }[] = [
  { key: 'customer', label: 'Customer' },
  { key: 'sales_pm', label: 'Sales PM' },
  { key: 'volume', label: 'Volume' },
  { key: 'confirmed', label: 'Confirmed' },
];

const BUILT_IN_KEYS = BUILT_IN_PROJECT_FIELDS.map((f) => f.key);

/** The default name of each built-in field — the one name used wherever the field is named. */
export const BUILT_IN_FIELD_DEFAULTS = Object.fromEntries(
  BUILT_IN_PROJECT_FIELDS.map((f) => [f.key, f.label])
) as Readonly<Record<BuiltInFieldKey, string>>;

/** The longest label the backend accepts (`MAX_FIELD_LABEL_LENGTH`). */
export const MAX_FIELD_LABEL_LENGTH = 60;

function isBuiltInKey(key: unknown): key is BuiltInFieldKey {
  return typeof key === 'string' && (BUILT_IN_KEYS as string[]).includes(key);
}

/**
 * `project_field_labels` → the custom labels by key (trimmed, non-empty,
 * known keys only). Malformed JSON reads as no custom label.
 */
export function parseFieldLabels(value: string | null | undefined): Partial<Record<BuiltInFieldKey, string>> {
  const labels: Partial<Record<BuiltInFieldKey, string>> = {};
  if (!value) return labels;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return labels;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return labels;
  for (const [key, label] of Object.entries(parsed as Record<string, unknown>)) {
    if (isBuiltInKey(key) && typeof label === 'string' && label.trim()) labels[key] = label.trim();
  }
  return labels;
}

/** `project_fields_hidden` → the hidden built-in fields (never `confirmed`), in display order. */
export function parseHiddenFields(value: string | null | undefined): HideableBuiltInFieldKey[] {
  const listed = new Set(parseArray(value));
  return BUILT_IN_KEYS.filter(
    (key): key is HideableBuiltInFieldKey => key !== 'confirmed' && listed.has(key)
  );
}

/**
 * The name a built-in field shows everywhere it is named: the admin's custom
 * label, else its default (`BUILT_IN_FIELD_DEFAULTS`). A custom label replaces
 * the name entirely — callers never add their own wording around it.
 */
export function builtInFieldLabel(
  settings: InstanceSettings | null | undefined,
  key: BuiltInFieldKey
): string {
  return parseFieldLabels(settings?.project_field_labels)[key] ?? BUILT_IN_FIELD_DEFAULTS[key];
}

/** Whether a built-in field is hidden instance-wide. Confirmed never is. */
export function isBuiltInFieldHidden(
  settings: InstanceSettings | null | undefined,
  key: BuiltInFieldKey
): boolean {
  if (key === 'confirmed') return false;
  return parseHiddenFields(settings?.project_fields_hidden).includes(key);
}

/** The canonical `project_field_labels` value: compact JSON, keys in display order, blanks left out. */
export function fieldLabelsValue(labels: Partial<Record<BuiltInFieldKey, string>>): string {
  const out: Partial<Record<BuiltInFieldKey, string>> = {};
  for (const key of BUILT_IN_KEYS) {
    const label = labels[key]?.trim();
    if (label) out[key] = label;
  }
  return JSON.stringify(out);
}

/** The canonical `project_fields_hidden` value: compact JSON array in display order. */
export function hiddenFieldsValue(keys: Iterable<string>): string {
  const listed = new Set(keys);
  return JSON.stringify(BUILT_IN_KEYS.filter((key) => key !== 'confirmed' && listed.has(key)));
}

/**
 * The decimals the built-in Volume keeps (null = as typed). Missing or
 * malformed reads as the default, 1 -- the backend's `volume_decimals_from`.
 */
export function volumeDecimals(settings: InstanceSettings | null | undefined): number | null {
  const value = settings?.volume_decimals;
  if (value === 'any') return null;
  return value === '0' || value === '2' || value === '3' ? Number(value) : 1;
}

/** The canonical `volume_decimals` value of a decimals count: `any` or `0`–`3`. */
export function volumeDecimalsValue(decimals: number | null): string {
  return decimals === null ? 'any' : String(decimals);
}

// =============================================================================
// GANTT DETAILS (SHIFT + HOVER ON A PROJECT BAR)
// =============================================================================

/** The built-in rows of the project details; the project name is the title, not a row. */
export type TooltipRowKey =
  | 'customer'
  | 'pm'
  | 'sales_pm'
  | 'volume'
  | 'confirmed'
  | 'tags'
  | 'period'
  | 'completion'
  | 'work_days'
  | 'total_days'
  | 'staff';

/** A row of the project details: a built-in row, or a custom project field's id. */
export type TooltipRow = TooltipRowKey | number;

/**
 * The built-in rows in display order with their default captions -- the
 * backend's `PROJECT_TOOLTIP_ROWS`. Custom field rows follow them. Read a
 * caption through {@link tooltipRowLabel} (the built-in fields can be renamed).
 */
export const PROJECT_TOOLTIP_ROWS: readonly { key: TooltipRowKey; label: string }[] = [
  { key: 'customer', label: BUILT_IN_FIELD_DEFAULTS.customer },
  { key: 'pm', label: 'PM' },
  { key: 'sales_pm', label: BUILT_IN_FIELD_DEFAULTS.sales_pm },
  { key: 'volume', label: BUILT_IN_FIELD_DEFAULTS.volume },
  { key: 'confirmed', label: BUILT_IN_FIELD_DEFAULTS.confirmed },
  { key: 'tags', label: 'Tags' },
  { key: 'period', label: 'Period' },
  { key: 'completion', label: 'Completion' },
  { key: 'work_days', label: 'Work days' },
  { key: 'total_days', label: 'Total' },
  { key: 'staff', label: 'Assigned staff' },
];

const TOOLTIP_ROW_KEYS = PROJECT_TOOLTIP_ROWS.map((r) => r.key);
const TOOLTIP_ROW_DEFAULT_LABELS = Object.fromEntries(
  PROJECT_TOOLTIP_ROWS.map((r) => [r.key, r.label])
) as Readonly<Record<TooltipRowKey, string>>;

/** The rows shown until an admin saves the setting (the rows before 2.3.0). */
export const DEFAULT_TOOLTIP_ROWS: readonly TooltipRowKey[] = [
  'customer',
  'pm',
  'confirmed',
  'tags',
  'period',
  'completion',
  'work_days',
  'total_days',
  'staff',
];

function isTooltipRowKey(key: unknown): key is TooltipRowKey {
  return typeof key === 'string' && (TOOLTIP_ROW_KEYS as string[]).includes(key);
}

/** The caption of a built-in row: the field's (renamed) label for the four built-in fields. */
export function tooltipRowLabel(
  settings: InstanceSettings | null | undefined,
  key: TooltipRowKey
): string {
  if (isBuiltInKey(key)) return builtInFieldLabel(settings, key);
  return TOOLTIP_ROW_DEFAULT_LABELS[key];
}

/**
 * `project_tooltip_rows` → the shown rows, built-in keys in display order then
 * field ids ascending, each once. Missing, empty or malformed reads as the
 * default rows; `[]` is no row. Unknown keys and non-positive numbers are
 * dropped (existence is not checked: callers skip ids they do not know).
 */
export function parseTooltipRows(value: string | null | undefined): TooltipRow[] {
  if (!value) return [...DEFAULT_TOOLTIP_ROWS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [...DEFAULT_TOOLTIP_ROWS];
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_TOOLTIP_ROWS];
  return canonicalRows(parsed);
}

function canonicalRows(items: Iterable<unknown>): TooltipRow[] {
  const keys = new Set<TooltipRowKey>();
  const ids = new Set<number>();
  for (const item of items) {
    if (isTooltipRowKey(item)) keys.add(item);
    else if (typeof item === 'number' && Number.isInteger(item) && item > 0) ids.add(item);
  }
  return [...TOOLTIP_ROW_KEYS.filter((key) => keys.has(key)), ...[...ids].sort((a, b) => a - b)];
}

/**
 * The canonical `project_tooltip_rows` value: compact JSON, built-in keys in
 * display order then field ids ascending -- the bytes the server stores.
 */
export function tooltipRowsValue(rows: Iterable<TooltipRow>): string {
  return JSON.stringify(canonicalRows(rows));
}

/**
 * The project details' row gate: `row` is shown when listed in
 * `project_tooltip_rows` and, for Customer, Sales PM and Volume, not hidden
 * instance-wide (a hidden field is never shown; Confirmed never is hidden).
 * Parses the settings once; the returned test is cheap per row.
 */
export function tooltipRowGate(
  settings: InstanceSettings | null | undefined
): (row: TooltipRow) => boolean {
  const listed = new Set<TooltipRow>(parseTooltipRows(settings?.project_tooltip_rows));
  const hidden = new Set<string>(parseHiddenFields(settings?.project_fields_hidden));
  return (row) => listed.has(row) && (typeof row === 'number' || !hidden.has(row));
}

/** Whether the project details show `row` ({@link tooltipRowGate} for one row). */
export function isTooltipRowShown(
  settings: InstanceSettings | null | undefined,
  row: TooltipRow
): boolean {
  return tooltipRowGate(settings)(row);
}
