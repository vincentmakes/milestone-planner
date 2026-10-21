/**
 * Roles API endpoints: the permission catalogue, the roles holding it and
 * the approval policies of the own-booking actions.
 *
 * Reads are open to every signed-in user; writes are the admin's alone (the
 * server answers 403 otherwise, and 403 on any edit of the admin role).
 * Exempt from What-If queuing (configuration, never part of the sandbox —
 * see WHAT_IF_EXEMPT_PATTERNS in ../client.ts). Writes are coarse-broadcast
 * as change:role / change:approval_policy.
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type {
  ApprovalPolicy,
  CreateRoleRequest,
  PermissionCatalogue,
  Role,
  UpdateApprovalPolicyRequest,
  UpdateRoleRequest,
} from '@/types';

export const rolesApi = {
  /** The permission catalogue, grouped in matrix order, plus the PM bundle. */
  getPermissions: () =>
    apiGet<PermissionCatalogue>('/api/permissions'),

  /** Every role with its effective matrix and user count, in sort order. */
  getAll: () =>
    apiGet<Role[]>('/api/roles'),

  /** Create a custom role (400 duplicate key/name, 422 invalid matrix). */
  create: (data: CreateRoleRequest) =>
    apiPost<Role>('/api/roles', data),

  /** Partial update; `permissions` replaces the matrix (403 on the admin role). */
  update: (id: number, data: UpdateRoleRequest) =>
    apiPut<Role>(`/api/roles/${id}`, data),

  /** Delete a custom role (403 system role, 409 while users hold it). */
  delete: (id: number) =>
    apiDelete<void>(`/api/roles/${id}`),

  /** One policy per approvable action, in catalogue order. */
  getApprovalPolicies: () =>
    apiGet<ApprovalPolicy[]>('/api/approval-policies'),

  /** Replace who approves `action`. */
  updateApprovalPolicy: (action: string, data: UpdateApprovalPolicyRequest) =>
    apiPut<ApprovalPolicy>(`/api/approval-policies/${encodeURIComponent(action)}`, data),
};
