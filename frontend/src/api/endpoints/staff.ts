/**
 * Staff API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { Staff } from '@/types';

/**
 * Get all staff members
 * @param includeAllSites - If true, return staff from all sites
 */
export async function getStaff(includeAllSites = false): Promise<Staff[]> {
  const url = includeAllSites 
    ? '/api/staff?includeAllSites=true'
    : '/api/staff';
  return apiGet<Staff[]>(url);
}

/**
 * Get a single staff member
 */
export async function getStaffMember(id: number): Promise<Staff> {
  return apiGet<Staff>(`/api/staff/${id}`);
}

/**
 * Create a new staff member
 */
export async function createStaff(data: Omit<Staff, 'id'>): Promise<Staff> {
  return apiPost<Staff>('/api/staff', data);
}

/**
 * Update a staff member
 */
export async function updateStaff(id: number, data: Partial<Omit<Staff, 'id'>>): Promise<Staff> {
  return apiPut<Staff>(`/api/staff/${id}`, data);
}

/**
 * Delete a staff member
 */
export async function deleteStaff(id: number): Promise<void> {
  await apiDelete(`/api/staff/${id}`);
}
