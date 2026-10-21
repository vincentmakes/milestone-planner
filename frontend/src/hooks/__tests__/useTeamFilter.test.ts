/**
 * useTeamFilter / useTeamFilteredProjects: the stored filter is read per
 * tenant + site (tagFilterKey), only the site's active teams are filter
 * options (a persisted id of a deleted or deactivated team is pruned) while
 * equipment scoping considers all the site's teams, and an inactive filter
 * hands back the very same projects array (view memoisation relies on it).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTeamFilter, useTeamFilteredProjects } from '../useTeamFilter';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { makeTeam } from '@/test/factories';
import type { Equipment, Project, Site, Staff } from '@/types';

const teams = [
  makeTeam({ id: 1, site_id: 1, name: 'Analytics' }),
  makeTeam({ id: 2, site_id: 1, name: 'Process' }),
  makeTeam({ id: 3, site_id: 1, name: 'Retired', active: false }),
  makeTeam({ id: 4, site_id: 2, name: 'Zurich lab' }),
];

function project(id: number, teamIds: number[]): Project {
  return { id, name: `P${id}`, site_id: 1, team_ids: teamIds } as unknown as Project;
}

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ teamFilters: {} });
  useAppStore.setState({ teams, currentSite: { id: 1, name: 'Basel' } as Site });
});

describe('useTeamFilter', () => {
  it('offers the active teams of the current site only, and no filter by default', () => {
    const { result } = renderHook(() => useTeamFilter());
    expect(result.current.siteId).toBe(1);
    expect(result.current.siteTeams.map((t) => t.id)).toEqual([1, 2]);
    expect(result.current.filter).toBeNull();
    expect(result.current.active).toBe(false);
    expect(result.current.projectMatches(project(1, []))).toBe(true);
  });

  it('prunes ids of deleted, inactive and other-site teams', () => {
    useViewStore.setState({ teamFilters: { ':1': { teamIds: [1, 3, 4, 999], noTeam: false } } });
    const { result } = renderHook(() => useTeamFilter());
    expect(result.current.filter).toEqual({ teamIds: [1], noTeam: false });
    expect(result.current.active).toBe(true);
  });

  it('treats a filter of an inactive team alone as Whole site', () => {
    useViewStore.setState({ teamFilters: { ':1': { teamIds: [3], noTeam: false } } });
    const { result } = renderHook(() => useTeamFilter());
    expect(result.current.siteTeams.some((t) => t.id === 3)).toBe(false);
    expect(result.current.filter).toBeNull();
    expect(result.current.active).toBe(false);
  });

  it('treats any stored filter as Whole site when the site has no active team', () => {
    useAppStore.setState({ teams: [makeTeam({ id: 3, site_id: 1, name: 'Retired', active: false })] });
    useViewStore.setState({ teamFilters: { ':1': { teamIds: [], noTeam: true } } });
    const { result } = renderHook(() => useTeamFilter());
    expect(result.current.siteTeams).toEqual([]);
    expect(result.current.filter).toBeNull();
    expect(result.current.active).toBe(false);
    expect(result.current.projectMatches(project(1, [3]))).toBe(true);
    expect(result.current.staffMatches({ team_ids: [3] } as Staff)).toBe(true);
    expect(result.current.equipmentMatches({ team_ids: [3] } as unknown as Equipment)).toBe(true);
  });

  it('reads the entry of the site that becomes current', () => {
    useViewStore.setState({
      teamFilters: {
        ':1': { teamIds: [1], noTeam: false },
        ':2': { teamIds: [], noTeam: true },
      },
    });
    const { result } = renderHook(() => useTeamFilter());
    expect(result.current.filter).toEqual({ teamIds: [1], noTeam: false });

    act(() => useAppStore.setState({ currentSite: { id: 2, name: 'Zurich' } as Site }));
    expect(result.current.siteTeams.map((t) => t.id)).toEqual([4]);
    expect(result.current.filter).toEqual({ teamIds: [], noTeam: true });
  });

  it('matches projects, staff rows and equipment against the filter', () => {
    useViewStore.setState({ teamFilters: { ':1': { teamIds: [1], noTeam: true } } });
    const { result } = renderHook(() => useTeamFilter());
    const { projectMatches, staffMatches, equipmentMatches } = result.current;

    expect(projectMatches(project(1, [1]))).toBe(true);
    expect(projectMatches(project(2, [2]))).toBe(false);
    expect(projectMatches(project(3, []))).toBe(true);
    expect(staffMatches({ team_ids: [2] } as Staff)).toBe(false);
    expect(staffMatches({ team_ids: [] } as unknown as Staff)).toBe(true);
    // Equipment with no team here is open to the whole site.
    expect(equipmentMatches({ team_ids: [4] } as unknown as Equipment)).toBe(true);
    expect(equipmentMatches({ team_ids: [2] } as unknown as Equipment)).toBe(false);
  });

  it('scopes equipment by every team of the site, inactive ones included', () => {
    // Restricted solely to the inactive team: not open to the whole site.
    const retiredOnly = { team_ids: [3] } as unknown as Equipment;
    useViewStore.setState({ teamFilters: { ':1': { teamIds: [1], noTeam: false } } });
    const { result } = renderHook(() => useTeamFilter());
    expect(result.current.equipmentMatches(retiredOnly)).toBe(false);

    act(() => useViewStore.setState({ teamFilters: {} }));
    expect(result.current.filter).toBeNull();
    expect(result.current.equipmentMatches(retiredOnly)).toBe(true);
  });

  it('keeps the predicates stable across renders while the filter is unchanged', () => {
    useViewStore.setState({ teamFilters: { ':1': { teamIds: [1], noTeam: false } } });
    const { result, rerender } = renderHook(() => useTeamFilter());
    const first = result.current;
    rerender();
    expect(result.current.projectMatches).toBe(first.projectMatches);
    expect(result.current.staffMatches).toBe(first.staffMatches);
    expect(result.current.equipmentMatches).toBe(first.equipmentMatches);
  });
});

describe('useTeamFilteredProjects', () => {
  const projects = [project(1, [1]), project(2, [2]), project(3, [])];

  it('returns the same array reference while the filter is inactive', () => {
    const { result, rerender } = renderHook(({ list }) => useTeamFilteredProjects(list), {
      initialProps: { list: projects },
    });
    expect(result.current).toBe(projects);

    // Only stale selections: still inactive, still the same array.
    act(() => useViewStore.setState({ teamFilters: { ':1': { teamIds: [3, 999], noTeam: false } } }));
    rerender({ list: projects });
    expect(result.current).toBe(projects);
  });

  it('narrows the projects while a selection is active', () => {
    useViewStore.setState({ teamFilters: { ':1': { teamIds: [1], noTeam: false } } });
    const { result } = renderHook(() => useTeamFilteredProjects(projects));
    expect(result.current.map((p) => p.id)).toEqual([1]);

    act(() => useViewStore.getState().setTeamFilter(1, { teamIds: [1], noTeam: true }));
    expect(result.current.map((p) => p.id)).toEqual([1, 3]);
  });
});
