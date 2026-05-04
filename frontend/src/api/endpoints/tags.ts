/**
 * Tags API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { Tag } from '@/types';

export interface TagCreate {
  name: string;
  color?: string;
}

export interface TagUpdate {
  name?: string;
  color?: string;
}

export const tagsApi = {
  getAll: () =>
    apiGet<Tag[]>('/api/tags'),

  create: (data: TagCreate) =>
    apiPost<Tag>('/api/tags', data),

  update: (id: number, data: TagUpdate) =>
    apiPut<Tag>(`/api/tags/${id}`, data),

  delete: (id: number) =>
    apiDelete<void>(`/api/tags/${id}`),
};
