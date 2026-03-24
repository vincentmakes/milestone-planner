/**
 * Equipment API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { Equipment } from '@/types';

/**
 * Get all equipment
 * @param includeAllSites - If true, return equipment from all sites
 */
export async function getEquipment(includeAllSites = false): Promise<Equipment[]> {
  const url = includeAllSites
    ? '/api/equipment?includeAllSites=true'
    : '/api/equipment';
  const response = await apiGet<{ items: Equipment[]; total: number; offset: number; limit: number }>(url);
  return response.items;
}

/**
 * Get a single equipment item
 */
export async function getEquipmentItem(id: number): Promise<Equipment> {
  return apiGet<Equipment>(`/api/equipment/${id}`);
}

/**
 * Create new equipment
 */
export async function createEquipment(data: Omit<Equipment, 'id'>): Promise<Equipment> {
  return apiPost<Equipment>('/api/equipment', data);
}

/**
 * Update equipment
 */
export async function updateEquipment(id: number, data: Partial<Omit<Equipment, 'id'>>): Promise<Equipment> {
  return apiPut<Equipment>(`/api/equipment/${id}`, data);
}

/**
 * Delete equipment
 */
export async function deleteEquipment(id: number): Promise<void> {
  await apiDelete(`/api/equipment/${id}`);
}
