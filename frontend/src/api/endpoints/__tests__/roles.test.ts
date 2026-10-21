/**
 * Roles API: the permission catalogue, role CRUD and approval policies hit
 * the backend routes with the bodies they were given, and pass the server's
 * answer through untouched (the frontend model is the wire shape).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from '@/api/client';
import { rolesApi } from '../roles';
import * as api from '@/api';
import type { ApprovalPolicy, PermissionCatalogue, Role } from '@/types';

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  apiPatch: vi.fn(),
  apiRequest: vi.fn(),
  getTenantPrefix: vi.fn(),
  configureApiClient: vi.fn(),
}));

const get = vi.mocked(client.apiGet);
const post = vi.mocked(client.apiPost);
const put = vi.mocked(client.apiPut);
const del = vi.mocked(client.apiDelete);

const role: Role = {
  id: 4,
  key: 'team_lead',
  name: 'Team lead',
  description: null,
  is_system: false,
  sort_order: 3,
  permissions: { 'projects.view': 'allow', 'assignments.self_create': 'approval' },
  user_count: 0,
};

beforeEach(() => {
  for (const fn of [get, post, put, del]) fn.mockReset();
});

describe('rolesApi', () => {
  it('is exported from the api barrel', () => {
    expect(api.rolesApi).toBe(rolesApi);
  });

  it('returns the catalogue and the roles as served', async () => {
    const catalogue: PermissionCatalogue = { groups: [], pm_bundle: ['projects.edit_any'] };
    get.mockResolvedValueOnce(catalogue).mockResolvedValueOnce([role]);
    await expect(rolesApi.getPermissions()).resolves.toBe(catalogue);
    await expect(rolesApi.getAll()).resolves.toEqual([role]);
    expect(get.mock.calls.map((c) => c[0])).toEqual(['/api/permissions', '/api/roles']);
  });

  it('creates, updates and deletes a role', async () => {
    post.mockResolvedValue(role);
    put.mockResolvedValue({ ...role, name: 'Lead' });
    del.mockResolvedValue(undefined);

    await expect(
      rolesApi.create({ key: 'team_lead', name: 'Team lead', permissions: role.permissions })
    ).resolves.toBe(role);
    await expect(rolesApi.update(4, { description: null })).resolves.toMatchObject({ name: 'Lead' });
    await rolesApi.delete(4);

    expect(post).toHaveBeenCalledWith('/api/roles', {
      key: 'team_lead',
      name: 'Team lead',
      permissions: role.permissions,
    });
    expect(put).toHaveBeenCalledWith('/api/roles/4', { description: null });
    expect(del).toHaveBeenCalledWith('/api/roles/4');
  });

  it('reads and writes approval policies, one action at a time', async () => {
    const policy: ApprovalPolicy = { action: 'assignments.self_update', label: 'Change own bookings', pm_approves: true, role_ids: [] };
    get.mockResolvedValue([policy]);
    put.mockResolvedValue({ ...policy, role_ids: [2] });

    await expect(rolesApi.getApprovalPolicies()).resolves.toEqual([policy]);
    await expect(
      rolesApi.updateApprovalPolicy('assignments.self_update', { pm_approves: true, role_ids: [2] })
    ).resolves.toMatchObject({ role_ids: [2] });
    expect(get).toHaveBeenCalledWith('/api/approval-policies');
    expect(put).toHaveBeenCalledWith('/api/approval-policies/assignments.self_update', {
      pm_approves: true,
      role_ids: [2],
    });
  });

  it('encodes the action in the URL', async () => {
    put.mockResolvedValue({});
    await rolesApi.updateApprovalPolicy('a/b', { pm_approves: false, role_ids: [] });
    expect(put.mock.calls[0][0]).toBe('/api/approval-policies/a%2Fb');
  });
});
