/**
 * appStore: data setters (incl. the derived site-closure index), site switch
 * clearing undo history, critical-path toggling (dynamic import), persistence
 * of only the site id, and the exported selectors.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  selectAbsenceTypesById,
  selectCanManageOthersAbsences,
  selectStaffSiteIds,
  selectStaffTeamIds,
  selectTeamSiteById,
  useAppStore,
} from '../appStore';
import { useUndoStore } from '../undoStore';
import { resetAllStores } from '..';
import { makePhase, makeProject, makeProjectField, makeSite, makeStaff, makeTeam, makeUser } from '@/test/factories';
import type { CompanyEvent } from '@/types';

const KEY = 'milestone-app-storage-v3';
const app = () => useAppStore.getState();

beforeEach(() => {
  localStorage.clear();
  resetAllStores();
});

describe('data setters', () => {
  it('stores each slice', () => {
    const site = makeSite();
    app().setSites([site]);
    app().setStaff([makeStaff()]);
    app().setEquipment([]);
    app().setEquipmentBlocks([]);
    app().setVacations([]);
    app().setUsers([makeUser()]);
    app().setInstanceSettings({ instance_title: 'Lab' });
    app().setSkills([]);
    app().setTags([]);
    app().setProjectFields([makeProjectField()]);
    app().setTeams([makeTeam()]);
    app().setAbsenceTypes([]);
    app().setCurrentUser(makeUser({ id: 9 }));
    app().setAuthChecking(false);
    app().setAuthenticated(true);
    expect(app()).toMatchObject({
      sites: [site],
      instanceSettings: { instance_title: 'Lab' },
      isAuthChecking: false,
      isAuthenticated: true,
    });
    expect(app().staff).toHaveLength(1);
    expect(app().teams).toEqual([makeTeam()]);
    expect(app().projectFields).toEqual([makeProjectField()]);
    expect(app().currentUser?.id).toBe(9);
  });

  it('keeps holiday and event date sets and rebuilds the closure index', () => {
    const dates = new Set(['2026-08-01']);
    app().setBankHolidays([], dates);
    expect(app().bankHolidayDates).toBe(dates);

    const closure = {
      id: 1,
      site_id: 1,
      date: '2026-12-24',
      end_date: '2026-12-25',
      name: 'Shutdown',
      counts_as_unavailable: true,
    } as CompanyEvent;
    app().setCompanyEvents([closure], new Set(['2026-12-24', '2026-12-25']));
    expect(app().companyEvents).toEqual([closure]);
    expect(app().companyEventDates.size).toBe(2);
    expect(app().closureIndex.get('2026-12-24')).toEqual([closure]);
  });
});

describe('site selection', () => {
  it('clears undo history when the site changes, not when it is re-selected', () => {
    app().setCurrentSite(makeSite({ id: 1 }));
    useUndoStore.getState().saveState([], 'edit');
    app().setCurrentSite(makeSite({ id: 1, name: 'Basel (refetched)' }));
    expect(useUndoStore.getState().canUndo).toBe(true);

    app().setCurrentSite(makeSite({ id: 2 }));
    expect(useUndoStore.getState().canUndo).toBe(false);
    expect(app()._persistedSiteId).toBe(2);

    useUndoStore.getState().saveState([], 'edit');
    app().setCurrentSite(null);
    expect(useUndoStore.getState().canUndo).toBe(false);
    expect(app()._persistedSiteId).toBeNull();
  });

  it('persists only the site id and restores it on rehydrate', async () => {
    app().setCurrentSite(makeSite({ id: 3 }));
    app().setProjects([makeProject()]);
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state).toEqual({ currentSiteId: 3 });

    useAppStore.setState({ _persistedSiteId: null });
    localStorage.setItem(KEY, JSON.stringify(raw));
    await useAppStore.persist.rehydrate();
    expect(app()._persistedSiteId).toBe(3);
  });

  it('keeps the current id when nothing was persisted', async () => {
    useAppStore.setState({ _persistedSiteId: 5 });
    localStorage.setItem(KEY, JSON.stringify({ state: {}, version: 0 }));
    await useAppStore.persist.rehydrate();
    expect(app()._persistedSiteId).toBe(5);
  });

  it('logs a hydration error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(KEY, '{nope');
    await useAppStore.persist.rehydrate();
    expect(error).toHaveBeenCalledWith('[AppStore] Hydration error:', expect.anything());
    error.mockRestore();
  });

  it('reset() clears data and undo history', () => {
    app().setProjects([makeProject()]);
    app().setTeams([makeTeam()]);
    app().setProjectFields([makeProjectField()]);
    useUndoStore.getState().saveState([], 'edit');
    app().reset();
    expect(app().projects).toEqual([]);
    expect(app().teams).toEqual([]);
    expect(app().projectFields).toEqual([]);
    expect(app().isAuthChecking).toBe(true);
    expect(useUndoStore.getState().canUndo).toBe(false);
  });
});

describe('critical path', () => {
  // A -> B finish-to-start.
  const project = makeProject({
    id: 1,
    phases: [
      makePhase({ id: 10, start_date: '2026-01-05', end_date: '2026-01-16' }),
      makePhase({
        id: 11,
        start_date: '2026-01-19',
        end_date: '2026-01-30',
        dependencies: [{ id: 10, type: 'FS' }],
      }),
    ],
  });

  it('enables, computes, recalculates and disables a project', async () => {
    app().setProjects([project]);
    expect(app().isCriticalPathEnabled(1)).toBe(false);
    expect(app().getCriticalPathItems(1).size).toBe(0);

    app().toggleCriticalPath(1);
    expect(app().isCriticalPathEnabled(1)).toBe(true);
    await waitFor(() => expect(app().getCriticalPathItems(1).size).toBeGreaterThan(0));
    // The dependent (last) phase always ends the critical chain.
    expect(app().getCriticalPathItems(1).has('phase-11')).toBe(true);

    useAppStore.setState({ criticalPathItems: new Map() });
    app().recalculateCriticalPath(1);
    await waitFor(() => expect(app().getCriticalPathItems(1).has('phase-11')).toBe(true));

    app().toggleCriticalPath(1);
    expect(app().isCriticalPathEnabled(1)).toBe(false);
    expect(app().criticalPathItems.has(1)).toBe(false);
  });

  it('does nothing for disabled or unknown projects', async () => {
    app().setProjects([project]);
    app().recalculateCriticalPath(1);
    app().toggleCriticalPath(99);
    expect(app().isCriticalPathEnabled(99)).toBe(true);
    app().recalculateCriticalPath(99);
    await Promise.resolve();
    expect(app().criticalPathItems.size).toBe(0);
  });
});

describe('selectors', () => {
  it('selectStaffSiteIds groups the per-site staff rows and memoises on the array', () => {
    app().setStaff([
      makeStaff({ id: 4, site_id: 1 }),
      makeStaff({ id: 4, site_id: 2 }),
      makeStaff({ id: 5, site_id: 1 }),
    ]);
    const map = selectStaffSiteIds(app());
    expect(map.get(4)).toEqual(new Set([1, 2]));
    expect(map.get(5)).toEqual(new Set([1]));
    expect(selectStaffSiteIds(app())).toBe(map);
    app().setStaff([makeStaff({ id: 6, site_id: 3 })]);
    expect(selectStaffSiteIds(app())).not.toBe(map);
  });

  it('selectStaffTeamIds unions the teams of a user across rows and memoises on the array', () => {
    app().setStaff([
      makeStaff({ id: 4, site_id: 1, team_ids: [1, 2] }),
      makeStaff({ id: 4, site_id: 2, team_ids: [3] }),
      makeStaff({ id: 5, site_id: 1, team_ids: undefined }),
    ]);
    const map = selectStaffTeamIds(app());
    expect(map.get(4)).toEqual(new Set([1, 2, 3]));
    expect(map.get(5)).toEqual(new Set());
    expect(selectStaffTeamIds(app())).toBe(map);
    app().setStaff([makeStaff({ id: 6, site_id: 3, team_ids: [4] })]);
    const next = selectStaffTeamIds(app());
    expect(next).not.toBe(map);
    expect(next.get(6)).toEqual(new Set([4]));
  });

  it('selectTeamSiteById maps team ids to sites and memoises on the array', () => {
    app().setTeams([makeTeam({ id: 1, site_id: 1 }), makeTeam({ id: 2, site_id: 2 })]);
    const map = selectTeamSiteById(app());
    expect([...map]).toEqual([[1, 1], [2, 2]]);
    expect(selectTeamSiteById(app())).toBe(map);
    app().setTeams([makeTeam({ id: 3, site_id: 1 })]);
    const next = selectTeamSiteById(app());
    expect(next).not.toBe(map);
    expect([...next]).toEqual([[3, 1]]);
  });

  it('selectAbsenceTypesById indexes by id and memoises on the array', () => {
    const types = [
      { id: 1, name: 'Holidays', color: '#8b5cf6', counts_as_unavailable: true, sort_order: 0, is_active: true },
      { id: 2, name: 'Home Office', color: '#0ea5e9', counts_as_unavailable: false, sort_order: 1, is_active: true },
    ];
    app().setAbsenceTypes(types);
    const map = selectAbsenceTypesById(app());
    expect(map.get(2)?.name).toBe('Home Office');
    expect(map.size).toBe(2);
    // Same array -> same Map (no re-render loop, no per-bar rebuild)
    expect(selectAbsenceTypesById(app())).toBe(map);
    expect(selectAbsenceTypesById({ ...app(), absenceTypes: types })).toBe(map);

    app().setAbsenceTypes([types[0]]);
    const next = selectAbsenceTypesById(app());
    expect(next).not.toBe(map);
    expect([...next.keys()]).toEqual([1]);
  });

  it('selectCanManageOthersAbsences follows absences.manage_others', () => {
    expect(selectCanManageOthersAbsences(app())).toBe(false);
    app().setCurrentUser(makeUser({ role: 'admin' }));
    expect(selectCanManageOthersAbsences(app())).toBe(true);
    app().setCurrentUser(makeUser({ role: 'superuser' }));
    expect(selectCanManageOthersAbsences(app())).toBe(true);
    app().setCurrentUser(makeUser({ role: 'user' }));
    expect(selectCanManageOthersAbsences(app())).toBe(false);
    app().setCurrentUser(makeUser({ role: 'team_lead', permissions: ['absences.manage_others'] }));
    expect(selectCanManageOthersAbsences(app())).toBe(true);
  });
});
