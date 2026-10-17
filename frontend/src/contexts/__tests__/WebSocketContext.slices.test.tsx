/**
 * WebSocket refetch runner, slice by slice: an unknown entity refreshes every
 * slice and each one lands in its store; failures are logged per slice and do
 * not block the others; calendar/custom-column results for a site the user
 * has left are dropped; a deleted signed-in user expires the session. Also
 * the context helpers exposed to consumers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ChangePayload } from '@/hooks/useWebSocket';

const hookState = vi.hoisted(() => ({
  onChangeReceived: undefined as undefined | ((c: ChangePayload) => void),
  recentChanges: [] as ChangePayload[],
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (opts: { onChangeReceived?: (c: ChangePayload) => void }) => {
    hookState.onChangeReceived = opts.onChangeReceived;
    return {
      connectionState: 'connected',
      offline: false,
      onlineUsers: [{ user_id: 2, first_name: 'Bob', last_name: 'Brown', connected_at: '2026-10-16T10:00:00.000Z' }],
      recentChanges: hookState.recentChanges,
      connect: hookState.connect,
      disconnect: hookState.disconnect,
    };
  },
}));
vi.mock('@/api/endpoints/projects', () => ({ loadAllProjects: vi.fn() }));
vi.mock('@/api/endpoints/customColumns', () => ({ getCustomColumnsWithValues: vi.fn() }));
vi.mock('@/api/endpoints/staff', () => ({ getStaff: vi.fn() }));
vi.mock('@/api/endpoints/equipment', () => ({ getEquipment: vi.fn(), getEquipmentBlocks: vi.fn() }));
vi.mock('@/api/endpoints/vacations', () => ({ getVacations: vi.fn() }));
vi.mock('@/api/endpoints/sites', async () => {
  const actual = await vi.importActual<typeof import('@/api/endpoints/sites')>('@/api/endpoints/sites');
  return {
    getSites: vi.fn(),
    getBankHolidays: vi.fn(),
    getCompanyEvents: vi.fn(),
    buildHolidayDateSet: actual.buildHolidayDateSet,
    buildEventDateSet: actual.buildEventDateSet,
  };
});
vi.mock('@/api/endpoints/skills', () => ({ skillsApi: { getAll: vi.fn() } }));
vi.mock('@/api/endpoints/tags', () => ({ tagsApi: { getAll: vi.fn() }, tagGroupsApi: { getAll: vi.fn() } }));
vi.mock('@/api/endpoints/absenceTypes', () => ({ absenceTypesApi: { getAll: vi.fn() } }));
vi.mock('@/api/endpoints/settings', () => ({ getInstanceSettings: vi.fn() }));
vi.mock('@/api/endpoints/auth', () => ({ fetchCurrentUser: vi.fn() }));

import { WebSocketProvider, useOnlineUsers, useWebSocketContext } from '../WebSocketContext';
import { loadAllProjects } from '@/api/endpoints/projects';
import { getCustomColumnsWithValues } from '@/api/endpoints/customColumns';
import { getStaff } from '@/api/endpoints/staff';
import { getEquipment, getEquipmentBlocks } from '@/api/endpoints/equipment';
import { getVacations } from '@/api/endpoints/vacations';
import { getBankHolidays, getCompanyEvents, getSites } from '@/api/endpoints/sites';
import { skillsApi } from '@/api/endpoints/skills';
import { tagGroupsApi, tagsApi } from '@/api/endpoints/tags';
import { absenceTypesApi } from '@/api/endpoints/absenceTypes';
import { getInstanceSettings } from '@/api/endpoints/settings';
import { fetchCurrentUser } from '@/api/endpoints/auth';
import { useAppStore } from '@/stores/appStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { resetAllStores } from '@/stores';
import {
  makeCustomColumn,
  makeEquipment,
  makeProject,
  makeSite,
  makeStaff,
  makeTag,
  makeUser,
  makeVacation,
} from '@/test/factories';
import type { BankHoliday, CompanyEvent } from '@/types';

const holiday = { id: 1, site_id: 1, date: '2026-08-01', name: 'National Day' } as BankHoliday;
const event = { id: 2, site_id: 1, date: '2026-09-10', name: 'Audit' } as CompanyEvent;

function seedApi() {
  vi.mocked(loadAllProjects).mockResolvedValue([makeProject({ name: 'Fresh' })]);
  vi.mocked(getStaff).mockResolvedValue([makeStaff()]);
  vi.mocked(getEquipment).mockResolvedValue([makeEquipment()]);
  vi.mocked(getEquipmentBlocks).mockResolvedValue([
    { id: 1, equipment_id: 1, start_date: '2026-01-01', end_date: '2026-01-02', reason: 'maintenance', description: '' },
  ]);
  vi.mocked(getVacations).mockResolvedValue([makeVacation()]);
  vi.mocked(getSites).mockResolvedValue([makeSite(), makeSite({ id: 2, name: 'Zurich' })]);
  vi.mocked(getBankHolidays).mockResolvedValue([holiday]);
  vi.mocked(getCompanyEvents).mockResolvedValue([event]);
  vi.mocked(skillsApi.getAll).mockResolvedValue([{ id: 1, name: 'HPLC' } as never]);
  vi.mocked(tagsApi.getAll).mockResolvedValue([makeTag()]);
  vi.mocked(tagGroupsApi.getAll).mockResolvedValue([{ id: 1, name: 'Type' } as never]);
  vi.mocked(absenceTypesApi.getAll).mockResolvedValue([{ id: 1, name: 'Sick' } as never]);
  vi.mocked(getCustomColumnsWithValues).mockResolvedValue({ columns: [makeCustomColumn()], values: { '1-project-1': 'High' } });
  vi.mocked(getInstanceSettings).mockResolvedValue({ instance_title: 'Lab Planner' });
  vi.mocked(fetchCurrentUser).mockResolvedValue(makeUser({ first_name: 'Renamed' }));
}

async function receive(entity_type: string) {
  await act(async () => {
    hookState.onChangeReceived!({ user_id: 2, user_name: 'Bob', entity_type, entity_id: 1, project_id: 0, action: 'update' });
    await vi.advanceTimersByTimeAsync(250);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.clearAllMocks();
  hookState.recentChanges = [];
  resetAllStores();
  useAppStore.setState({ currentSite: makeSite({ id: 1 }), currentUser: makeUser(), isAuthenticated: true });
  seedApi();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WebSocketProvider slice refresh', () => {
  it('refreshes every slice into its store for an unknown entity', async () => {
    render(<WebSocketProvider><div /></WebSocketProvider>);
    await receive('brand_new_entity');

    const app = useAppStore.getState();
    expect(app.projects.map((p) => p.name)).toEqual(['Fresh']);
    expect(getStaff).toHaveBeenCalledWith(true);
    expect(app.staff).toHaveLength(1);
    expect(getEquipment).toHaveBeenCalledWith(true);
    expect(app.equipment).toHaveLength(1);
    expect(app.equipmentBlocks).toHaveLength(1);
    expect(app.vacations).toHaveLength(1);
    expect(app.sites.map((s) => s.name)).toEqual(['Basel', 'Zurich']);
    expect(app.skills).toHaveLength(1);
    expect(app.tags).toHaveLength(1);
    expect(app.tagGroups).toHaveLength(1);
    expect(app.absenceTypes).toHaveLength(1);
    expect(app.bankHolidayDates).toEqual(new Set(['2026-08-01']));
    expect(app.companyEventDates).toEqual(new Set(['2026-09-10']));
    expect(app.instanceSettings).toEqual({ instance_title: 'Lab Planner' });
    expect(app.currentUser?.first_name).toBe('Renamed');
    expect(useCustomColumnStore.getState().customColumnValues).toEqual({ '1-project-1': 'High' });
  });

  it('logs each failing slice and still applies the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fail = () => Promise.reject(new Error('500'));
    for (const fn of [
      loadAllProjects, getStaff, getEquipment, getEquipmentBlocks, getVacations, getSites,
      getBankHolidays, getCompanyEvents, getCustomColumnsWithValues, getInstanceSettings, fetchCurrentUser,
    ]) {
      vi.mocked(fn as () => Promise<unknown>).mockImplementation(fail);
    }
    vi.mocked(skillsApi.getAll).mockImplementation(fail);
    vi.mocked(tagsApi.getAll).mockImplementation(fail);
    vi.mocked(absenceTypesApi.getAll).mockImplementation(fail);

    render(<WebSocketProvider><div /></WebSocketProvider>);
    await receive('brand_new_entity');

    const messages = error.mock.calls.map((c) => c[0]);
    expect(messages).toEqual(
      expect.arrayContaining([
        '[WS] projects refresh failed',
        '[WS] staff refresh failed',
        '[WS] equipment refresh failed',
        '[WS] equipment blocks refresh failed',
        '[WS] vacations refresh failed',
        '[WS] sites refresh failed',
        '[WS] skills refresh failed',
        '[WS] tags refresh failed',
        '[WS] absence types refresh failed',
        '[WS] bank holidays refresh failed',
        '[WS] company events refresh failed',
        '[WS] custom columns refresh failed',
        '[WS] settings refresh failed',
        '[WS] current user refresh failed',
      ])
    );
    expect(useAppStore.getState().isAuthenticated).toBe(true);
  });

  it('drops calendar and custom-column results for a site the user has left', async () => {
    let releaseHolidays: (v: BankHoliday[]) => void = () => {};
    let releaseEvents: (v: CompanyEvent[]) => void = () => {};
    let releaseColumns: (v: { columns: []; values: Record<string, string> }) => void = () => {};
    vi.mocked(getBankHolidays).mockImplementation(() => new Promise((r) => (releaseHolidays = r)));
    vi.mocked(getCompanyEvents).mockImplementation(() => new Promise((r) => (releaseEvents = r)));
    vi.mocked(getCustomColumnsWithValues).mockImplementation(() => new Promise((r) => (releaseColumns = r as never)));

    render(<WebSocketProvider><div /></WebSocketProvider>);
    await receive('site');
    await receive('custom_column');
    act(() => useAppStore.setState({ currentSite: makeSite({ id: 2 }) }));
    await act(async () => {
      releaseHolidays([holiday]);
      releaseEvents([event]);
      releaseColumns({ columns: [], values: { stale: 'yes' } });
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(useAppStore.getState().bankHolidayDates.size).toBe(0);
    expect(useAppStore.getState().companyEventDates.size).toBe(0);
    expect(useCustomColumnStore.getState().customColumnValues).toEqual({});
  });

  it('skips site-scoped slices without a current site', async () => {
    useAppStore.setState({ currentSite: null });
    render(<WebSocketProvider><div /></WebSocketProvider>);
    await receive('bank_holiday');
    await receive('custom_column');
    expect(getBankHolidays).not.toHaveBeenCalled();
    expect(getCustomColumnsWithValues).not.toHaveBeenCalled();
  });

  it('expires the session when the signed-in user no longer exists', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fetchCurrentUser).mockResolvedValue(null);
    render(<WebSocketProvider><div /></WebSocketProvider>);
    await receive('user');
    expect(useAppStore.getState()).toMatchObject({ isAuthenticated: false, currentUser: null });
  });
});

describe('WebSocket context helpers', () => {
  function Probe() {
    const ctx = useWebSocketContext();
    const online = useOnlineUsers();
    return (
      <div>
        <span data-testid="connected">{String(ctx.isConnected)}</span>
        <span data-testid="online">{online.map((u) => `${u.first_name} ${u.last_name}`).join(',')}</span>
        <span data-testid="changes">{ctx.recentChanges.length}</span>
        <span data-testid="phase-changes">
          {ctx.recentChanges.filter((c) => c.entity_type === 'phase' && c.entity_id === 10).length}
        </span>
        <button onClick={ctx.reconnect}>reconnect</button>
      </div>
    );
  }

  it('exposes presence, recent changes and reconnect', () => {
    hookState.recentChanges = [
      { user_id: 2, user_name: 'Bob', entity_type: 'phase', entity_id: 10, project_id: 1, action: 'update' },
      { user_id: 3, user_name: 'Eve', entity_type: 'phase', entity_id: 10, project_id: 1, action: 'move' },
      { user_id: 3, user_name: 'Eve', entity_type: 'phase', entity_id: 11, project_id: 1, action: 'move' },
    ];
    render(<WebSocketProvider><Probe /></WebSocketProvider>);
    expect(screen.getByTestId('connected')).toHaveTextContent('true');
    expect(screen.getByTestId('online')).toHaveTextContent('Bob Brown');
    expect(screen.getByTestId('changes')).toHaveTextContent('3');
    expect(screen.getByTestId('phase-changes')).toHaveTextContent('2');

    act(() => {
      screen.getByRole('button', { name: 'reconnect' }).click();
    });
    expect(hookState.disconnect).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(hookState.connect).toHaveBeenCalledTimes(1);
  });

  it('throws outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const silence = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener('error', silence);
    expect(() => render(<Probe />)).toThrow('useWebSocketContext must be used within a WebSocketProvider');
    window.removeEventListener('error', silence);
  });
});
