/**
 * useGanttColorBy: the Gantt "Colour by" group is read and written per
 * tenant + site (tagFilterKey), a stale group id reads as "default colours"
 * without a write, and it is independent of the Group by preference.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGanttColorBy } from '../useGanttColorBy';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import type { Site, TagGroup } from '@/types';

const TYPE: TagGroup = { id: 1, name: 'Project type', single_select: true, sort_order: 0 };
const AREA: TagGroup = { id: 2, name: 'Area', single_select: false, sort_order: 1 };

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ ganttColorBy: {}, ganttGrouping: {}, collapsedGanttSections: {} });
  useAppStore.setState({ tags: [], tagGroups: [TYPE, AREA], currentSite: { id: 1, name: 'Basel' } as Site });
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('useGanttColorBy', () => {
  it('reads the colouring of the current tenant and site only', () => {
    window.history.pushState({}, '', '/t/acme/');
    useViewStore.setState({ ganttColorBy: { 'acme:1': 1, 'globex:1': 2, 'acme:2': 2 } });
    const { result } = renderHook(() => useGanttColorBy());
    expect(result.current.siteId).toBe(1);
    expect(result.current.group).toBe(TYPE);

    act(() => useAppStore.setState({ currentSite: { id: 2, name: 'Zurich' } as Site }));
    expect(result.current.group).toBe(AREA);

    act(() => useAppStore.setState({ currentSite: { id: 3, name: 'Bern' } as Site }));
    expect(result.current.group).toBeNull();
  });

  it('writes under the tenant + site key it reads, leaving Group by alone', () => {
    window.history.pushState({}, '', '/t/acme/');
    useViewStore.setState({ ganttGrouping: { 'acme:1': 1 } });
    const { result } = renderHook(() => useGanttColorBy());
    act(() => result.current.setGroup(2));
    expect(useViewStore.getState().ganttColorBy).toEqual({ 'acme:1': 2 });
    expect(useViewStore.getState().ganttGrouping).toEqual({ 'acme:1': 1 });
    expect(result.current.group).toBe(AREA);
  });

  it('treats a stale group id as default colours, without writing', () => {
    useViewStore.setState({ ganttColorBy: { ':1': 99 } });
    const { result } = renderHook(() => useGanttColorBy());
    expect(result.current.group).toBeNull();
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':1': 99 });
  });

  it('setGroup(null) removes only the current site\'s entry', () => {
    useViewStore.setState({ ganttColorBy: { ':1': 1, ':2': 2 } });
    const { result } = renderHook(() => useGanttColorBy());
    act(() => result.current.setGroup(null));
    expect(result.current.group).toBeNull();
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':2': 2 });
  });

  it('does nothing without a current site', () => {
    useAppStore.setState({ currentSite: null });
    const { result } = renderHook(() => useGanttColorBy());
    act(() => result.current.setGroup(1));
    expect(result.current.siteId).toBeNull();
    expect(result.current.group).toBeNull();
    expect(useViewStore.getState().ganttColorBy).toEqual({});
  });
});
