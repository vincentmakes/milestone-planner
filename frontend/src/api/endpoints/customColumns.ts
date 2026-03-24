/**
 * Custom Columns API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete, apiRequest } from '../client';

// Types
export interface CustomColumn {
  id: number;
  name: string;
  column_type: 'text' | 'boolean' | 'list';
  list_options: string[] | null;
  site_id: number | null;  // null = global (all sites)
  display_order: number;
  width: number;
  created_at: string;
  updated_at: string;
}

export interface CustomColumnCreate {
  name: string;
  column_type: 'text' | 'boolean' | 'list';
  list_options?: string[];
  site_id?: number | null;  // null = global (all sites)
  width?: number;
}

export interface CustomColumnUpdate {
  name?: string;
  list_options?: string[];
  width?: number;
  display_order?: number;
}

export interface CustomColumnValue {
  id: number;
  custom_column_id: number;
  entity_type: 'project' | 'phase' | 'subphase';
  entity_id: number;
  value: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomColumnValueCreate {
  custom_column_id: number;
  entity_type: 'project' | 'phase' | 'subphase';
  entity_id: number;
  value: string | null;
}

export interface CustomColumnsWithValues {
  columns: CustomColumn[];
  values: Record<string, string>; // key: "{column_id}-{entity_type}-{entity_id}"
}

// API Functions

/**
 * Get all custom columns for a site (includes global columns)
 */
export async function getCustomColumns(siteId?: number): Promise<CustomColumn[]> {
  const params = siteId ? `?site_id=${siteId}` : '';
  return apiGet(`/api/custom-columns${params}`);
}

/**
 * Get all custom columns with their values for a site
 * This is the main endpoint for initial data loading
 */
export async function getCustomColumnsWithValues(siteId: number): Promise<CustomColumnsWithValues> {
  return apiGet(`/api/custom-columns/with-values?site_id=${siteId}`);
}

/**
 * Create a new custom column
 */
export async function createCustomColumn(data: CustomColumnCreate): Promise<CustomColumn> {
  return apiPost('/api/custom-columns', data);
}

/**
 * Update a custom column
 */
export async function updateCustomColumn(columnId: number, data: CustomColumnUpdate): Promise<CustomColumn> {
  return apiRequest(`/api/custom-columns/${columnId}`, { method: 'PATCH', body: data });
}

/**
 * Delete a custom column
 */
export async function deleteCustomColumn(columnId: number): Promise<{ success: boolean; message: string }> {
  return apiDelete(`/api/custom-columns/${columnId}`);
}

/**
 * Reorder custom columns
 */
export async function reorderCustomColumns(columnOrder: number[]): Promise<CustomColumn[]> {
  return apiRequest('/api/custom-columns/reorder', { method: 'PATCH', body: { column_order: columnOrder } });
}

/**
 * Set a custom column value (upsert)
 */
export async function setCustomColumnValue(data: CustomColumnValueCreate): Promise<CustomColumnValue> {
  return apiPut('/api/custom-columns/values', data);
}

/**
 * Batch update custom column values (for drag-fill)
 */
export async function setCustomColumnValuesBatch(updates: CustomColumnValueCreate[]): Promise<CustomColumnValue[]> {
  return apiPut('/api/custom-columns/values/batch', { updates });
}

/**
 * Delete a custom column value
 */
export async function deleteCustomColumnValue(
  columnId: number,
  entityType: 'project' | 'phase' | 'subphase',
  entityId: number
): Promise<{ success: boolean; message: string }> {
  return apiDelete(`/api/custom-columns/values/${columnId}/${entityType}/${entityId}`);
}

// Helper functions

/**
 * Generate a key for the values map
 */
export function getValueKey(columnId: number, entityType: string, entityId: number): string {
  return `${columnId}-${entityType}-${entityId}`;
}

/**
 * Parse a boolean value from string
 */
export function parseBooleanValue(value: string | null): boolean {
  return value?.toLowerCase() === 'true';
}

/**
 * Convert boolean to string for storage
 */
export function booleanToString(value: boolean): string {
  return value ? 'true' : 'false';
}
