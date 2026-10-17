/**
 * Undo across the What-If boundary (F1-1).
 *
 * Inside What-If the undo stack only holds sandbox-era snapshots (it is
 * cleared on enter), and the writes an undo produces are queued like any other
 * What-If edit. After Discard the stack is empty, so Ctrl+Z cannot write the
 * discarded dates for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUndoRedo } from '../useUndoRedo';
import { useAppStore } from '@/stores/appStore';
import { useUndoStore } from '@/stores/undoStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { configureApiClient } from '@/api/client';
import type { Project } from '@/types';

function proj(start: string): Project {
  return {
    id: 1,
    name: 'P',
    site_id: 1,
    confirmed: true,
    archived: false,
    start_date: start,
    end_date: start,
    phases: [
      {
        id: 10,
        project_id: 1,
        name: 'Phase',
        start_date: start,
        end_date: start,
        color: '#000',
        order_index: 0,
        status: 'todo',
        dependencies: [],
        children: [],
        staffAssignments: [],
        equipmentAssignments: [],
      },
    ],
    staffAssignments: [],
    equipmentAssignments: [],
  };
}

describe('useUndoRedo and What-If', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    useWhatIfStore.setState({ whatIfMode: false, whatIfSnapshot: null, whatIfPendingOperations: [], whatIfApplyError: null });
    useUndoStore.getState().clear();
    configureApiClient({
      isWhatIfMode: () => useWhatIfStore.getState().whatIfMode,
      queueWhatIfOperation: (op) => useWhatIfStore.getState().queueWhatIfOperation(op),
    });
    fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    configureApiClient({ isWhatIfMode: () => false, queueWhatIfOperation: undefined });
  });

  it('after Discard there is nothing to undo, so no discarded date reaches the server', async () => {
    const original = proj('2026-03-02');
    useAppStore.getState().setProjects([original]);
    useWhatIfStore.getState().enterWhatIfMode([original]);
    // Two What-If drags.
    useUndoStore.getState().saveState([original], 'drag A');
    useAppStore.getState().setProjects([proj('2026-03-09')]);
    useUndoStore.getState().saveState([proj('2026-03-09')], 'drag B');
    useAppStore.getState().setProjects([proj('2026-03-12')]);

    await useWhatIfStore.getState().exitWhatIfMode(false);

    const { result } = renderHook(() => useUndoRedo());
    expect(result.current.canUndo).toBe(false);
    await act(async () => {
      await result.current.undo();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().projects[0].phases[0].start_date).toBe('2026-03-02');
  });

  it('undo inside What-If restores the sandbox snapshot and queues the write', async () => {
    const original = proj('2026-03-02');
    useAppStore.getState().setProjects([original]);
    useWhatIfStore.getState().enterWhatIfMode([original]);
    useUndoStore.getState().saveState([original], 'drag');
    useAppStore.getState().setProjects([proj('2026-03-09')]);

    const { result } = renderHook(() => useUndoRedo());
    await act(async () => {
      await result.current.undo();
    });

    expect(useAppStore.getState().projects[0].phases[0].start_date).toBe('2026-03-02');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useWhatIfStore.getState().whatIfPendingOperations.map((op) => op.url)).toContain('/api/phases/10');
  });
});
