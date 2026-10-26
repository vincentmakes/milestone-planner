/**
 * useSiteProjectFilter / useFilteredProjects: the stored filter is read per
 * tenant + site (siteKey), stale and hidden selections are pruned the way the
 * ProjectFilterDropdown shows them, options are narrowed by the header team
 * filter while projects resolve against every item and tag of the site, and
 * an inactive filter hands back the very same projects array (Gantt/Kanban
 * memoisation relies on it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSiteProjectFilter, useFilteredProjects } from '../useProjectFilter';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { makeProject, makeProjectField, makeProjectFieldOption, makeTag, makeTeam } from '@/test/factories';
import type { Project, ProjectFieldValue, Site } from '@/types';

// Type (select): Internal (10) / Customer (11)
// Area (multiselect): Bio (20), only at site 2
const TYPE = makeProjectField({
  id: 1,
  name: 'Project type',
  field_type: 'select',
  options: [
    makeProjectFieldOption({ id: 10, name: 'Internal' }),
    makeProjectFieldOption({ id: 11, name: 'Customer' }),
  ],
});
const AREA = makeProjectField({
  id: 2,
  name: 'Area',
  field_type: 'multiselect',
  sort_order: 1,
  options: [makeProjectFieldOption({ id: 20, name: 'Bio', all_sites: false, site_ids: [2] })],
});
const NOTES = makeProjectField({ id: 3, name: 'Notes', field_type: 'text' });
const pilot = makeTag({ id: 30, name: 'Pilot' });
const zurichTag = makeTag({ id: 31, name: 'Zurich only', all_sites: false, site_ids: [2] });

function project(id: number, values: Record<number, ProjectFieldValue> = {}, tagIds: number[] = []): Project {
  return makeProject({
    id,
    name: `P${id}`,
    field_values: values,
    tags: tagIds.map((t) => ({ id: t, name: '', color: '' })),
  });
}

const empty = { optionIds: [], noneFieldIds: [], tagIds: [] };

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ projectFilters: {}, teamFilters: {} });
  useAppStore.setState({
    projectFields: [TYPE, AREA, NOTES],
    tags: [pilot, zurichTag],
    teams: [],
    currentSite: { id: 1, name: 'Basel' } as Site,
  });
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('useSiteProjectFilter', () => {
  it('offers the dropdown fields and tags of the site', () => {
    const { result } = renderHook(() => useSiteProjectFilter());
    expect(result.current.siteFields.map((f) => f.id)).toEqual([1]);
    expect(result.current.allSiteFields.map((f) => f.id)).toEqual([1]);
    expect(result.current.siteTags.map((t) => t.id)).toEqual([30]);
    expect(result.current.allSiteTags.map((t) => t.id)).toEqual([30]);

    act(() => useAppStore.setState({ currentSite: { id: 2, name: 'Zurich' } as Site }));
    expect(result.current.siteFields.map((f) => f.id)).toEqual([1, 2]);
    expect(result.current.siteTags.map((t) => t.id)).toEqual([30, 31]);
  });

  it('reads the filter stored for the current tenant and site only', () => {
    window.history.pushState({}, '', '/t/acme/');
    useViewStore.setState({
      projectFilters: {
        'acme:1': { ...empty, optionIds: [10] },
        'globex:1': { ...empty, optionIds: [11] },
        ':1': { ...empty, tagIds: [30] },
        'acme:2': { ...empty, optionIds: [20] },
      },
    });
    const { result } = renderHook(() => useSiteProjectFilter());
    expect(result.current.filter).toEqual({ ...empty, optionIds: [10] });
    expect(result.current.activeCount).toBe(1);

    act(() => useAppStore.setState({ currentSite: { id: 2, name: 'Zurich' } as Site }));
    expect(result.current.filter).toEqual({ ...empty, optionIds: [20] });
  });

  it("does not apply another tenant's filter for the same site id", () => {
    window.history.pushState({}, '', '/t/globex/');
    useViewStore.setState({ projectFilters: { 'acme:1': { optionIds: [10], noneFieldIds: [1], tagIds: [30] } } });
    const { result } = renderHook(() => useSiteProjectFilter());
    expect(result.current.activeCount).toBe(0);
  });

  it('writes through setProjectFilter land under the tenant + site key it reads', () => {
    window.history.pushState({}, '', '/t/acme/');
    const { result } = renderHook(() => useSiteProjectFilter());
    act(() => useViewStore.getState().setProjectFilter(1, { ...empty, optionIds: [11] }));
    expect(Object.keys(useViewStore.getState().projectFilters)).toEqual(['acme:1']);
    expect(result.current.filter.optionIds).toEqual([11]);
  });

  it('prunes items and tags of other sites and "(None)" of fields not shown at the site', () => {
    useViewStore.setState({
      projectFilters: { ':1': { optionIds: [10, 20, 999], noneFieldIds: [1, 2, 3, 77], tagIds: [30, 31] } },
    });
    const { result } = renderHook(() => useSiteProjectFilter());
    // Area (2) has no item at site 1 and Notes (3) is no dropdown, so the
    // dropdown shows no "(None)" for them: they must not count as selected.
    expect(result.current.filter).toEqual({ optionIds: [10], noneFieldIds: [1], tagIds: [30] });
    expect(result.current.activeCount).toBe(3);

    act(() => {
      useAppStore.setState({ currentSite: { id: 2, name: 'Zurich' } as Site });
      useViewStore.setState({
        projectFilters: { ':2': { optionIds: [10, 20, 999], noneFieldIds: [1, 2, 3, 77], tagIds: [30, 31] } },
      });
    });
    expect(result.current.filter).toEqual({ optionIds: [10, 20], noneFieldIds: [1, 2], tagIds: [30, 31] });
  });
});

describe('useSiteProjectFilter under the header team filter', () => {
  // Team A (1) and team B (2) at site 1; the "Team B" item of Project type
  // and the "B tag" are restricted to team B. "Only B" is a field whose one
  // item is restricted to team B.
  const teamItem = makeProjectFieldOption({ id: 12, name: 'Team B', team_ids: [2] });
  const TEAM_TYPE = { ...TYPE, options: [...TYPE.options, teamItem] };
  const ONLY_B = makeProjectField({
    id: 4,
    name: 'Only B',
    sort_order: 2,
    options: [makeProjectFieldOption({ id: 40, name: 'B item', team_ids: [2] })],
  });
  const bTag = makeTag({ id: 32, name: 'B tag', team_ids: [2] });

  beforeEach(() => {
    useAppStore.setState({
      projectFields: [TEAM_TYPE, ONLY_B],
      tags: [pilot, bTag],
      teams: [makeTeam({ id: 1, site_id: 1, name: 'A' }), makeTeam({ id: 2, site_id: 1, name: 'B' })],
    });
    useViewStore.setState({ projectFilters: { ':1': { optionIds: [12, 40], noneFieldIds: [4], tagIds: [32] } } });
  });

  it('offers items and tags restricted to team B under Whole site', () => {
    const { result } = renderHook(() => useSiteProjectFilter());
    expect(result.current.siteFields.map((f) => [f.id, f.options.map((o) => o.id)])).toEqual([
      [1, [10, 11, 12]],
      [4, [40]],
    ]);
    expect(result.current.siteTags.map((t) => t.id)).toEqual([30, 32]);
    expect(result.current.filter).toEqual({ optionIds: [12, 40], noneFieldIds: [4], tagIds: [32] });
  });

  it('omits them under team A and ignores the stored selections of them', () => {
    useViewStore.setState({ teamFilters: { ':1': { teamIds: [1], noTeam: false } } });
    const { result } = renderHook(() => useSiteProjectFilter());
    expect(result.current.siteFields.map((f) => [f.id, f.options.map((o) => o.id)])).toEqual([[1, [10, 11]]]);
    // Resolution keeps every item of the site
    expect(result.current.allSiteFields.map((f) => [f.id, f.options.map((o) => o.id)])).toEqual([
      [1, [10, 11, 12]],
      [4, [40]],
    ]);
    expect(result.current.siteTags.map((t) => t.id)).toEqual([30]);
    expect(result.current.allSiteTags.map((t) => t.id)).toEqual([30, 32]);
    expect(result.current.filter).toEqual(empty);
    expect(result.current.activeCount).toBe(0);

    act(() => useViewStore.setState({ teamFilters: { ':1': { teamIds: [2], noTeam: false } } }));
    expect(result.current.filter).toEqual({ optionIds: [12, 40], noneFieldIds: [4], tagIds: [32] });
  });

  it('keeps the same field object when the team filter hides none of its items', () => {
    useViewStore.setState({ teamFilters: { ':1': { teamIds: [2], noTeam: false } } });
    const { result } = renderHook(() => useSiteProjectFilter());
    expect(result.current.siteFields[0]).toBe(result.current.allSiteFields[0]);
  });

  it('still resolves a hidden item on a visible project, so it does not count as "(None)"', () => {
    // A project in teams A and B is visible under filter A and holds the
    // team-B item of Project type, whose "(None)" option stays offered.
    const held = { ...project(1, { 1: 12 }), team_ids: [1, 2] } as Project;
    const without = project(2);
    useViewStore.setState({
      teamFilters: { ':1': { teamIds: [1], noTeam: false } },
      projectFilters: { ':1': { ...empty, noneFieldIds: [1] } },
    });
    const { result } = renderHook(() => useFilteredProjects([held, without]));
    expect(result.current.map((p) => p.id)).toEqual([2]);
  });
});

describe('useFilteredProjects', () => {
  const projects = [project(1, { 1: 10 }), project(2, { 1: 11 }, [30]), project(3)];

  it('returns the same array reference while the filter is inactive', () => {
    const { result, rerender } = renderHook(({ list }) => useFilteredProjects(list), {
      initialProps: { list: projects },
    });
    expect(result.current).toBe(projects);

    // Only stale / hidden selections: still inactive, still the same array.
    act(() =>
      useViewStore.setState({ projectFilters: { ':1': { optionIds: [20, 999], noneFieldIds: [2], tagIds: [31] } } })
    );
    rerender({ list: projects });
    expect(result.current).toBe(projects);
  });

  it('narrows the projects while a selection is active', () => {
    useViewStore.setState({ projectFilters: { ':1': { ...empty, optionIds: [10] } } });
    const { result } = renderHook(() => useFilteredProjects(projects));
    expect(result.current.map((p) => p.id)).toEqual([1]);

    act(() => useViewStore.getState().setProjectFilter(1, { ...empty, optionIds: [10], noneFieldIds: [1] }));
    expect(result.current.map((p) => p.id)).toEqual([1, 3]);

    act(() => useViewStore.getState().setProjectFilter(1, { ...empty, tagIds: [30] }));
    expect(result.current.map((p) => p.id)).toEqual([2]);
  });
});
