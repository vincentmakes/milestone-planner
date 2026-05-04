/**
 * Job Titles API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { JobTitle } from '@/types';

export interface JobTitleCreate {
  name: string;
}

export interface JobTitleUpdate {
  name?: string;
  is_active?: boolean;
}

export const jobTitlesApi = {
  getActive: () => apiGet<JobTitle[]>('/api/job-titles'),
  getAll: () => apiGet<JobTitle[]>('/api/job-titles/all'),
  create: (data: JobTitleCreate) => apiPost<JobTitle>('/api/job-titles', data),
  update: (id: number, data: JobTitleUpdate) => apiPut<JobTitle>(`/api/job-titles/${id}`, data),
  delete: (id: number) => apiDelete<void>(`/api/job-titles/${id}`),
  reorder: (jobTitleOrder: number[]) =>
    apiPut<{ success: boolean }>('/api/job-titles/reorder', { job_title_order: jobTitleOrder }),
};
