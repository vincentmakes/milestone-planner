/**
 * Initial data load after sign-in and the granular refreshers the WebSocket
 * layer calls: parallel load into the stores, optional endpoints that may
 * fail, site resolution (persisted site, else the lowest id), the site's
 * calendar and custom columns, and the error state.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { selectSite, useDataLoader } from '../useDataLoader';
import { ApiError } from '@/api/client';
import { resetAllStores, useAppStore, useCustomColumnStore } from '@/stores';
import * as api from '@/api';
import {
  makeCustomColumn,
  makeEquipment,
  makeProject,
  makeProjectField,
  makeSite,
  makeStaff,
  makeTag,
  makeTeam,
  makeUser,
  makeVacation,
} from '@/test/factories';

vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api')>()),
  getSites: vi.fn(),
  getStaff: vi.fn(),
  getEquipment: vi.fn(),
  getEquipmentBlocks: vi.fn(),
  getVacations: vi.fn(),
  loadAllProjects: vi.fn(),
  getBankHolidays: vi.fn(),
  getCompanyEvents: vi.fn(),
  getInstanceSettings: vi.fn(),
  getCustomColumnsWithValues: vi.fn(),
  skillsApi: { getAll: vi.fn() },
  tagsApi: { getAll: vi.fn() },
  projectFieldsApi: { getAll: vi.fn() },
  teamsApi: { getAll: vi.fn() },
  absenceTypesApi: { getAll: vi.fn() },
}));

const m = vi.mocked(api);
const sites = [makeSite({ id: 3, name: 'Zurich' }), makeSite({ id: 1, name: 'Basel' })];
const holiday = { id: 1, site_id: 1, date: '2026-08-01', name: 'National Day', is_custom: false };
const event = { id: 2, site_id: 1, date: '2026-05-04', name: 'Audit' };
const absenceType = {
  id: 1,
  name: 'Holidays',
  color: '#f00',
  counts_as_unavailable: true,
  sort_order: 0,
  is_active: true,
};

function happyPath() {
  m.getSites.mockResolvedValue(sites);
  m.getStaff.mockResolvedValue([makeStaff()]);
  m.getEquipment.mockResolvedValue([makeEquipment()]);
  m.getEquipmentBlocks.mockResolvedValue([]);
  m.getVacations.mockResolvedValue([makeVacation()]);
  m.loadAllProjects.mockResolvedValue([makeProject()]);
  m.getBankHolidays.mockResolvedValue([holiday]);
  m.getCompanyEvents.mockResolvedValue([event]);
  m.getInstanceSettings.mockResolvedValue({ instance_title: 'Lab' } as never);
  m.getCustomColumnsWithValues.mockResolvedValue({
    columns: [makeCustomColumn()],
    values: { '1-project-1': 'High' },
  } as never);
  vi.mocked(m.skillsApi.getAll).mockResolvedValue([{ id: 1, name: 'HPLC', color: '#000' }]);
  vi.mocked(m.tagsApi.getAll).mockResolvedValue([makeTag()]);
  vi.mocked(m.projectFieldsApi.getAll).mockResolvedValue([makeProjectField()]);
  vi.mocked(m.teamsApi.getAll).mockResolvedValue([makeTeam()]);
  vi.mocked(m.absenceTypesApi.getAll).mockResolvedValue([absenceType]);
}

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  useAppStore.setState({ _persistedSiteId: null, currentUser: makeUser() });
  happyPath();
});

describe('useDataLoader.loadAllData', () => {
  it('loads everything into the stores and opens the lowest-id site', async () => {
    const { result } = renderHook(() => useDataLoader());
    await act(() => result.current.loadAllData());

    const s = useAppStore.getState();
    expect(m.getStaff).toHaveBeenCalledWith(true);
    expect(m.getEquipment).toHaveBeenCalledWith(true);
    expect(s.sites).toEqual(sites);
    expect(s.staff).toHaveLength(1);
    expect(s.equipment).toHaveLength(1);
    expect(s.vacations).toHaveLength(1);
    expect(s.skills).toHaveLength(1);
    expect(s.tags).toHaveLength(1);
    expect(s.projectFields).toEqual([makeProjectField()]);
    expect(m.teamsApi.getAll).toHaveBeenCalledWith();
    expect(s.teams).toEqual([makeTeam()]);
    expect(s.absenceTypes).toEqual([absenceType]);
    expect(s.instanceSettings).toEqual({ instance_title: 'Lab' });
    expect(s.currentSite?.id).toBe(1);
    expect(m.getBankHolidays).toHaveBeenCalledWith(1);
    expect(s.bankHolidays).toEqual([holiday]);
    expect(s.bankHolidayDates.has('2026-08-01')).toBe(true);
    expect(s.companyEvents).toEqual([event]);
    expect(s.companyEventDates.has('2026-05-04')).toBe(true);
    expect(useCustomColumnStore.getState().customColumns).toHaveLength(1);
    expect(useCustomColumnStore.getState().customColumnValues).toEqual({ '1-project-1': 'High' });
    expect(s.projects).toHaveLength(1);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('restores the persisted site, and falls back when it no longer exists', async () => {
    useAppStore.setState({ _persistedSiteId: 3 });
    const { result } = renderHook(() => useDataLoader());
    await act(() => result.current.loadAllData());
    expect(useAppStore.getState().currentSite?.id).toBe(3);
    expect(m.getCompanyEvents).toHaveBeenCalledWith(3);

    useAppStore.setState({ _persistedSiteId: 42 });
    await act(() => result.current.loadAllData());
    expect(useAppStore.getState().currentSite?.id).toBe(1);
  });

  it('opens a site the user can see, never a persisted one outside', async () => {
    useAppStore.setState({ _persistedSiteId: 1, currentUser: makeUser({ role: 'superuser', site_ids: [3] }) });
    const { result } = renderHook(() => useDataLoader());
    await act(() => result.current.loadAllData());
    expect(useAppStore.getState().currentSite?.id).toBe(3);
    expect(m.getBankHolidays).toHaveBeenCalledWith(3);
  });

  it('does not ask for equipment without views.equipment', async () => {
    useAppStore.setState({
      currentUser: makeUser({ role: 'viewer', permissions: ['projects.view'], can_see_all_sites: true }),
      equipment: [makeEquipment()],
    });
    const { result } = renderHook(() => useDataLoader());
    await act(() => result.current.loadAllData());
    expect(result.current.error).toBeNull();
    expect(m.getEquipment).not.toHaveBeenCalled();
    expect(m.getEquipmentBlocks).not.toHaveBeenCalled();
    expect(useAppStore.getState().equipment).toEqual([]);
    expect(useAppStore.getState().equipmentBlocks).toEqual([]);
  });

  it('treats a 403 on equipment as an empty slice, other failures as a load error', async () => {
    m.getEquipment.mockRejectedValue(new ApiError('Permission required: views.equipment', 403));
    const { result } = renderHook(() => useDataLoader());
    await act(() => result.current.loadAllData());
    expect(result.current.error).toBeNull();
    expect(useAppStore.getState().equipment).toEqual([]);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.getEquipment.mockRejectedValue(new ApiError('Server error', 500));
    await act(() => result.current.loadAllData());
    expect(result.current.error).toBe('Server error');
    err.mockRestore();
  });

  it('tolerates optional endpoints failing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.getEquipmentBlocks.mockRejectedValue(new Error('x'));
    m.getInstanceSettings.mockRejectedValue(new Error('x'));
    vi.mocked(m.skillsApi.getAll).mockRejectedValue(new Error('x'));
    vi.mocked(m.tagsApi.getAll).mockRejectedValue(new Error('x'));
    vi.mocked(m.projectFieldsApi.getAll).mockRejectedValue(new Error('x'));
    vi.mocked(m.teamsApi.getAll).mockRejectedValue(new Error('x'));
    vi.mocked(m.absenceTypesApi.getAll).mockRejectedValue(new Error('x'));
    m.getCustomColumnsWithValues.mockRejectedValue(new Error('no columns'));
    // Seeded so `teams` ending up empty proves the failed load was caught and cleared.
    useAppStore.setState({ teams: [makeTeam()] });

    const { result } = renderHook(() => useDataLoader());
    await act(() => result.current.loadAllData());

    expect(result.current.error).toBeNull();
    const s = useAppStore.getState();
    expect(s.equipmentBlocks).toEqual([]);
    expect(s.skills).toEqual([]);
    expect(s.teams).toEqual([]);
    expect(s.instanceSettings).toBeNull();
    expect(s.projects).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('[DataLoader] Failed to load custom columns:', expect.any(Error));
    warn.mockRestore();
  });

  it('skips site data when there are no sites', async () => {
    m.getSites.mockResolvedValue([]);
    const { result } = renderHook(() => useDataLoader());
    await act(() => result.current.loadAllData());
    expect(useAppStore.getState().currentSite).toBeNull();
    expect(m.getBankHolidays).not.toHaveBeenCalled();
    expect(useAppStore.getState().projects).toHaveLength(1);
  });

  it('reports a failed required load', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.getSites.mockRejectedValue(new Error('Session expired'));
    const { result } = renderHook(() => useDataLoader());
    await act(() => result.current.loadAllData());
    expect(result.current.error).toBe('Session expired');
    expect(result.current.isLoading).toBe(false);

    m.getSites.mockRejectedValue('boom');
    await act(() => result.current.loadAllData());
    expect(result.current.error).toBe('Failed to load data');
    err.mockRestore();
  });
});

describe('useDataLoader refreshers', () => {
  it('refresh each slice', async () => {
    const { result } = renderHook(() => useDataLoader());
    await act(async () => {
      await result.current.refreshProjects();
      await result.current.refreshSiteData(7);
      await result.current.refreshCustomColumns(7);
      await result.current.refreshStaff();
      await result.current.refreshEquipmentBlocks();
      await result.current.refreshAbsenceTypes();
      await result.current.refreshTeams();
    });
    const s = useAppStore.getState();
    expect(s.projects).toHaveLength(1);
    expect(m.getBankHolidays).toHaveBeenCalledWith(7);
    expect(m.getCompanyEvents).toHaveBeenCalledWith(7);
    expect(s.bankHolidays).toEqual([holiday]);
    expect(m.getCustomColumnsWithValues).toHaveBeenCalledWith(7);
    expect(useCustomColumnStore.getState().customColumns).toHaveLength(1);
    expect(s.staff).toHaveLength(1);
    expect(m.getEquipmentBlocks).toHaveBeenCalled();
    expect(s.absenceTypes).toEqual([absenceType]);
    expect(s.teams).toEqual([makeTeam()]);
  });

  it('empties the equipment blocks without views.equipment, without a request', async () => {
    useAppStore.setState({
      currentUser: makeUser({ role: 'viewer', permissions: ['projects.view'] }),
      equipmentBlocks: [{ id: 1 } as never],
    });
    const { result } = renderHook(() => useDataLoader());
    await act(() => result.current.refreshEquipmentBlocks());
    expect(m.getEquipmentBlocks).not.toHaveBeenCalled();
    expect(useAppStore.getState().equipmentBlocks).toEqual([]);
  });

  it('log and keep the current data when a refresh fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAppStore.setState({
      projects: [makeProject({ id: 9 })],
      staff: [makeStaff({ id: 9 })],
      teams: [makeTeam({ id: 9 })],
    });
    m.loadAllProjects.mockRejectedValue(new Error('x'));
    m.getBankHolidays.mockRejectedValue(new Error('x'));
    m.getCustomColumnsWithValues.mockRejectedValue(new Error('x'));
    m.getStaff.mockRejectedValue(new Error('x'));
    m.getEquipmentBlocks.mockRejectedValue(new Error('x'));
    vi.mocked(m.absenceTypesApi.getAll).mockRejectedValue(new Error('x'));
    vi.mocked(m.teamsApi.getAll).mockRejectedValue(new Error('x'));

    const { result } = renderHook(() => useDataLoader());
    await act(async () => {
      await result.current.refreshProjects();
      await result.current.refreshSiteData(1);
      await result.current.refreshCustomColumns(1);
      await result.current.refreshStaff();
      await result.current.refreshEquipmentBlocks();
      await result.current.refreshAbsenceTypes();
      await result.current.refreshTeams();
    });
    expect(useAppStore.getState().projects.map((p) => p.id)).toEqual([9]);
    expect(useAppStore.getState().staff.map((p) => p.id)).toEqual([9]);
    expect(useAppStore.getState().teams.map((t) => t.id)).toEqual([9]);
    expect(err).toHaveBeenCalledTimes(7);
    err.mockRestore();
  });
});

describe('selectSite', () => {
  it('switches site, clears the column filters and loads the site\'s calendar and columns', async () => {
    useCustomColumnStore.setState({ customColumnFilters: { 1: ['High'] } });
    const { result } = renderHook(() => useDataLoader());
    expect(result.current.selectSite).toBe(selectSite);

    await act(() => selectSite(sites[0]));

    const s = useAppStore.getState();
    expect(s.currentSite?.id).toBe(3);
    expect(useCustomColumnStore.getState().customColumnFilters).toEqual({});
    expect(m.getBankHolidays).toHaveBeenCalledWith(3);
    expect(m.getCompanyEvents).toHaveBeenCalledWith(3);
    expect(s.bankHolidayDates.has('2026-08-01')).toBe(true);
    expect(m.getCustomColumnsWithValues).toHaveBeenCalledWith(3);
    expect(useCustomColumnStore.getState().customColumnValues).toEqual({ '1-project-1': 'High' });
  });

  it('keeps going when one of the reloads fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.getBankHolidays.mockRejectedValue(new Error('h'));
    m.getCompanyEvents.mockRejectedValue(new Error('e'));
    m.getCustomColumnsWithValues.mockRejectedValue(new Error('c'));
    await act(() => selectSite(sites[1]));
    expect(useAppStore.getState().currentSite?.id).toBe(1);
    expect(err).toHaveBeenCalledTimes(3);
    expect(err).toHaveBeenCalledWith('[DataLoader] Failed to load custom columns:', expect.any(Error));
    err.mockRestore();
  });
});
