/**
 * What-If Store
 * Manages What-If mode: snapshot, pending operations, apply/discard.
 *
 * What-If mode allows users to make tentative changes to the project data
 * without persisting them. When the user applies changes, the queued API
 * operations are replayed against the real API.
 */

import { create } from 'zustand';
import { useAppStore } from './appStore';
import { useUndoStore } from './undoStore';
import { apiRequest, clientConfig } from '@/api/client';
import type { WriteMethod } from '@/api/client';
import { fetchAllProjects } from '@/api/endpoints/projects';
import type { Project } from '@/types';

// =============================================================================
// TYPES
// =============================================================================

/** Represents a pending API operation for What-If mode */
export interface WhatIfOperation {
  id: string;
  method: WriteMethod;
  url: string;
  body?: unknown;
  timestamp: number;
}

/** Outcome of a failed Apply, kept so the UI can show it. */
export interface WhatIfApplyError {
  /** Operations that reached the server before the failure */
  applied: number;
  /** Operations in the queue when Apply started */
  total: number;
  /** Error message of the operation that failed */
  message: string;
}

// =============================================================================
// STATE INTERFACE
// =============================================================================

interface WhatIfState {
  // ---------------------------------------------
  // WHAT IF MODE STATE
  // ---------------------------------------------
  whatIfMode: boolean;
  whatIfSnapshot: {
    projects: Project[];
  } | null;
  /** Queue of API operations to replay when applying What-If changes */
  whatIfPendingOperations: WhatIfOperation[];
  /** Set when the last Apply stopped on a failed operation; cleared on the next enter/exit */
  whatIfApplyError: WhatIfApplyError | null;

  // ---------------------------------------------
  // ACTIONS
  // ---------------------------------------------
  /**
   * Enter What-If mode. Takes a snapshot of the current projects.
   * Must be called with the current projects from appStore.
   */
  enterWhatIfMode: (currentProjects: Project[]) => void;

  /**
   * Exit What-If mode.
   *   - Discard (false): restore the snapshot, drop the queue.
   *   - Apply (true): replay the queue in order against the real API, then
   *     reload projects from the server. If an operation fails, replay stops
   *     there (later operations may depend on it), the failed and remaining
   *     operations stay queued, What-If mode stays ACTIVE so the user can
   *     Discard or retry, the view is reloaded from the server to show what
   *     actually landed, and the error is stored in whatIfApplyError (shown
   *     by WhatIfToggle with Retry / Discard).
   *     Edits queued while the post-Apply reload is in flight are kept: they
   *     stay queued (in What-If) instead of being dropped with the queue.
   *     Resolves to false in that case, true otherwise.
   *
   * The undo history is cleared on every exit (and on enter): its snapshots
   * straddle the sandbox boundary, and undoing one after Discard would write
   * the discarded dates for real.
   */
  exitWhatIfMode: (applyChanges: boolean) => Promise<boolean>;

  /** Queue an API operation to be replayed when applying What-If changes */
  queueWhatIfOperation: (operation: Omit<WhatIfOperation, 'id' | 'timestamp'>) => void;

  /**
   * Drop the sandbox without touching appStore (logout / expired session:
   * appStore is reset separately). Never replays anything.
   */
  reset: () => void;

  /** Hide the Apply-failure banner (the remaining operations stay queued). */
  dismissApplyError: () => void;
}

// =============================================================================
// STORE CREATION
// =============================================================================

/** State fields after leaving What-If mode (a fresh queue array each time). */
function exitedState(): Pick<
  WhatIfState,
  'whatIfMode' | 'whatIfSnapshot' | 'whatIfPendingOperations' | 'whatIfApplyError'
> {
  return {
    whatIfMode: false,
    whatIfSnapshot: null,
    whatIfPendingOperations: [],
    whatIfApplyError: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useWhatIfStore = create<WhatIfState>()((set, get) => ({
  whatIfMode: false,
  whatIfSnapshot: null,
  whatIfPendingOperations: [],
  whatIfApplyError: null,

  enterWhatIfMode: (currentProjects: Project[]) => {
    // Entries recorded before the sandbox would diff against pre-What-If state.
    useUndoStore.getState().clear();
    set({
      whatIfMode: true,
      whatIfSnapshot: {
        projects: structuredClone(currentProjects),
      },
      whatIfPendingOperations: [],
      whatIfApplyError: null,
    });
  },

  exitWhatIfMode: async (applyChanges) => {
    const { whatIfSnapshot, whatIfPendingOperations } = get();

    if (!applyChanges || whatIfPendingOperations.length === 0) {
      // Discard (or nothing to apply): restore the pre-What-If state.
      if (!applyChanges && whatIfSnapshot) {
        useAppStore.getState().setProjects(whatIfSnapshot.projects);
      }
      useUndoStore.getState().clear();
      set(exitedState());
      return true;
    }

    // Apply: replay the queued operations with What-If interception disabled.
    const originalIsWhatIfMode = clientConfig.isWhatIfMode;
    clientConfig.isWhatIfMode = () => false;

    let applied = 0;
    let failure: unknown = null;
    try {
      for (const op of whatIfPendingOperations) {
        await apiRequest(op.url, {
          method: op.method,
          body: op.body,
        });
        applied++;
      }
    } catch (error) {
      failure = error;
    } finally {
      // Restore the What-If mode check
      clientConfig.isWhatIfMode = originalIsWhatIfMode;
    }

    // Either way the server state changed underneath the local tree: reload it.
    // Interception is back on now, so an edit made while this reload is in
    // flight is queued again (R-1); it is picked up below, never dropped.
    let serverProjects: Project[] | null = null;
    try {
      serverProjects = await fetchAllProjects();
    } catch (reloadErr) {
      console.error('[What If] Failed to reload projects after apply:', reloadErr);
    }
    useUndoStore.getState().clear();

    // The stores were reset while Apply ran (session expired → 401 →
    // resetAllStores, or logout): leave them reset; never resurrect the
    // sandbox or its queue for whoever signs in next.
    if (!get().whatIfMode) {
      return false;
    }

    // Operations queued after Apply started (during the replay interception
    // is off, so these can only come from the reload window above).
    const lateOperations = get().whatIfPendingOperations.slice(whatIfPendingOperations.length);

    if (failure === null) {
      if (lateOperations.length === 0) {
        if (serverProjects) useAppStore.getState().setProjects(serverProjects);
        set(exitedState());
        return true;
      }
      // Everything Apply started with landed, but the user kept editing while
      // the view reloaded. Stay in What-If with just those edits: the local
      // tree already shows them (it is not replaced by the reload), and a
      // Discard restores the server state that is now real.
      set((state) => ({
        whatIfMode: true,
        whatIfSnapshot: serverProjects
          ? { projects: structuredClone(serverProjects) }
          : state.whatIfSnapshot,
        whatIfPendingOperations: lateOperations,
        whatIfApplyError: null,
      }));
      return true;
    }

    // Partial apply: keep the failed + remaining operations, stay in What-If.
    console.error('[What If] Failed to apply operations:', failure);
    const total = whatIfPendingOperations.length;
    const applyError: WhatIfApplyError = { applied, total, message: errorMessage(failure) };
    if (serverProjects) {
      useAppStore.getState().setProjects(serverProjects);
    }
    set((state) => ({
      whatIfMode: true,
      // Discard from here must restore what is really on the server now,
      // not the pre-What-If state (the first `applied` operations landed).
      whatIfSnapshot: serverProjects
        ? { projects: structuredClone(serverProjects) }
        : state.whatIfSnapshot,
      whatIfPendingOperations: [...whatIfPendingOperations.slice(applied), ...lateOperations],
      whatIfApplyError: applyError,
    }));

    // WhatIfToggle shows whatIfApplyError as a banner with Retry / Discard.
    return false;
  },

  reset: () => set(exitedState()),

  dismissApplyError: () => set({ whatIfApplyError: null }),

  queueWhatIfOperation: (operation) => {
    set((state) => ({
      whatIfPendingOperations: [
        ...state.whatIfPendingOperations,
        {
          ...operation,
          id: `op_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
          timestamp: Date.now(),
        },
      ],
    }));
  },
}));
