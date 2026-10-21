/**
 * useRoles: the roles from appStore, fetched once when the store has none
 * (concurrent mounts share one request; a failure leaves the list empty
 * without retrying in a loop). refreshRoles always refetches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { refreshRoles, useRoles } from '../useRoles';
import { useAppStore } from '@/stores/appStore';
import { rolesApi } from '@/api/endpoints/roles';
import { makeRole, makeSystemRoles } from '@/test/factories';

vi.mock('@/api/endpoints/roles', () => ({ rolesApi: { getAll: vi.fn() } }));

const getAll = vi.mocked(rolesApi.getAll);

beforeEach(() => {
  getAll.mockReset();
  useAppStore.setState({ roles: [] });
});

describe('useRoles', () => {
  it('loads the roles once when the store holds none', async () => {
    getAll.mockResolvedValue(makeSystemRoles());
    const first = renderHook(() => useRoles());
    const second = renderHook(() => useRoles());

    await waitFor(() => expect(first.result.current).toHaveLength(3));
    expect(second.result.current.map((r) => r.key)).toEqual(['admin', 'superuser', 'user']);
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it('uses the roles already in the store', () => {
    useAppStore.setState({ roles: makeSystemRoles() });
    const { result } = renderHook(() => useRoles());
    expect(result.current).toHaveLength(3);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('keeps an empty list when the fetch fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getAll.mockRejectedValue(new Error('500'));
    const { result, rerender } = renderHook(() => useRoles());
    await waitFor(() => expect(getAll).toHaveBeenCalledTimes(1));
    await act(async () => {});
    rerender();
    expect(result.current).toEqual([]);
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[useRoles] Failed to load roles', expect.any(Error));
    error.mockRestore();
  });

  it('refreshRoles replaces the stored roles', async () => {
    useAppStore.setState({ roles: makeSystemRoles() });
    getAll.mockResolvedValue(makeSystemRoles(makeRole()));
    await refreshRoles();
    expect(useAppStore.getState().roles.map((r) => r.key)).toContain('team_lead');
  });
});
