/**
 * Vacations API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { Vacation, CreateVacationRequest, CalendarImportResult } from '@/types';

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

export interface VacationImportItem {
  start_date: string;
  end_date: string;
  description?: string;
  absence_type_id?: number | null;
}

/**
 * Bulk-import vacations for one staff member (e.g. from an .ics file).
 * Exact (staff, start, end) duplicates are skipped server-side.
 */
export async function importVacations(
  staffId: number,
  items: VacationImportItem[]
): Promise<CalendarImportResult> {
  return apiPost<CalendarImportResult>('/api/vacations/import', { staff_id: staffId, items });
}
