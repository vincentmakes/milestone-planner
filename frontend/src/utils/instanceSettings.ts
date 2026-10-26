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
  | 'new_project_preselect_phases';

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
