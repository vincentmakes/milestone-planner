/**
 * useAllowedViews: the Gantt is always there; every other view needs its
 * `views.*` key (hidden without it), and Cross-site is listed but disabled,
 * with the reason, while the user sees a single site.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAllowedViews, CROSS_SITE_DISABLED_REASON } from '../useAllowedViews';
import { useAppStore } from '@/stores/appStore';
import { resetAllStores } from '@/stores';
import { makeSite, makeUser } from '@/test/factories';

beforeEach(() => {
  resetAllStores();
  useAppStore.setState({ sites: [makeSite({ id: 1 }), makeSite({ id: 2, name: 'Zurich' })] });
});

describe('useAllowedViews', () => {
  it('lists every view for a user holding the view keys at two sites', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [1, 2] }) });
    const { result } = renderHook(() => useAllowedViews());
    expect(result.current.visible).toEqual(['gantt', 'kanban', 'staff', 'equipment', 'crosssite', 'archived']);
    expect(result.current.disabledReason).toEqual({});
    expect(result.current.isAllowed('crosssite')).toBe(true);
  });

  it('hides views without their key and keeps the Gantt', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'viewer', permissions: ['projects.view', 'views.staff'] }) });
    const { result } = renderHook(() => useAllowedViews());
    expect(result.current.visible).toEqual(['gantt', 'staff']);
    expect(result.current.isAllowed('kanban')).toBe(false);
    expect(result.current.isAllowed('gantt')).toBe(true);
  });

  it('disables Cross-site with the reason while only one site is visible', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [2] }) });
    const { result } = renderHook(() => useAllowedViews());
    expect(result.current.visible).toContain('crosssite');
    expect(result.current.disabledReason).toEqual({ crosssite: CROSS_SITE_DISABLED_REASON });
    expect(CROSS_SITE_DISABLED_REASON).toBe('Cross-site needs access to more than one site');
    expect(result.current.isAllowed('crosssite')).toBe(false);
  });

  it('allows only the Gantt without a user', () => {
    const { result } = renderHook(() => useAllowedViews());
    expect(result.current.visible).toEqual(['gantt']);
  });
});
