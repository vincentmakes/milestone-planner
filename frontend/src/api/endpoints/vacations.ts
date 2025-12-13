/**
 * Vacations API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { Vacation, CreateVacationRequest } from '@/types';

/**
 * Get all vacations
 */
export async function getVacations(): Promise<Vacation[]> {
  return apiGet<Vacation[]>('/api/vacations');
}

/**
 * Get vacations for a specific staff member
 */
export async function getStaffVacations(staffId: number): Promise<Vacation[]> {
  return apiGet<Vacation[]>(`/api/vacations?staff_id=${staffId}`);
}

/**
 * Create a new vacation
 */
export async function createVacation(data: CreateVacationRequest): Promise<Vacation> {
  return apiPost<Vacation>('/api/vacations', data);
}

/**
 * Update a vacation
 */
export async function updateVacation(id: number, data: Partial<CreateVacationRequest>): Promise<Vacation> {
  return apiPut<Vacation>(`/api/vacations/${id}`, data);
}

/**
 * Delete a vacation
 */
export async function deleteVacation(id: number): Promise<void> {
  await apiDelete(`/api/vacations/${id}`);
}
