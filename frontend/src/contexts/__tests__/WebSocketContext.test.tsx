/**
 * WebSocket refetch runner: custom columns sync between users (F1-7), a
 * teammate's change never replaces the What-If sandbox (F1-2), bursts are
 * coalesced, settings / the signed-in user have their own slices and staff
 * notes reload nothing (F1-27), and an invalid-session close is confirmed
 * before logging out (F1-13).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { ChangePayload } from '@/hooks/useWebSocket';
import type { Site } from '@/types';

const hookOptions: {
  onChangeReceived?: (c: ChangePayload) => void;
  onSessionInvalid?: (code: number) => Promise<boolean> | boolean | void;
} = {};

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (opts: { onChangeReceived?: (c: ChangePayload) => void; onSessionInvalid?: (code: number) => Promise<boolean> | boolean | void }) => {
    hookOptions.onChangeReceived = opts.onChangeReceived;
    hookOptions.onSessionInvalid = opts.onSessionInvalid;
    return {
      connectionState: 'connected',
      offline: false,
      onlineUsers: [],
      recentChanges: [],
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  },
}));
vi.mock('@/api/endpoints/projects', () => ({ loadAllProjects: vi.fn() }));
vi.mock('@/api/endpoints/customColumns', () => ({ getCustomColumnsWithValues: vi.fn() }));
vi.mock('@/api/endpoints/staff', () => ({ getStaff: vi.fn(async () => []) }));
vi.mock('@/api/endpoints/equipment', () => ({
  getEquipment: vi.fn(async () => []),
  getEquipmentBlocks: vi.fn(async () => []),
}));
vi.mock('@/api/endpoints/vacations', () => ({ getVacations: vi.fn(async () => []) }));
vi.mock('@/api/endpoints/sites', () => ({
  getSites: vi.fn(async () => []),
  getBankHolidays: vi.fn(async () => []),
  getCompanyEvents: vi.fn(async () => []),
  buildHolidayDateSet: () => new Set(),
  buildEventDateSet: () => new Set(),
}));
vi.mock('@/api/endpoints/skills', () => ({ skillsApi: { getAll: vi.fn(async () => []) } }));
vi.mock('@/api/endpoints/tags', () => ({ tagsApi: { getAll: vi.fn(async () => []) } }));
vi.mock('@/api/endpoints/projectFields', () => ({ projectFieldsApi: { getAll: vi.fn(async () => []) } }));
vi.mock('@/api/endpoints/teams', () => ({ teamsApi: { getAll: vi.fn(async () => []) } }));
vi.mock('@/api/endpoints/roles', () => ({ rolesApi: { getAll: vi.fn(async () => []) } }));
vi.mock('@/api/endpoints/absenceTypes', () => ({ absenceTypesApi: { getAll: vi.fn(async () => []) } }));
vi.mock('@/api/endpoints/settings', () => ({ getInstanceSettings: vi.fn() }));
vi.mock('@/api/endpoints/auth', () => ({ fetchCurrentUser: vi.fn() }));

import { WebSocketProvider } from '../WebSocketContext';
import { slicesForEntity, ALL_SLICES } from '../wsSlices';
import { loadAllProjects } from '@/api/endpoints/projects';
import { getCustomColumnsWithValues } from '@/api/endpoints/customColumns';
import { useAppStore } from '@/stores/appStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { getInstanceSettings } from '@/api/endpoints/settings';
import { fetchCurrentUser } from '@/api/endpoints/auth';
import { getStaff } from '@/api/endpoints/staff';
import { tagsApi } from '@/api/endpoints/tags';
import { projectFieldsApi } from '@/api/endpoints/projectFields';
import type { ProjectField, Tag, User } from '@/types';
import { makeUser } from '@/test/factories';

function change(entity_type: string): ChangePayload {
  return { user_id: 2, user_name: 'Bob', entity_type, entity_id: 1, project_id: 0 } as ChangePayload;
}

async function receive(entityType: string) {
  await act(async () => {
    hookOptions.onChangeReceived!(change(entityType));
    await vi.advanceTimersByTimeAsync(250);
  });
}

describe('slicesForEntity', () => {
  it('maps custom-column writes to the customColumns slice only', () => {
    expect(slicesForEntity('custom_column')).toEqual(['customColumns']);
    expect(slicesForEntity('custom_column_value')).toEqual(['customColumns']);
  });

  it('refreshes everything (custom columns included) for unknown entities', () => {
    expect(slicesForEntity('something_new')).toEqual(ALL_SLICES);
    expect(ALL_SLICES).toContain('customColumns');
  });

  it('maps settings, notes and users explicitly instead of refreshing everything', () => {
    expect(slicesForEntity('settings')).toEqual(['settings', 'currentUser']);
    expect(slicesForEntity('note')).toEqual([]);
    expect(slicesForEntity('user')).toEqual(['staff', 'currentUser', 'projects', 'teams', 'roles']);
    expect(slicesForEntity('staff')).toEqual(['staff', 'projects']);
  });
});

describe('WebSocketProvider refresh runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    useAppStore.setState({ currentSite: { id: 7, name: 'Lab' } as Site, projects: [] });
    useWhatIfStore.setState({ whatIfMode: false, whatIfSnapshot: null, whatIfPendingOperations: [] });
    useCustomColumnStore.getState().setCustomColumns([]);
    useCustomColumnStore.getState().setCustomColumnValues({});
    vi.mocked(loadAllProjects).mockReset().mockResolvedValue([]);
    vi.mocked(getCustomColumnsWithValues).mockReset().mockResolvedValue({
      columns: [{ id: 3, name: 'Priority' } as never],
      values: { '3-phase-10': 'High' },
    });
    render(<WebSocketProvider><div /></WebSocketProvider>);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reloads custom-column definitions and values for the current site on change:custom_column', async () => {
    await receive('custom_column');

    expect(getCustomColumnsWithValues).toHaveBeenCalledWith(7);
    expect(useCustomColumnStore.getState().customColumnValues).toEqual({ '3-phase-10': 'High' });
    expect(useCustomColumnStore.getState().customColumns.map((c) => c.id)).toEqual([3]);
    // No longer a wasted N+1 project reload.
    expect(loadAllProjects).not.toHaveBeenCalled();
  });

  it('defers project/custom-column refreshes during What-If and runs them after exit', async () => {
    useWhatIfStore.setState({ whatIfMode: true });

    await receive('phase');
    await receive('custom_column');
    await receive('vacation'); // not sandboxed: still refreshed immediately

    expect(loadAllProjects).not.toHaveBeenCalled();
    expect(getCustomColumnsWithValues).not.toHaveBeenCalled();

    await act(async () => {
      useWhatIfStore.setState({ whatIfMode: false });
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(loadAllProjects).toHaveBeenCalledTimes(1);
    expect(getCustomColumnsWithValues).toHaveBeenCalledTimes(1);
  });

  it('refreshes projects normally outside What-If', async () => {
    await receive('phase');
    expect(loadAllProjects).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of changes into one fetch per slice', async () => {
    await act(async () => {
      for (const type of ['phase', 'subphase', 'subphase', 'project', 'staff_assignment']) {
        hookOptions.onChangeReceived!(change(type));
        await vi.advanceTimersByTimeAsync(50); // inside the 200 ms debounce
      }
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(loadAllProjects).toHaveBeenCalledTimes(1);
  });

  it('re-runs once for changes that arrive while a refresh is in flight', async () => {
    let release: () => void = () => {};
    vi.mocked(loadAllProjects).mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve([]); }),
    );
    await receive('phase'); // starts the first (slow) refresh
    expect(loadAllProjects).toHaveBeenCalledTimes(1);

    await receive('phase');
    await receive('subphase');
    expect(loadAllProjects).toHaveBeenCalledTimes(1); // still in flight

    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(loadAllProjects).toHaveBeenCalledTimes(2);
  });

  it('reloads instance settings and the signed-in user on change:settings without touching projects', async () => {
    vi.mocked(getInstanceSettings).mockResolvedValue({ instance_title: 'Renamed', show_weekends: 'false' });
    // The Kanban switch turned off: /auth/me no longer lists views.kanban.
    vi.mocked(fetchCurrentUser).mockResolvedValue(makeUser({ id: 5, role: 'admin', permissions: ['projects.view'] }));
    useAppStore.setState({ isAuthenticated: true, currentUser: makeUser({ id: 5, role: 'admin' }) });
    await receive('settings');
    expect(useAppStore.getState().instanceSettings).toEqual({ instance_title: 'Renamed', show_weekends: 'false' });
    expect(useAppStore.getState().currentUser?.permissions).toEqual(['projects.view']);
    expect(loadAllProjects).not.toHaveBeenCalled();
  });

  it('reloads nothing on change:note (staff notes have no view here)', async () => {
    vi.mocked(getStaff).mockClear();
    await receive('note');
    expect(loadAllProjects).not.toHaveBeenCalled();
    expect(getStaff).not.toHaveBeenCalled();
  });

  it('refreshes tags alone on change:tag (and the projects)', async () => {
    const tag = { id: 9, name: 'Pilot', color: '#ff0000', all_sites: true, site_ids: [], sort_order: 0 } as Tag;
    vi.mocked(tagsApi.getAll).mockResolvedValueOnce([tag]);
    vi.mocked(projectFieldsApi.getAll).mockClear();
    useAppStore.setState({ tags: [] });

    await receive('tag');

    expect(useAppStore.getState().tags).toEqual([tag]);
    expect(projectFieldsApi.getAll).not.toHaveBeenCalled();
    expect(loadAllProjects).toHaveBeenCalled();
  });

  it('refreshes the project fields on change:project_field', async () => {
    const field = { id: 4, name: 'Area', field_type: 'multiselect', sort_order: 0, options: [] } as ProjectField;
    vi.mocked(projectFieldsApi.getAll).mockResolvedValueOnce([field]);
    useAppStore.setState({ projectFields: [] });

    await receive('project_field');

    expect(useAppStore.getState().projectFields).toEqual([field]);
  });

  it('keeps the project fields when their fetch fails', async () => {
    const kept = [{ id: 1, name: 'Old', field_type: 'text', sort_order: 0, options: [] } as ProjectField];
    useAppStore.setState({ projectFields: kept });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(projectFieldsApi.getAll).mockRejectedValueOnce(new Error('boom'));

    await receive('project_field');

    expect(useAppStore.getState().projectFields).toBe(kept);
  });

  it('refreshes the signed-in user on change:user', async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue(makeUser({ id: 5, role: 'superuser' }));
    useAppStore.setState({ isAuthenticated: true, currentUser: makeUser({ id: 5, role: 'admin' }) });
    await receive('user');
    expect(useAppStore.getState().currentUser?.role).toBe('superuser');
    expect(loadAllProjects).toHaveBeenCalledTimes(1);
  });
});

describe('WebSocketProvider invalid-session close', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fetchCurrentUser).mockReset();
    useAppStore.setState({ isAuthenticated: true, isAuthChecking: false, currentUser: { id: 5 } as User, projects: [] });
    render(<WebSocketProvider><div /></WebSocketProvider>);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('logs out when the server confirms there is no session', async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue(null);
    let stillValid: unknown;
    await act(async () => {
      stillValid = await hookOptions.onSessionInvalid!(4001);
    });
    // No retry for a session that is really gone.
    expect(stillValid).toBe(false);
    expect(useAppStore.getState().isAuthenticated).toBe(false);
    expect(useAppStore.getState().currentUser).toBeNull();
  });

  it('stays signed in when the session check itself fails (network)', async () => {
    vi.mocked(fetchCurrentUser).mockRejectedValue(new Error('Failed to fetch'));
    let stillValid: unknown;
    await act(async () => {
      stillValid = await hookOptions.onSessionInvalid!(4001);
    });
    expect(stillValid).toBe(false);
    expect(useAppStore.getState().isAuthenticated).toBe(true);
  });

  it('stays signed in when the session is in fact still valid, and asks the socket to retry', async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ id: 5 } as User);
    let stillValid: unknown;
    await act(async () => {
      stillValid = await hookOptions.onSessionInvalid!(4001);
    });
    expect(stillValid).toBe(true);
    expect(useAppStore.getState().isAuthenticated).toBe(true);
  });

  it('checks the session on 4003 too, and stays signed in for an Origin rejection', async () => {
    // 4003 is "user disabled" or "Origin not allowed"; the latter leaves the
    // session intact, so /auth/me still returns the user.
    vi.mocked(fetchCurrentUser).mockResolvedValue({ id: 5 } as User);
    await act(async () => {
      hookOptions.onSessionInvalid!(4003);
    });
    expect(fetchCurrentUser).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().isAuthenticated).toBe(true);
  });

  it('logs out on 4003 when the user was disabled (no session any more)', async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue(null);
    await act(async () => {
      hookOptions.onSessionInvalid!(4003);
    });
    expect(useAppStore.getState().isAuthenticated).toBe(false);
  });
});
