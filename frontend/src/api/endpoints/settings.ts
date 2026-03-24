/**
 * Settings API endpoints
 */

import { apiGet, apiPut, apiPost, apiDelete } from '../client';
import type { PredefinedPhase, SSOConfig, InstanceSettings } from '@/types';

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
 * Update a setting value
 */
export async function updateSetting(key: string, value: string): Promise<{ value: string }> {
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
 * Get all instance settings
 * Uses the GET /api/settings endpoint that returns all settings as key-value
 */
export async function getInstanceSettings(): Promise<InstanceSettings> {
  const allSettings = await apiGet<Record<string, string | null>>('/api/settings');
  return {
    instance_title: allSettings.instance_title || undefined,
    instance_name: allSettings.instance_name || undefined,
  };
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
