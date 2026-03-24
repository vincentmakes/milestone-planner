/**
 * Undo/Redo Store
 * Manages undo/redo history for Gantt chart operations
 * Session-level only - not persisted
 */

import { create } from 'zustand';
import type { Project } from '@/types';

// =============================================================================
// TYPES
// =============================================================================

interface HistoryEntry {
  projects: Project[];
  description: string;
  timestamp: number;
}

interface UndoState {
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  
  // Computed
  canUndo: boolean;
  canRedo: boolean;
  
  // Actions
  saveState: (projects: Project[], description: string) => void;
  undo: () => Project[] | null;
  redo: () => Project[] | null;
  clear: () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_UNDO_STACK = 50;

// =============================================================================
// STORE
// =============================================================================

export const useUndoStore = create<UndoState>()((set, get) => ({
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,
  
  /**
   * Save current state to undo stack
   * Call this BEFORE making changes
   */
  saveState: (projects, description) => {
    set((state) => {
      const newEntry: HistoryEntry = {
        projects: structuredClone(projects),
        description,
        timestamp: Date.now(),
      };
      
      // Add to stack, keeping within limit
      const newStack = [...state.undoStack, newEntry].slice(-MAX_UNDO_STACK);
      
      return {
        undoStack: newStack,
        redoStack: [], // Clear redo stack on new action
        canUndo: true,
        canRedo: false,
      };
    });
  },
  
  /**
   * Undo last action
   * Returns the previous project state to restore
   */
  undo: () => {
    const { undoStack, redoStack } = get();
    
    if (undoStack.length === 0) {
      return null;
    }
    
    // Pop from undo stack
    const lastEntry = undoStack[undoStack.length - 1];
    const newUndoStack = undoStack.slice(0, -1);
    
    set({
      undoStack: newUndoStack,
      redoStack: [...redoStack, lastEntry],
      canUndo: newUndoStack.length > 0,
      canRedo: true,
    });
    
    // Return the state to restore (previous entry, or null if this was the first)
    return newUndoStack.length > 0 
      ? newUndoStack[newUndoStack.length - 1].projects 
      : null;
  },
  
  /**
   * Redo last undone action
   * Returns the project state to restore
   */
  redo: () => {
    const { undoStack, redoStack } = get();
    
    if (redoStack.length === 0) {
      return null;
    }
    
    // Pop from redo stack
    const nextEntry = redoStack[redoStack.length - 1];
    const newRedoStack = redoStack.slice(0, -1);
    
    set({
      undoStack: [...undoStack, nextEntry],
      redoStack: newRedoStack,
      canUndo: true,
      canRedo: newRedoStack.length > 0,
    });
    
    return nextEntry.projects;
  },
  
  /**
   * Clear all history
   */
  clear: () => {
    set({
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });
  },
}));
