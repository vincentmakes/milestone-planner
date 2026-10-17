/**
 * The optimistic-write failure protocol: reload projects AND clear undo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({ loadAllProjects: vi.fn() }));

import { recoverFromPersistFailure } from '../persistFailure';
import { loadAllProjects } from '@/api/endpoints/projects';
import { useAppStore } from '@/stores/appStore';
import { useUndoStore } from '@/stores/undoStore';

const SERVER: Project = {
  id: 1, name: 'Server', site_id: 1, confirmed: true, archived: false,
  phases: [], staffAssignments: [], equipmentAssignments: [],
};

describe('recoverFromPersistFailure', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useAppStore.getState().setProjects([]);
    useUndoStore.getState().clear();
    useUndoStore.getState().saveState([], 'drag');
  });

  it('reloads projects from the server and clears the undo stack', async () => {
    vi.mocked(loadAllProjects).mockResolvedValue([SERVER]);

    await recoverFromPersistFailure('Test', new Error('409'));

    expect(useAppStore.getState().projects).toEqual([SERVER]);
    expect(useUndoStore.getState().canUndo).toBe(false);
  });

  it('still clears the undo stack when the reload itself fails', async () => {
    vi.mocked(loadAllProjects).mockRejectedValue(new Error('offline'));

    await expect(recoverFromPersistFailure('Test', new Error('409'))).resolves.toBeUndefined();

    expect(useUndoStore.getState().canUndo).toBe(false);
  });
});
