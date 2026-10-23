/**
 * What-If sandbox boundaries: the undo history never crosses them (F1-1) and a
 * failed Apply leaves the user in a recoverable, visible state (F1-4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Project } from '@/types';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, apiRequest: vi.fn() };
});
vi.mock('@/api/endpoints/projects', () => ({
  fetchAllProjects: vi.fn(),
}));

import { useWhatIfStore } from '../whatIfStore';
import { useUndoStore } from '../undoStore';
import { useAppStore } from '../appStore';
import { useUIStore } from '../uiStore';
import { apiRequest, clientConfig } from '@/api/client';
import { fetchAllProjects } from '@/api/endpoints/projects';

function proj(id: number, start: string): Project {
  return {
    id,
    name: `P${id}`,
    site_id: 1,
    confirmed: true,
    archived: false,
    start_date: start,
    end_date: start,
    phases: [],
    staffAssignments: [],
    equipmentAssignments: [],
  };
}

const ORIGINAL = proj(1, '2026-03-01');
const SANDBOX = proj(1, '2026-03-09');
const SERVER = proj(1, '2026-03-05');

function seedSandboxWithUndo() {
  useAppStore.getState().setProjects([ORIGINAL]);
  useWhatIfStore.getState().enterWhatIfMode([ORIGINAL]);
  // A drag inside What-If: snapshot, then the local tree moves.
  useUndoStore.getState().saveState([ORIGINAL], 'drag');
  useAppStore.getState().setProjects([SANDBOX]);
  for (const n of [1, 2, 3]) {
    useWhatIfStore.getState().queueWhatIfOperation({ method: 'PUT', url: `/api/phases/${n}`, body: { n } });
  }
}

describe('whatIfStore', () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useWhatIfStore.setState({
      whatIfMode: false,
      whatIfSnapshot: null,
      whatIfPendingOperations: [],
      whatIfApplyError: null,
    });
    useUndoStore.getState().clear();
    // As main.tsx wires it (set on the object whatIfStore itself imports).
    clientConfig.isWhatIfMode = () => useWhatIfStore.getState().whatIfMode;
    vi.mocked(apiRequest).mockReset().mockResolvedValue({});
    vi.mocked(fetchAllProjects).mockReset().mockResolvedValue([SERVER]);
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('entering What-If clears undo history recorded before the sandbox', () => {
    useUndoStore.getState().saveState([ORIGINAL], 'drag before what-if');
    expect(useUndoStore.getState().canUndo).toBe(true);

    useWhatIfStore.getState().enterWhatIfMode([ORIGINAL]);

    expect(useUndoStore.getState().canUndo).toBe(false);
  });

  it('Discard restores the snapshot and clears undo (no Ctrl+Z can write discarded dates)', async () => {
    seedSandboxWithUndo();
    expect(useUndoStore.getState().canUndo).toBe(true);

    await useWhatIfStore.getState().exitWhatIfMode(false);

    expect(useAppStore.getState().projects).toEqual([ORIGINAL]);
    expect(useUndoStore.getState().canUndo).toBe(false);
    expect(useUndoStore.getState().canRedo).toBe(false);
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
    expect(useWhatIfStore.getState().whatIfPendingOperations).toEqual([]);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('Apply replays every op in order with interception off, reloads from the server and clears undo', async () => {
    seedSandboxWithUndo();
    const interceptionDuringReplay: boolean[] = [];
    vi.mocked(apiRequest).mockImplementation(async () => {
      interceptionDuringReplay.push(clientConfig.isWhatIfMode?.() ?? false);
      return {};
    });

    const ok = await useWhatIfStore.getState().exitWhatIfMode(true);

    expect(ok).toBe(true);
    expect(vi.mocked(apiRequest).mock.calls.map((c) => c[0])).toEqual([
      '/api/phases/1',
      '/api/phases/2',
      '/api/phases/3',
    ]);
    expect(interceptionDuringReplay).toEqual([false, false, false]);
    expect(fetchAllProjects).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().projects).toEqual([SERVER]);
    expect(useUndoStore.getState().canUndo).toBe(false);
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
    expect(useWhatIfStore.getState().whatIfApplyError).toBeNull();
    // Interception check restored afterwards.
    useWhatIfStore.setState({ whatIfMode: true });
    expect(clientConfig.isWhatIfMode?.()).toBe(true);
  });

  it('Apply counts replayed writes sent for approval (202) and flashes once after the reload', async () => {
    seedSandboxWithUndo();
    useUIStore.setState({ flashNotice: null });
    const order: string[] = [];
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ pending: true, request_id: 11 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ pending: true, request_id: 12 });
    vi.mocked(fetchAllProjects).mockImplementation(async () => {
      order.push(`reload (flash: ${useUIStore.getState().flashNotice?.message ?? 'none'})`);
      return [SERVER];
    });

    const ok = await useWhatIfStore.getState().exitWhatIfMode(true);

    expect(ok).toBe(true);
    expect(order).toEqual(['reload (flash: none)']);
    expect(useUIStore.getState().flashNotice).toMatchObject({
      message: '2 bookings sent for approval',
      tone: 'info',
    });
  });

  it('Apply flashes nothing when no replayed write was sent for approval', async () => {
    seedSandboxWithUndo();
    useUIStore.setState({ flashNotice: null });

    await useWhatIfStore.getState().exitWhatIfMode(true);

    expect(useUIStore.getState().flashNotice).toBeNull();
  });

  it('a failed Apply still reports the writes that were sent for approval before it', async () => {
    seedSandboxWithUndo();
    useUIStore.setState({ flashNotice: null });
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ pending: true, request_id: 11 })
      .mockRejectedValueOnce(new Error('boom'));

    await useWhatIfStore.getState().exitWhatIfMode(true);

    expect(useWhatIfStore.getState().whatIfApplyError).toMatchObject({ applied: 1 });
    expect(useUIStore.getState().flashNotice?.message).toBe('Sent for approval');
  });

  it('a failed Apply stops, keeps the failed + remaining ops, stays in What-If, reloads and records the error', async () => {
    seedSandboxWithUndo();
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('phase not found'));

    const ok = await useWhatIfStore.getState().exitWhatIfMode(true);

    expect(ok).toBe(false);
    // Stopped at the failure: op 3 was never sent.
    expect(apiRequest).toHaveBeenCalledTimes(2);
    const state = useWhatIfStore.getState();
    expect(state.whatIfMode).toBe(true);
    expect(state.whatIfPendingOperations.map((op) => op.url)).toEqual(['/api/phases/2', '/api/phases/3']);
    expect(state.whatIfApplyError).toEqual({ applied: 1, total: 3, message: 'phase not found' });
    // The view and the Discard snapshot now reflect what really landed.
    expect(useAppStore.getState().projects).toEqual([SERVER]);
    expect(state.whatIfSnapshot?.projects).toEqual([SERVER]);
    expect(useUndoStore.getState().canUndo).toBe(false);
    // Surfaced by WhatIfToggle's banner (R-4), not a blocking alert.
    expect(alertSpy).not.toHaveBeenCalled();

    // Discard afterwards drops the rest and restores the server state.
    await useWhatIfStore.getState().exitWhatIfMode(false);
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
    expect(useAppStore.getState().projects).toEqual([SERVER]);
  });

  it('retrying Apply after a failure replays only the remaining ops', async () => {
    seedSandboxWithUndo();
    vi.mocked(apiRequest).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('boom'));
    await useWhatIfStore.getState().exitWhatIfMode(true);

    vi.mocked(apiRequest).mockReset().mockResolvedValue({});
    const ok = await useWhatIfStore.getState().exitWhatIfMode(true);

    expect(ok).toBe(true);
    expect(vi.mocked(apiRequest).mock.calls.map((c) => c[0])).toEqual(['/api/phases/2', '/api/phases/3']);
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
  });
  it('keeps edits queued while the post-Apply reload is in flight (R-1)', async () => {
    seedSandboxWithUndo();
    let releaseReload: (p: Project[]) => void = () => {};
    vi.mocked(fetchAllProjects).mockImplementation(
      () => new Promise<Project[]>((resolve) => { releaseReload = resolve; }),
    );

    const applying = useWhatIfStore.getState().exitWhatIfMode(true);
    // Let the replay finish; Apply is now waiting on the reload.
    await vi.waitFor(() => expect(fetchAllProjects).toHaveBeenCalledTimes(1));

    // The user keeps editing: interception is back on, so this is queued.
    expect(clientConfig.isWhatIfMode?.()).toBe(true);
    const LOCAL = proj(1, '2026-03-20');
    useAppStore.getState().setProjects([LOCAL]);
    useWhatIfStore.getState().queueWhatIfOperation({ method: 'PUT', url: '/api/phases/9', body: { late: true } });

    releaseReload([SERVER]);
    const ok = await applying;

    expect(ok).toBe(true);
    const state = useWhatIfStore.getState();
    // Not dropped: still in What-If with exactly the late edit queued.
    expect(state.whatIfMode).toBe(true);
    expect(state.whatIfPendingOperations.map((op) => op.url)).toEqual(['/api/phases/9']);
    expect(state.whatIfApplyError).toBeNull();
    // The screen keeps showing the late edit; Discard restores the server state.
    expect(useAppStore.getState().projects).toEqual([LOCAL]);
    expect(state.whatIfSnapshot?.projects).toEqual([SERVER]);

    // A second Apply sends only the late edit.
    vi.mocked(apiRequest).mockClear();
    vi.mocked(fetchAllProjects).mockReset().mockResolvedValue([SERVER]);
    await useWhatIfStore.getState().exitWhatIfMode(true);
    expect(vi.mocked(apiRequest).mock.calls.map((c) => c[0])).toEqual(['/api/phases/9']);
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
  });

  it('a failed Apply also keeps edits queued during its reload, after the remaining ops', async () => {
    seedSandboxWithUndo();
    vi.mocked(apiRequest).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(fetchAllProjects).mockImplementation(async () => {
      useWhatIfStore.getState().queueWhatIfOperation({ method: 'PATCH', url: '/api/custom-columns/4', body: {} });
      return [SERVER];
    });

    await useWhatIfStore.getState().exitWhatIfMode(true);

    expect(useWhatIfStore.getState().whatIfPendingOperations.map((op) => `${op.method} ${op.url}`)).toEqual([
      'PUT /api/phases/2',
      'PUT /api/phases/3',
      'PATCH /api/custom-columns/4',
    ]);
  });

  it('reset() drops the sandbox and queue without replaying or touching projects', () => {
    seedSandboxWithUndo();
    useWhatIfStore.getState().reset();
    const state = useWhatIfStore.getState();
    expect(state.whatIfMode).toBe(false);
    expect(state.whatIfPendingOperations).toEqual([]);
    expect(state.whatIfSnapshot).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
    expect(useAppStore.getState().projects).toEqual([SANDBOX]);
  });

  it('dismissApplyError hides the error but keeps the remaining ops', async () => {
    seedSandboxWithUndo();
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error('boom'));
    await useWhatIfStore.getState().exitWhatIfMode(true);
    expect(useWhatIfStore.getState().whatIfApplyError).not.toBeNull();

    useWhatIfStore.getState().dismissApplyError();

    expect(useWhatIfStore.getState().whatIfApplyError).toBeNull();
    expect(useWhatIfStore.getState().whatIfPendingOperations).toHaveLength(3);
    expect(useWhatIfStore.getState().whatIfMode).toBe(true);
  });
  it('does not resurrect the sandbox when the stores were reset during Apply (session expired)', async () => {
    seedSandboxWithUndo();
    vi.mocked(apiRequest).mockImplementationOnce(async () => {
      // e.g. a 401 → expireSession → resetAllStores, then the call rejects
      useWhatIfStore.getState().reset();
      throw new Error('Not authenticated');
    });

    const ok = await useWhatIfStore.getState().exitWhatIfMode(true);

    expect(ok).toBe(false);
    const state = useWhatIfStore.getState();
    expect(state.whatIfMode).toBe(false);
    expect(state.whatIfPendingOperations).toEqual([]);
    expect(state.whatIfApplyError).toBeNull();
  });

  it('flashes nothing when the stores were reset during Apply, even after a 202', async () => {
    seedSandboxWithUndo();
    useUIStore.setState({ flashNotice: null });
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ pending: true, request_id: 11 })
      .mockImplementationOnce(async () => {
        useWhatIfStore.getState().reset();
        throw new Error('Not authenticated');
      });

    await useWhatIfStore.getState().exitWhatIfMode(true);

    expect(useUIStore.getState().flashNotice).toBeNull();
  });
});
