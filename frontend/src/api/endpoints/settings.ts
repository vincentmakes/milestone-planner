/**
 * Settings API endpoints
 */

import { apiGet, apiPut, apiPost, apiDelete } from '../client';
import type { PredefinedPhase, SSOConfig, InstanceSettings } from '@/types';
import { DEFAULT_HELP_URL } from '@/utils/helpLinks';

// =============================================================================
// INSTANCE SETTINGS
// =============================================================================

/**
 * Get a specific setting value
 */
export async function getSetting(key: string): Promise<{ value: string | null }> {
  return apiGet<{ value: string | null }>(`/api/settings/${key}`);
}

/**
 * Update a setting value (`null` on a known key deletes its row: the default applies again)
 */
export async function updateSetting(key: string, value: string | null): Promise<{ value: string }> {
  return apiPut<{ value: string }>(`/api/settings/${key}`, { value });
}

/**
 * Get instance title
 */
export async function getInstanceTitle(): Promise<string> {
  try {
    const response = await getSetting('instance_title');
    return response.value || 'R&D Planning';
  } catch {
    return 'R&D Planning';
  }
}

/**
 * Defaults of the admin defaults and feature switches, as in the backend's
 * KNOWN_SETTINGS (app/services/instance_settings.py). The backend already
 * fills a missing row with its default; these cover an empty value.
 */
export const INSTANCE_SETTING_DEFAULTS = {
  gantt_default_panel: 'none',
  staff_panel_default_skills: '[]',
  equipment_panel_default_types: '[]',
  kanban_enabled: 'true',
  nager_enabled: 'true',
  new_project_preselect_phases: 'true',
  gantt_completion_badges: 'true',
  project_field_labels: '{}',
  project_fields_hidden: '[]',
  volume_decimals: '1',
  project_tooltip_rows:
    '["customer","pm","confirmed","tags","period","completion","work_days","total_days","staff"]',
  audit_log_retention_days: '365',
  show_weekends: 'true',
  weekend_working_days: 'false',
  help_url: DEFAULT_HELP_URL,
} as const;

export type DefaultedSettingKey = keyof typeof INSTANCE_SETTING_DEFAULTS;

/** The keys copied into appStore.instanceSettings (logos and the rest stay out). */
export const INSTANCE_SETTING_KEYS = [
  'instance_title',
  'instance_name',
  ...(Object.keys(INSTANCE_SETTING_DEFAULTS) as DefaultedSettingKey[]),
] as const;

/**
 * Get all instance settings
 * Uses the GET /api/settings endpoint that returns all settings as key-value
 */
export async function getInstanceSettings(): Promise<InstanceSettings> {
  const allSettings = await apiGet<Record<string, string | null>>('/api/settings');
  const settings: InstanceSettings = {};
  for (const key of INSTANCE_SETTING_KEYS) {
    const fallback: string | undefined =
      key in INSTANCE_SETTING_DEFAULTS ? INSTANCE_SETTING_DEFAULTS[key as DefaultedSettingKey] : undefined;
    settings[key] = allSettings[key] || fallback;
  }
  return settings;
}

/**
 * Update instance title
 */
export async function updateInstanceTitle(title: string): Promise<void> {
  await updateSetting('instance_title', title);
}

// =============================================================================
// PREDEFINED PHASES
// =============================================================================

/**
 * Get all predefined phases
 */
export async function getPredefinedPhases(): Promise<PredefinedPhase[]> {
  return apiGet<PredefinedPhase[]>('/api/predefined-phases');
}

/**
 * Create a predefined phase
 */
export async function createPredefinedPhase(
  data: Omit<PredefinedPhase, 'id'>
): Promise<PredefinedPhase> {
  return apiPost<PredefinedPhase>('/api/predefined-phases', data);
}

/**
 * Update a predefined phase
 */
export async function updatePredefinedPhase(
  id: number, 
  data: Partial<Omit<PredefinedPhase, 'id'>>
): Promise<PredefinedPhase> {
  return apiPut<PredefinedPhase>(`/api/predefined-phases/${id}`, data);
}

/**
 * Delete a predefined phase
 */
export async function deletePredefinedPhase(id: number): Promise<void> {
  await apiDelete(`/api/predefined-phases/${id}`);
}

// =============================================================================
// SSO CONFIGURATION
// =============================================================================

/**
 * Get SSO configuration
 */
export async function getSSOConfig(): Promise<SSOConfig> {
  return apiGet<SSOConfig>('/api/settings/sso');
}

/**
 * Update SSO configuration
 */
export async function updateSSOConfig(config: Partial<SSOConfig>): Promise<SSOConfig> {
  return apiPut<SSOConfig>('/api/settings/sso', config);
}
