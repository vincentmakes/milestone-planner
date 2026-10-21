/**
 * Teams API endpoints.
 *
 * A team belongs to one site; its members are users of that site. Reads are
 * open to every user; writes are admin-only on the server. Exempt from What-If
 * queuing (configuration, not plan operations — see WHAT_IF_EXEMPT_PATTERNS in
 * ../client.ts). Assigning teams to a project goes through
 * PUT /api/projects/{id} and stays queued.
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { CreateTeamRequest, Team, UpdateTeamRequest } from '@/types';

export const teamsApi = {
  /** Every team, or only the teams of `siteId`. */
  getAll: (siteId?: number) =>
    apiGet<Team[]>(siteId == null ? '/api/teams' : `/api/teams?siteId=${siteId}`),

  get: (id: number) =>
    apiGet<Team>(`/api/teams/${id}`),

  create: (data: CreateTeamRequest) =>
    apiPost<Team>('/api/teams', data),

  update: (id: number, data: UpdateTeamRequest) =>
    apiPut<Team>(`/api/teams/${id}`, data),

  delete: (id: number) =>
    apiDelete<void>(`/api/teams/${id}`),
};
