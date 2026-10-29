/**
 * useAllowedViews: the Gantt is always there; every other view needs its
 * `views.*` key (hidden without it), and Cross-site is hidden while the user
 * sees a single site.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAllowedViews } from '../useAllowedViews';
import { useAppStore } from '@/stores/appStore';
import { resetAllStores } from '@/stores';
import { makeSite, makeUser } from '@/test/factories';
import { PERMISSION_KEYS } from '@/types/permissions';

beforeEach(() => {
  resetAllStores();
  useAppStore.setState({ sites: [makeSite({ id: 1 }), makeSite({ id: 2, name: 'Zurich' })] });
});

describe('useAllowedViews', () => {
  it('lists every view for a user holding the view keys at two sites', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [1, 2] }) });
    const { result } = renderHook(() => useAllowedViews());
    expect(result.current.visible).toEqual(['gantt', 'kanban', 'work', 'staff', 'equipment', 'crosssite', 'archived']);
    expect(result.current.isAllowed('crosssite')).toBe(true);
  });

  it('hides views without their key and keeps the Gantt', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'viewer', permissions: ['projects.view', 'views.staff'] }) });
    const { result } = renderHook(() => useAllowedViews());
    // My Work needs no key: everyone has bookings and requests of their own.
    expect(result.current.visible).toEqual(['gantt', 'work', 'staff']);
    expect(result.current.isAllowed('kanban')).toBe(false);
    expect(result.current.isAllowed('work')).toBe(true);
    expect(result.current.isAllowed('gantt')).toBe(true);
  });

  it('hides the Kanban board from an administrator while the board is turned off', () => {
    // /auth/me omits views.kanban from everyone, admins included, while it is off
    const withoutBoard = PERMISSION_KEYS.filter((key) => key !== 'views.kanban');
    useAppStore.setState({ currentUser: makeUser({ role: 'admin', permissions: withoutBoard, site_ids: [1, 2] }) });
    const { result } = renderHook(() => useAllowedViews());
    expect(result.current.visible).toEqual(['gantt', 'work', 'staff', 'equipment', 'crosssite', 'archived']);
    expect(result.current.isAllowed('kanban')).toBe(false);
  });

  it('hides Cross-site while only one site is visible', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [2] }) });
    const { result } = renderHook(() => useAllowedViews());
    expect(result.current.visible).toEqual(['gantt', 'kanban', 'work', 'staff', 'equipment', 'archived']);
    expect(result.current.isAllowed('crosssite')).toBe(false);
  });

  it('hides Cross-site from an administrator of a single-site instance', () => {
    useAppStore.setState({ sites: [makeSite({ id: 1 })], currentUser: makeUser({ role: 'admin' }) });
    const { result } = renderHook(() => useAllowedViews());
    expect(result.current.visible).not.toContain('crosssite');
  });

  it('allows only the Gantt without a user', () => {
    const { result } = renderHook(() => useAllowedViews());
    expect(result.current.visible).toEqual(['gantt']);
  });
});
