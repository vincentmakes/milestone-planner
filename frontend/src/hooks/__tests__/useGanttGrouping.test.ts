/**
 * useGanttGrouping: the Gantt grouping is read and written per tenant + site
 * (tagFilterKey), a stale group id reads as "not grouped" without a write,
 * and removing the grouping drops the site's collapsed sections.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGanttGrouping } from '../useGanttGrouping';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import type { Site, Tag, TagGroup } from '@/types';

function tag(id: number, name: string, extra: Partial<Tag> = {}): Tag {
  return { id, name, color: '#10b981', group_id: 1, all_sites: true, site_ids: [], sort_order: 0, ...extra };
}

const TYPE: TagGroup = { id: 1, name: 'Project type', single_select: true, colors_projects: false, sort_order: 0 };
const AREA: TagGroup = { id: 2, name: 'Area', single_select: false, colors_projects: false, sort_order: 1 };
const tags: Tag[] = [
  tag(1, 'Internal'),
  tag(2, 'Customer'),
  tag(3, 'Bio', { group_id: 2, all_sites: false, site_ids: [2] }),
];

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ ganttGrouping: {}, collapsedGanttSections: {} });
  useAppStore.setState({ tags, tagGroups: [TYPE, AREA], currentSite: { id: 1, name: 'Basel' } as Site });
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('useGanttGrouping', () => {
  it('reads the grouping of the current tenant and site only', () => {
    window.history.pushState({}, '', '/t/acme/');
    useViewStore.setState({
      ganttGrouping: { 'acme:1': 1, 'globex:1': 2, 'acme:2': 2 },
      collapsedGanttSections: { 'acme:1': ['tag-1'], 'globex:1': ['none'] },
    });
    const { result } = renderHook(() => useGanttGrouping());
    expect(result.current.group).toBe(TYPE);
    expect(result.current.collapsedKeys).toEqual(['tag-1']);

    act(() => useAppStore.setState({ currentSite: { id: 2, name: 'Zurich' } as Site }));
    expect(result.current.group).toBe(AREA);
    expect(result.current.collapsedKeys).toEqual([]);
    expect(result.current.siteTags.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('writes under the tenant + site key it reads', () => {
    window.history.pushState({}, '', '/t/acme/');
    const { result } = renderHook(() => useGanttGrouping());
    act(() => result.current.setGroup(2));
    act(() => result.current.toggleSection('none'));
    expect(useViewStore.getState().ganttGrouping).toEqual({ 'acme:1': 2 });
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ 'acme:1': ['none'] });
    expect(result.current.group).toBe(AREA);
    expect(result.current.collapsedKeys).toEqual(['none']);

    act(() => result.current.toggleSection('none'));
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('treats a stale group id as not grouped, without writing', () => {
    useViewStore.setState({ ganttGrouping: { ':1': 99 }, collapsedGanttSections: { ':1': ['tag-5'] } });
    const { result } = renderHook(() => useGanttGrouping());
    expect(result.current.group).toBeNull();
    expect(result.current.collapsedKeys).toEqual([]);
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':1': 99 });
  });

  it('setGroup(null) clears the grouping and the collapsed sections', () => {
    useViewStore.setState({ ganttGrouping: { ':1': 1, ':2': 2 }, collapsedGanttSections: { ':1': ['tag-1'], ':2': ['none'] } });
    const { result } = renderHook(() => useGanttGrouping());
    act(() => result.current.setGroup(null));
    expect(result.current.group).toBeNull();
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':2': 2 });
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':2': ['none'] });
  });

  it('collapses every section of the group at the site, and expands them all', () => {
    useViewStore.setState({ ganttGrouping: { ':1': 1 } });
    const { result } = renderHook(() => useGanttGrouping());
    act(() => result.current.collapseAll());
    // Group display order: same sort_order, so by name (Customer before Internal)
    expect(result.current.collapsedKeys).toEqual(['tag-2', 'tag-1', 'none']);
    act(() => result.current.expandAll());
    expect(result.current.collapsedKeys).toEqual([]);
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('does nothing without a current site', () => {
    useAppStore.setState({ currentSite: null });
    const { result } = renderHook(() => useGanttGrouping());
    act(() => result.current.setGroup(1));
    expect(result.current.siteId).toBeNull();
    expect(useViewStore.getState().ganttGrouping).toEqual({});
  });
});
