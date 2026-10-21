/**
 * useCan / useHasPermission / useNeedsApproval read the signed-in user's
 * resolved permissions from appStore and follow a currentUser refresh (a
 * role edit broadcasts change:role → /auth/me refetch).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCan, useHasPermission, useNeedsApproval } from '../useCan';
import { useAppStore } from '@/stores/appStore';
import { resetAllStores } from '@/stores';
import { makeUser } from '@/test/factories';

beforeEach(() => {
  resetAllStores();
});

describe('useHasPermission', () => {
  it('follows the current user', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user' }) });
    const { result } = renderHook(() => useHasPermission('whatif.use'));
    expect(result.current).toBe(false);

    act(() => useAppStore.setState({ currentUser: makeUser({ role: 'superuser' }) }));
    expect(result.current).toBe(true);

    act(() => useAppStore.setState({ currentUser: null }));
    expect(result.current).toBe(false);
  });
});

describe('useNeedsApproval', () => {
  it('is true only for keys in approval mode', () => {
    useAppStore.setState({
      currentUser: makeUser({ role: 'user', approval_required: ['assignments.self_create'] }),
    });
    expect(renderHook(() => useNeedsApproval('assignments.self_create')).result.current).toBe(true);
    expect(renderHook(() => useNeedsApproval('assignments.self_update')).result.current).toBe(false);
  });
});

describe('useCan', () => {
  it('checks any key, with the project-manager bundle on a project', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 3, role: 'user' }) });
    const { result } = renderHook(() => useCan());
    expect(result.current('views.kanban')).toBe(true);
    expect(result.current('projects.edit_any')).toBe(false);
    expect(result.current('projects.edit_any', { pm_id: 3 })).toBe(true);
  });

  it('is stable until the user changes', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user' }) });
    const { result, rerender } = renderHook(() => useCan());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    act(() => useAppStore.setState({ currentUser: makeUser({ role: 'admin' }) }));
    expect(result.current).not.toBe(first);
    expect(result.current('sites.manage')).toBe(true);
  });
});
