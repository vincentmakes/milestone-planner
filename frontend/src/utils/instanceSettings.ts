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
