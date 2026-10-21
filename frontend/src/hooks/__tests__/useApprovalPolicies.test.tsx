/**
 * useApprovalPolicies / useApproverSummary: who decides an own booking, for
 * the pending badge. Policies are configuration, loaded once on first use
 * (like the roles) into appStore.approvalPolicies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useApprovalPolicies, useApproverSummary } from '../useApprovalPolicies';
import { useAppStore } from '@/stores/appStore';
import { rolesApi } from '@/api/endpoints/roles';
import { makeProject, makeRole, makeSystemRoles } from '@/test/factories';
import type { ApprovalPolicy } from '@/types';

vi.mock('@/api/endpoints/roles', () => ({
  rolesApi: { getAll: vi.fn(), getApprovalPolicies: vi.fn() },
}));

const getPolicies = vi.mocked(rolesApi.getApprovalPolicies);
const getRoles = vi.mocked(rolesApi.getAll);

const policies: ApprovalPolicy[] = [
  { action: 'assignments.self_create', label: 'Book own time', pm_approves: true, role_ids: [4] },
  { action: 'assignments.self_remove', label: 'Remove own booking', pm_approves: false, role_ids: [] },
];

beforeEach(() => {
  getPolicies.mockReset();
  getRoles.mockReset();
  useAppStore.setState({ approvalPolicies: [], roles: [], projects: [] });
});

describe('useApprovalPolicies', () => {
  it('loads the policies once when the store holds none', async () => {
    getPolicies.mockResolvedValue(policies);
    const first = renderHook(() => useApprovalPolicies());
    renderHook(() => useApprovalPolicies());
    await waitFor(() => expect(first.result.current).toHaveLength(2));
    expect(getPolicies).toHaveBeenCalledTimes(1);
  });

  it('keeps an empty list when the fetch fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getPolicies.mockRejectedValue(new Error('500'));
    const { result } = renderHook(() => useApprovalPolicies());
    await waitFor(() => expect(getPolicies).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual([]);
    error.mockRestore();
  });
});

describe('useApproverSummary', () => {
  it('names the manager of the project, the policy roles and the administrators', () => {
    useAppStore.setState({
      approvalPolicies: policies,
      roles: makeSystemRoles(makeRole({ id: 4, name: 'Team lead' })),
      projects: [makeProject({ id: 1, pm_id: 12, pm_name: 'Fiona Fischer' })],
    });
    const { result } = renderHook(() => useApproverSummary('assignments.self_create', 1));
    expect(result.current).toBe('Awaiting approval by Fiona Fischer (project manager), Team lead or an administrator');
  });

  it('follows the action the request is for', () => {
    useAppStore.setState({
      approvalPolicies: policies,
      roles: makeSystemRoles(),
      projects: [makeProject({ id: 1, pm_id: 12, pm_name: 'Fiona Fischer' })],
    });
    const { result } = renderHook(() => useApproverSummary('assignments.self_remove', 1));
    expect(result.current).toBe('Awaiting approval by an administrator');
  });

  it('is plain "Awaiting approval" until the policies arrive', () => {
    getPolicies.mockReturnValue(new Promise(() => {}));
    getRoles.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useApproverSummary('assignments.self_create', 1));
    expect(result.current).toBe('Awaiting approval');
  });
});
