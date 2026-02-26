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
import { apiRequest, clientConfig } from '@/api/client';
import type { Project } from '@/types';

// =============================================================================
// TYPES
// =============================================================================

/** Represents a pending API operation for What-If mode */
export interface WhatIfOperation {
  id: string;
  method: 'POST' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  timestamp: number;
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
   * Returns the snapshot projects (for discard) or null (for apply/no-op).
   * The caller is responsible for:
   *   - Restoring projects from snapshot on discard
   *   - Replaying pending operations on apply
   */
  exitWhatIfMode: (applyChanges: boolean) => Promise<void>;

  /** Queue an API operation to be replayed when applying What-If changes */
  queueWhatIfOperation: (operation: Omit<WhatIfOperation, 'id' | 'timestamp'>) => void;
}

// =============================================================================
// STORE CREATION
// =============================================================================

export const useWhatIfStore = create<WhatIfState>()((set, get) => ({
  whatIfMode: false,
  whatIfSnapshot: null,
  whatIfPendingOperations: [],

  enterWhatIfMode: (currentProjects: Project[]) => {
    set({
      whatIfMode: true,
      whatIfSnapshot: {
        projects: structuredClone(currentProjects),
      },
      whatIfPendingOperations: [],
    });
  },

  exitWhatIfMode: async (applyChanges) => {
    const { whatIfSnapshot, whatIfPendingOperations } = get();

    if (!applyChanges && whatIfSnapshot) {
      // Discard: Restore original state
      useAppStore.getState().setProjects(whatIfSnapshot.projects);
      set({
        whatIfMode: false,
        whatIfSnapshot: null,
        whatIfPendingOperations: [],
      });
    } else if (applyChanges && whatIfPendingOperations.length > 0) {
      // Apply: Execute all pending operations
      // Temporarily disable What-If mode check for these requests
      const originalIsWhatIfMode = clientConfig.isWhatIfMode;
      clientConfig.isWhatIfMode = () => false;

      try {
        for (const op of whatIfPendingOperations) {
          await apiRequest(op.url, {
            method: op.method,
            body: op.body,
          });
        }
      } catch (error) {
        console.error('[What If] Failed to apply operations:', error);
        // Note: Some operations may have succeeded, so we don't restore snapshot
        // User should reload to see actual state
      } finally {
        // Restore the What-If mode check
        clientConfig.isWhatIfMode = originalIsWhatIfMode;
      }

      set({
        whatIfMode: false,
        whatIfSnapshot: null,
        whatIfPendingOperations: [],
      });
    } else {
      // No changes or no pending ops, just exit
      set({
        whatIfMode: false,
        whatIfSnapshot: null,
        whatIfPendingOperations: [],
      });
    }
  },

  queueWhatIfOperation: (operation) => {
    set((state) => ({
      whatIfPendingOperations: [
        ...state.whatIfPendingOperations,
        {
          ...operation,
          id: `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          timestamp: Date.now(),
        },
      ],
    }));
  },
}));
