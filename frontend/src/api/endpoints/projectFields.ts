/**
 * Project fields API endpoints (Settings → Project fields).
 *
 * Reads are open to every user; writes need `project_fields.manage` (admins
 * by default). Exempt from What-If queuing: field definitions are
 * configuration, not plan operations (see `isWhatIfExempt` in ../client.ts).
 * A project's values travel with the project (`field_values` on
 * POST/PUT /api/projects), not through these routes.
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { ProjectField, ProjectFieldOption, ProjectFieldType } from '@/types';

export interface ProjectFieldCreate {
  name: string;
  field_type: ProjectFieldType;
}

/** The type of a field never changes (422); only the name does. */
export interface ProjectFieldUpdate {
  name?: string;
}

export interface ProjectFieldOptionCreate {
  name: string;
  color?: string;
  /** Default true. When false, `site_ids` lists the sites the item applies to. */
  all_sites?: boolean;
  site_ids?: number[];
  /** Teams the item is restricted to; empty = every project on its sites. */
  team_ids?: number[];
}

export type ProjectFieldOptionUpdate = Partial<ProjectFieldOptionCreate>;

export const projectFieldsApi = {
  /** Every field in display order, with its items. */
  getAll: () =>
    apiGet<ProjectField[]>('/api/project-fields'),

  create: (data: ProjectFieldCreate) =>
    apiPost<ProjectField>('/api/project-fields', data),

  update: (id: number, data: ProjectFieldUpdate) =>
    apiPut<ProjectField>(`/api/project-fields/${id}`, data),

  /** Deletes the field with its items and every project's value. */
  remove: (id: number) =>
    apiDelete<void>(`/api/project-fields/${id}`),

  /** Full order of field ids (sort_order = index). */
  reorder: (fieldOrder: number[]) =>
    apiPut<{ success: boolean }>('/api/project-fields/reorder', { field_order: fieldOrder }),

  /** How many projects hold a value of the field (asked before a delete). */
  usage: (id: number) =>
    apiGet<{ projects: number }>(`/api/project-fields/${id}/usage`),

  createOption: (fieldId: number, data: ProjectFieldOptionCreate) =>
    apiPost<ProjectFieldOption>(`/api/project-fields/${fieldId}/options`, data),

  updateOption: (optionId: number, data: ProjectFieldOptionUpdate) =>
    apiPut<ProjectFieldOption>(`/api/project-fields/options/${optionId}`, data),

  removeOption: (optionId: number) =>
    apiDelete<void>(`/api/project-fields/options/${optionId}`),

  /** Full order of one field's item ids. */
  reorderOptions: (fieldId: number, optionOrder: number[]) =>
    apiPut<{ success: boolean }>(`/api/project-fields/${fieldId}/options/reorder`, {
      option_order: optionOrder,
    }),
};
