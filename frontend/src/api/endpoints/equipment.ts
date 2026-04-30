/**
 * Equipment API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { Equipment, EquipmentBlock, CreateEquipmentBlockRequest } from '@/types';

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

/**
 * List equipment blocks (maintenance / defect periods).
 * Optionally filter by site or equipment.
 */
export async function getEquipmentBlocks(params?: {
  siteId?: number;
  equipmentId?: number;
}): Promise<EquipmentBlock[]> {
  const search = new URLSearchParams();
  if (params?.siteId !== undefined) search.set('siteId', String(params.siteId));
  if (params?.equipmentId !== undefined) search.set('equipmentId', String(params.equipmentId));
  const qs = search.toString();
  return apiGet<EquipmentBlock[]>(`/api/equipment-blocks${qs ? `?${qs}` : ''}`);
}

/**
 * Create an equipment block.
 */
export async function createEquipmentBlock(
  data: CreateEquipmentBlockRequest,
): Promise<EquipmentBlock> {
  return apiPost<EquipmentBlock>('/api/equipment-blocks', data);
}

/**
 * Update an equipment block.
 */
export async function updateEquipmentBlock(
  id: number,
  data: Partial<CreateEquipmentBlockRequest>,
): Promise<EquipmentBlock> {
  return apiPut<EquipmentBlock>(`/api/equipment-blocks/${id}`, data);
}

/**
 * Delete an equipment block.
 */
export async function deleteEquipmentBlock(id: number): Promise<void> {
  await apiDelete(`/api/equipment-blocks/${id}`);
}
