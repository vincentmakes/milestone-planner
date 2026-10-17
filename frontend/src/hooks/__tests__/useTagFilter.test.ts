/**
 * useSiteTagFilter / useTagFilteredProjects: the stored filter is read per
 * tenant + site (tagFilterKey), stale and hidden selections are pruned the
 * way the TagFilterDropdown shows them, and an inactive filter hands back the
 * very same projects array (Gantt/Kanban memoisation relies on it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSiteTagFilter, useTagFilteredProjects } from '../useTagFilter';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import type { Project, Site, Tag, TagGroup } from '@/types';

function tag(id: number, name: string, extra: Partial<Tag> = {}): Tag {
  return { id, name, color: '#10b981', group_id: null, all_sites: true, site_ids: [], sort_order: 0, ...extra };
}

const TYPE: TagGroup = { id: 1, name: 'Project type', single_select: true, sort_order: 0 };
const AREA: TagGroup = { id: 2, name: 'Area', single_select: false, sort_order: 1 };
const tags: Tag[] = [
  tag(1, 'Internal', { group_id: 1 }),
  tag(2, 'Customer', { group_id: 1 }),
  // Area's only tag applies to site 2 alone.
  tag(3, 'Bio', { group_id: 2, all_sites: false, site_ids: [2] }),
  tag(4, 'Pilot'),
];

function project(id: number, tagIds: number[]): Project {
  return { id, name: `P${id}`, tags: tagIds.map((t) => ({ id: t, name: '', color: '', group_id: null })) } as unknown as Project;
}

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ tagFilters: {} });
  useAppStore.setState({ tags, tagGroups: [TYPE, AREA], currentSite: { id: 1, name: 'Basel' } as Site });
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('useSiteTagFilter', () => {
  it('reads the filter stored for the current tenant and site only', () => {
    window.history.pushState({}, '', '/t/acme/');
    useViewStore.setState({
      tagFilters: {
        'acme:1': { tagIds: [1], noneGroupIds: [] },
        'globex:1': { tagIds: [2], noneGroupIds: [] },
        ':1': { tagIds: [4], noneGroupIds: [] },
        'acme:2': { tagIds: [3], noneGroupIds: [] },
      },
    });
    const { result } = renderHook(() => useSiteTagFilter());
    expect(result.current.filter).toEqual({ tagIds: [1], noneGroupIds: [] });
    expect(result.current.activeCount).toBe(1);

    act(() => useAppStore.setState({ currentSite: { id: 2, name: 'Zurich' } as Site }));
    expect(result.current.filter).toEqual({ tagIds: [3], noneGroupIds: [] });
  });

  it('does not apply another tenant\'s filter for the same site id', () => {
    window.history.pushState({}, '', '/t/globex/');
    useViewStore.setState({ tagFilters: { 'acme:1': { tagIds: [1], noneGroupIds: [1] } } });
    const { result } = renderHook(() => useSiteTagFilter());
    expect(result.current.activeCount).toBe(0);
  });

  it('writes through setTagFilter land under the tenant + site key it reads', () => {
    window.history.pushState({}, '', '/t/acme/');
    const { result } = renderHook(() => useSiteTagFilter());
    act(() => useViewStore.getState().setTagFilter(1, { tagIds: [2], noneGroupIds: [] }));
    expect(Object.keys(useViewStore.getState().tagFilters)).toEqual(['acme:1']);
    expect(result.current.filter.tagIds).toEqual([2]);
  });

  it('prunes tags of other sites and "(No tag)" of groups without a tag at the site', () => {
    useViewStore.setState({ tagFilters: { ':1': { tagIds: [1, 3, 999], noneGroupIds: [1, 2, 77] } } });
    const { result } = renderHook(() => useSiteTagFilter());
    // Area (2) still exists but has no tag at site 1, so the dropdown shows
    // no "(No tag) in Area" checkbox: it must not count as selected.
    expect(result.current.filter).toEqual({ tagIds: [1], noneGroupIds: [1] });
    expect(result.current.activeCount).toBe(2);

    act(() => {
      useAppStore.setState({ currentSite: { id: 2, name: 'Zurich' } as Site });
      useViewStore.setState({ tagFilters: { ':2': { tagIds: [], noneGroupIds: [2] } } });
    });
    expect(result.current.filter).toEqual({ tagIds: [], noneGroupIds: [2] });
  });
});

describe('useTagFilteredProjects', () => {
  const projects = [project(1, [1]), project(2, [2]), project(3, [])];

  it('returns the same array reference while the filter is inactive', () => {
    const { result, rerender } = renderHook(({ list }) => useTagFilteredProjects(list), {
      initialProps: { list: projects },
    });
    expect(result.current).toBe(projects);

    // Only stale / hidden selections: still inactive, still the same array.
    act(() => useViewStore.setState({ tagFilters: { ':1': { tagIds: [3, 999], noneGroupIds: [2] } } }));
    rerender({ list: projects });
    expect(result.current).toBe(projects);
  });

  it('narrows the projects while a selection is active', () => {
    useViewStore.setState({ tagFilters: { ':1': { tagIds: [1], noneGroupIds: [] } } });
    const { result } = renderHook(() => useTagFilteredProjects(projects));
    expect(result.current.map((p) => p.id)).toEqual([1]);

    act(() => useViewStore.getState().setTagFilter(1, { tagIds: [1], noneGroupIds: [1] }));
    expect(result.current.map((p) => p.id)).toEqual([1, 3]);
  });
});
