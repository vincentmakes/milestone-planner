/**
 * Absence types API endpoints
 * Tenant-wide categories for staff time off (GET: any user; writes: admin).
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { AbsenceType } from '@/types';

export interface AbsenceTypeCreate {
  name: string;
  color: string;
  counts_as_unavailable?: boolean;
  is_active?: boolean;
}

export interface AbsenceTypeUpdate {
  name?: string;
  color?: string;
  counts_as_unavailable?: boolean;
  is_active?: boolean;
}

export const absenceTypesApi = {
  /** All types, including inactive ones, in sort order */
  getAll: () =>
    apiGet<AbsenceType[]>('/api/absence-types'),

  create: (data: AbsenceTypeCreate) =>
    apiPost<AbsenceType>('/api/absence-types', data),

  update: (id: number, data: AbsenceTypeUpdate) =>
    apiPut<AbsenceType>(`/api/absence-types/${id}`, data),

  /** Rejected with 409 while vacations still use the type -- deactivate it instead */
  remove: (id: number) =>
    apiDelete<{ success: boolean }>(`/api/absence-types/${id}`),

  reorder: (typeOrder: number[]) =>
    apiPut<{ success: boolean }>('/api/absence-types/reorder', { type_order: typeOrder }),
};
