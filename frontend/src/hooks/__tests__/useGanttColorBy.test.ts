/**
 * useGanttColorBy: the Gantt "Colour by" choice (a dropdown project field or
 * the tags) is read and written per tenant + site (siteKey), a stale field id
 * reads as "default colours" without a write, `'tags'` always resolves, and
 * it is independent of the Group by preference.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGanttColorBy } from '../useGanttColorBy';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { makeProjectField, makeProjectFieldOption } from '@/test/factories';
import type { Site } from '@/types';

const TYPE = makeProjectField({
  id: 1,
  name: 'Project type',
  options: [makeProjectFieldOption({ id: 11, name: 'Internal' })],
});
// Area's only item applies to site 2 alone.
const AREA = makeProjectField({
  id: 2,
  name: 'Area',
  field_type: 'multiselect',
  sort_order: 1,
  options: [makeProjectFieldOption({ id: 21, name: 'Bio', all_sites: false, site_ids: [2] })],
});

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ ganttColorBy: {}, ganttGrouping: {}, collapsedGanttSections: {} });
  useAppStore.setState({ tags: [], projectFields: [TYPE, AREA], currentSite: { id: 1, name: 'Basel' } as Site });
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('useGanttColorBy', () => {
  it('reads the colouring of the current tenant and site only', () => {
    window.history.pushState({}, '', '/t/acme/');
    useViewStore.setState({ ganttColorBy: { 'acme:1': 1, 'globex:1': 2, 'acme:2': 2, 'acme:3': 'tags' } });
    const { result } = renderHook(() => useGanttColorBy());
    expect(result.current.siteId).toBe(1);
    expect(result.current.colorBy).toMatchObject({ id: 1 });
    expect(result.current.fields.map((f) => f.id)).toEqual([1]);

    act(() => useAppStore.setState({ currentSite: { id: 2, name: 'Zurich' } as Site }));
    expect(result.current.colorBy).toMatchObject({ id: 2 });

    act(() => useAppStore.setState({ currentSite: { id: 3, name: 'Bern' } as Site }));
    expect(result.current.colorBy).toBe('tags');

    act(() => useAppStore.setState({ currentSite: { id: 4, name: 'Geneva' } as Site }));
    expect(result.current.colorBy).toBeNull();
  });

  it('writes under the tenant + site key it reads, leaving Group by alone', () => {
    window.history.pushState({}, '', '/t/acme/');
    useViewStore.setState({ ganttGrouping: { 'acme:1': 1 } });
    const { result } = renderHook(() => useGanttColorBy());
    act(() => result.current.setColorBy('tags'));
    expect(useViewStore.getState().ganttColorBy).toEqual({ 'acme:1': 'tags' });
    expect(useViewStore.getState().ganttGrouping).toEqual({ 'acme:1': 1 });
    expect(result.current.colorBy).toBe('tags');

    act(() => result.current.setColorBy(1));
    expect(useViewStore.getState().ganttColorBy).toEqual({ 'acme:1': 1 });
    expect(result.current.colorBy).toMatchObject({ id: 1, name: 'Project type' });
  });

  it('treats a stale field id as default colours, without writing', () => {
    // 99 does not exist, 2 has no item at site 1
    useViewStore.setState({ ganttColorBy: { ':1': 99 } });
    const { result } = renderHook(() => useGanttColorBy());
    expect(result.current.colorBy).toBeNull();
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':1': 99 });

    act(() => useViewStore.setState({ ganttColorBy: { ':1': 2 } }));
    expect(result.current.colorBy).toBeNull();
  });

  it("setColorBy(null) removes only the current site's entry", () => {
    useViewStore.setState({ ganttColorBy: { ':1': 1, ':2': 'tags' } });
    const { result } = renderHook(() => useGanttColorBy());
    act(() => result.current.setColorBy(null));
    expect(result.current.colorBy).toBeNull();
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':2': 'tags' });
  });

  it('does nothing without a current site', () => {
    useAppStore.setState({ currentSite: null });
    const { result } = renderHook(() => useGanttColorBy());
    act(() => result.current.setColorBy(1));
    expect(result.current.siteId).toBeNull();
    expect(result.current.colorBy).toBeNull();
    expect(useViewStore.getState().ganttColorBy).toEqual({});
  });
});
