/**
 * Logout resets every store (F1-15), not just appStore: a What-If queue left
 * behind would be replayed under the next user's session on Apply.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { User, Project, AppNotification } from '@/types';

const api = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('@/api', () => api);

import { useAuth } from '../useAuth';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { useUndoStore } from '@/stores/undoStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';

const PROJECT = { id: 1, name: 'P', phases: [] } as unknown as Project;

describe('useAuth.logout', () => {
  beforeEach(() => {
    api.checkAuth.mockReset().mockResolvedValue({ user: { id: 1 } as User });
    api.logout.mockReset().mockResolvedValue(undefined);
    useAppStore.setState({
      isAuthChecking: false,
      isAuthenticated: true,
      currentUser: { id: 1 } as User,
      projects: [PROJECT],
    });
    useWhatIfStore.getState().enterWhatIfMode([PROJECT]);
    useWhatIfStore.getState().queueWhatIfOperation({ method: 'PUT', url: '/api/phases/1', body: {} });
    useUndoStore.getState().saveState([PROJECT], 'drag');
    useNotificationStore.setState({ items: [{ id: 3 } as AppNotification], unreadCount: 1 });
    useCustomColumnStore.setState({ customColumnValues: { '1-phase-1': 'x' } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('clears the What-If queue, undo history, inbox and custom-column data', async () => {
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.logout();
    });

    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().isAuthenticated).toBe(false);
    expect(useAppStore.getState().currentUser).toBeNull();
    expect(useAppStore.getState().projects).toEqual([]);
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
    expect(useWhatIfStore.getState().whatIfPendingOperations).toEqual([]);
    expect(useUndoStore.getState().canUndo).toBe(false);
    expect(useNotificationStore.getState().items).toEqual([]);
    expect(useCustomColumnStore.getState().customColumnValues).toEqual({});
    // Straight to the login screen, no second auth check.
    expect(useAppStore.getState().isAuthChecking).toBe(false);
    expect(api.checkAuth).not.toHaveBeenCalled();
  });

  it('resets even when the logout request fails', async () => {
    api.logout.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.logout();
    });

    expect(useAppStore.getState().isAuthenticated).toBe(false);
    expect(useWhatIfStore.getState().whatIfPendingOperations).toEqual([]);
  });
});
