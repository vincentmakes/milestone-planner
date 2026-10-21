/**
 * useVisibleSites: every site with `sites.view_all` (can_see_all_sites),
 * otherwise only the user's own sites — the site selector, the Cross-site
 * view and the Settings panels' site pickers all read it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVisibleSites, visibleSitesFor } from '../useVisibleSites';
import { useAppStore } from '@/stores/appStore';
import { resetAllStores } from '@/stores';
import { makeSite, makeUser } from '@/test/factories';

const basel = makeSite({ id: 1, name: 'Basel' });
const zurich = makeSite({ id: 2, name: 'Zurich' });
const berlin = makeSite({ id: 3, name: 'Berlin' });

beforeEach(() => {
  resetAllStores();
  useAppStore.setState({ sites: [basel, zurich, berlin] });
});

describe('visibleSitesFor', () => {
  it('returns every site with sites.view_all, the own sites otherwise, nothing without a user', () => {
    const sites = [basel, zurich, berlin];
    expect(visibleSitesFor(makeUser({ role: 'admin', site_ids: [1] }), sites)).toEqual(sites);
    expect(visibleSitesFor(makeUser({ role: 'superuser', site_ids: [3, 1] }), sites)).toEqual([basel, berlin]);
    expect(visibleSitesFor(makeUser({ role: 'user', site_ids: [] }), sites)).toEqual([]);
    expect(visibleSitesFor(null, sites)).toEqual([]);
  });
});

describe('useVisibleSites', () => {
  it('follows the current user and keeps its identity between renders', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [2] }) });
    const { result, rerender } = renderHook(() => useVisibleSites());
    expect(result.current).toEqual([zurich]);
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    act(() => useAppStore.setState({ currentUser: makeUser({ role: 'user', can_see_all_sites: true }) }));
    expect(result.current).toEqual([basel, zurich, berlin]);
  });
});
