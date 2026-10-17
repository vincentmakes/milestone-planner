/**
 * Optimistic-write failure protocol (see CLAUDE.md, Frontend Conventions).
 *
 * When a persist that followed an optimistic local update fails, the local
 * project tree no longer matches the server. Two things must happen, always
 * together:
 *   1. reload the projects from the server, and
 *   2. clear the undo history — its snapshots were taken against the
 *      diverged local state, and an undo would re-assert them for real.
 *
 * Every hook/context that writes optimistically calls this from its catch
 * block instead of open-coding the two steps (forgetting step 2 is the
 * recurring bug this helper exists to prevent).
 */
import { loadAllProjects } from '@/api/endpoints/projects';
import { useAppStore } from '@/stores/appStore';
import { useUndoStore } from '@/stores/undoStore';

export async function recoverFromPersistFailure(context: string, error: unknown): Promise<void> {
  console.error(`[${context}] persist failed, reloading from the server:`, error);
  try {
    // loadAllProjects is a no-op while What-If is active (the sandbox is the
    // truth there), so this never wipes the user's What-If view.
    const reloaded = await loadAllProjects();
    useAppStore.getState().setProjects(reloaded);
  } catch (reloadErr) {
    console.error(`[${context}] reload after failed persist also failed:`, reloadErr);
  } finally {
    useUndoStore.getState().clear();
  }
}
