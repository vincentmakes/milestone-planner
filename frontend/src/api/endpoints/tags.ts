/**
 * Tags and tag-group API endpoints.
 *
 * Reads are open to every user; writes are admin-only on the server. Both
 * paths are exempt from What-If queuing (they are configuration, not plan
 * operations — see `allowedPrefixes` in ../client.ts).
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { Tag, TagGroup } from '@/types';

export interface TagCreate {
  name: string;
  color?: string;
  group_id?: number | null;
  /** Default true. When false, `site_ids` lists the sites the tag applies to. */
  all_sites?: boolean;
  site_ids?: number[];
  /** Teams the tag is restricted to; empty = every project on its sites. */
  team_ids?: number[];
}

export interface TagUpdate {
  name?: string;
  color?: string;
  group_id?: number | null;
  all_sites?: boolean;
  site_ids?: number[];
  team_ids?: number[];
}

export interface TagGroupCreate {
  name: string;
  single_select?: boolean;
}

export interface TagGroupUpdate {
  name?: string;
  single_select?: boolean;
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

export const tagGroupsApi = {
  getAll: () =>
    apiGet<TagGroup[]>('/api/tag-groups'),

  create: (data: TagGroupCreate) =>
    apiPost<TagGroup>('/api/tag-groups', data),

  update: (id: number, data: TagGroupUpdate) =>
    apiPut<TagGroup>(`/api/tag-groups/${id}`, data),

  delete: (id: number) =>
    apiDelete<void>(`/api/tag-groups/${id}`),

  /** Full order of group ids (sort_order = index). */
  reorder: (groupOrder: number[]) =>
    apiPut<{ success: boolean }>('/api/tag-groups/reorder', { group_order: groupOrder }),
};
