/**
 * useUndoRedo
 *
 * Orchestrates undo/redo for Gantt drag/resize operations:
 *   1. Pop the appropriate stack via `useUndoStore`.
 *   2. Restore local `appStore.projects` to the snapshot.
 *   3. Diff the previous live state against the restored snapshot and
 *      `savePendingUpdates(...)` so the change is persisted to the server.
 *
 * On persistence failure the projects are reloaded from the server (matching
 * the existing reload-on-error pattern in useDragAndDrop / useResize) and the
 * undo history is cleared (snapshots become invalid relative to server truth).
 *
 * Limitation: snapshots can become stale if WebSocket events apply external
 * mutations between the recorded action and the undo. We accept that risk
 * here — affected items will simply be re-asserted to the snapshot's values.
 */
import { useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUndoStore } from '@/stores/undoStore';
import { diffProjects, savePendingUpdates } from '@/components/gantt/utils';
import { loadAllProjects } from '@/api/endpoints/projects';

export function useUndoRedo() {
  const canUndo = useUndoStore((s) => s.canUndo);
  const canRedo = useUndoStore((s) => s.canRedo);

  const undo = useCallback(async () => {
    const { projects, setProjects } = useAppStore.getState();
    const target = useUndoStore.getState().popUndo(projects);
    if (!target) return;

    const updates = diffProjects(projects, target.projects);
    setProjects(target.projects);

    if (updates.length === 0) return;

    try {
      await savePendingUpdates(updates);
    } catch (err) {
      console.error('Failed to persist undo:', err);
      const reloaded = await loadAllProjects();
      setProjects(reloaded);
      useUndoStore.getState().clear();
    }
  }, []);

  const redo = useCallback(async () => {
    const { projects, setProjects } = useAppStore.getState();
    const target = useUndoStore.getState().popRedo(projects);
    if (!target) return;

    const updates = diffProjects(projects, target.projects);
    setProjects(target.projects);

    if (updates.length === 0) return;

    try {
      await savePendingUpdates(updates);
    } catch (err) {
      console.error('Failed to persist redo:', err);
      const reloaded = await loadAllProjects();
      setProjects(reloaded);
      useUndoStore.getState().clear();
    }
  }, []);

  return { canUndo, canRedo, undo, redo };
}
