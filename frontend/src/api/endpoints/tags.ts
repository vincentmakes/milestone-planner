/**
 * Tags API endpoints.
 *
 * Reads are open to every user; writes need `tags.manage` on the server. The
 * path is exempt from What-If queuing (configuration, not plan operations —
 * see `isWhatIfExempt` in ../client.ts).
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { Tag } from '@/types';

export interface TagCreate {
  name: string;
  color?: string;
  /** Default true. When false, `site_ids` lists the sites the tag applies to. */
  all_sites?: boolean;
  site_ids?: number[];
  /** Teams the tag is restricted to; empty = every project on its sites. */
  team_ids?: number[];
}

export interface TagUpdate {
  name?: string;
  color?: string;
  all_sites?: boolean;
  site_ids?: number[];
  team_ids?: number[];
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

  /** Full order of tag ids (sort_order = index). */
  reorder: (tagOrder: number[]) =>
    apiPut<{ success: boolean }>('/api/tags/reorder', { tag_order: tagOrder }),
};
