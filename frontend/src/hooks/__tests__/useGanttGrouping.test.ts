/**
 * useGanttGrouping: the Gantt grouping (a dropdown project field) is read and
 * written per tenant + site (siteKey), the choices are the dropdown fields
 * with an item at the site, a stale field id reads as "not grouped" without a
 * write, and removing the grouping drops the site's collapsed sections.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGanttGrouping } from '../useGanttGrouping';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { makeProjectField, makeProjectFieldOption } from '@/test/factories';
import type { Site } from '@/types';

const TYPE = makeProjectField({
  id: 1,
  name: 'Project type',
  field_type: 'select',
  options: [
    makeProjectFieldOption({ id: 11, name: 'Internal' }),
    makeProjectFieldOption({ id: 12, name: 'Customer' }),
  ],
});
// Area's only item applies to site 2 alone.
const AREA = makeProjectField({
  id: 2,
  name: 'Area',
  field_type: 'multiselect',
  sort_order: 1,
  options: [makeProjectFieldOption({ id: 21, name: 'Bio', all_sites: false, site_ids: [2] })],
});
const NOTES = makeProjectField({ id: 3, name: 'Notes', field_type: 'text' });

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ ganttGrouping: {}, collapsedGanttSections: {} });
  useAppStore.setState({ projectFields: [AREA, NOTES, TYPE], currentSite: { id: 1, name: 'Basel' } as Site });
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('useGanttGrouping', () => {
  it('offers the dropdown fields with an item at the site, in display order', () => {
    const { result } = renderHook(() => useGanttGrouping());
    expect(result.current.fields.map((f) => f.id)).toEqual([1]);

    act(() => useAppStore.setState({ currentSite: { id: 2, name: 'Zurich' } as Site }));
    expect(result.current.fields.map((f) => f.id)).toEqual([1, 2]);
  });

  it('reads the grouping of the current tenant and site only', () => {
    window.history.pushState({}, '', '/t/acme/');
    useViewStore.setState({
      ganttGrouping: { 'acme:1': 1, 'globex:1': 2, 'acme:2': 2 },
      collapsedGanttSections: { 'acme:1': ['field-11'], 'globex:1': ['none'] },
    });
    const { result } = renderHook(() => useGanttGrouping());
    expect(result.current.field?.id).toBe(1);
    expect(result.current.field?.options.map((o) => o.id)).toEqual([11, 12]);
    expect(result.current.collapsedKeys).toEqual(['field-11']);

    act(() => useAppStore.setState({ currentSite: { id: 2, name: 'Zurich' } as Site }));
    expect(result.current.field?.id).toBe(2);
    expect(result.current.collapsedKeys).toEqual([]);
  });

  it('writes under the tenant + site key it reads', () => {
    window.history.pushState({}, '', '/t/acme/');
    const { result } = renderHook(() => useGanttGrouping());
    act(() => result.current.setField(1));
    act(() => result.current.toggleSection('none'));
    expect(useViewStore.getState().ganttGrouping).toEqual({ 'acme:1': 1 });
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ 'acme:1': ['none'] });
    expect(result.current.field?.id).toBe(1);
    expect(result.current.collapsedKeys).toEqual(['none']);

    act(() => result.current.toggleSection('none'));
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('treats a stale field id as not grouped, without writing', () => {
    // 99 does not exist, 3 is a text field, 2 has no item at site 1
    for (const stale of [99, 3, 2]) {
      useViewStore.setState({ ganttGrouping: { ':1': stale }, collapsedGanttSections: { ':1': ['field-5'] } });
      const { result, unmount } = renderHook(() => useGanttGrouping());
      expect(result.current.field).toBeNull();
      expect(result.current.collapsedKeys).toEqual([]);
      expect(useViewStore.getState().ganttGrouping).toEqual({ ':1': stale });
      unmount();
    }
  });

  it('setField(null) clears the grouping and the collapsed sections', () => {
    useViewStore.setState({
      ganttGrouping: { ':1': 1, ':2': 2 },
      collapsedGanttSections: { ':1': ['field-11'], ':2': ['none'] },
    });
    const { result } = renderHook(() => useGanttGrouping());
    act(() => result.current.setField(null));
    expect(result.current.field).toBeNull();
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':2': 2 });
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':2': ['none'] });
  });

  it('collapses every section of the field at the site, and expands them all', () => {
    useViewStore.setState({ ganttGrouping: { ':1': 1 } });
    const { result } = renderHook(() => useGanttGrouping());
    act(() => result.current.collapseAll());
    // Item order
    expect(result.current.collapsedKeys).toEqual(['field-11', 'field-12', 'none']);
    act(() => result.current.expandAll());
    expect(result.current.collapsedKeys).toEqual([]);
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('collapse all does nothing while not grouped', () => {
    const { result } = renderHook(() => useGanttGrouping());
    act(() => result.current.collapseAll());
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('does nothing without a current site', () => {
    useAppStore.setState({ currentSite: null });
    const { result } = renderHook(() => useGanttGrouping());
    act(() => result.current.setField(1));
    act(() => result.current.toggleSection('none'));
    act(() => result.current.expandAll());
    expect(result.current.siteId).toBeNull();
    expect(useViewStore.getState().ganttGrouping).toEqual({});
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });
});
