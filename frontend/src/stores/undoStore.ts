/**
 * Undo/Redo Store
 *
 * Manages undo/redo history for Gantt chart operations.
 * Each entry stores a snapshot of the project tree (a "before" state for undo,
 * an "after" state for redo). Session-level only — not persisted.
 *
 * Semantics:
 *   - saveState(before): call BEFORE applying a change. Pushes `before` onto
 *     the undo stack and clears the redo stack.
 *   - popUndo(current): pops the top of the undo stack (the snapshot to
 *     restore) and pushes `current` onto the redo stack.
 *   - popRedo(current): pops the top of the redo stack and pushes `current`
 *     onto the undo stack.
 */
import { create } from 'zustand';
import type { Project } from '@/types';

export interface HistoryEntry {
  projects: Project[];
  description: string;
  timestamp: number;
}

interface UndoState {
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  canUndo: boolean;
  canRedo: boolean;

  saveState: (projects: Project[], description: string) => void;
  popUndo: (currentProjects: Project[]) => HistoryEntry | null;
  popRedo: (currentProjects: Project[]) => HistoryEntry | null;
  clear: () => void;
}

const MAX_UNDO_STACK = 50;

function snapshot(projects: Project[], description: string): HistoryEntry {
  return {
    projects: structuredClone(projects),
    description,
    timestamp: Date.now(),
  };
}

export const useUndoStore = create<UndoState>()((set, get) => ({
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,

  saveState: (projects, description) => {
    set((state) => {
      const newStack = [...state.undoStack, snapshot(projects, description)].slice(-MAX_UNDO_STACK);
      return {
        undoStack: newStack,
        redoStack: [],
        canUndo: true,
        canRedo: false,
      };
    });
  },

  popUndo: (currentProjects) => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) return null;

    const target = undoStack[undoStack.length - 1];
    const newUndoStack = undoStack.slice(0, -1);
    const newRedoStack = [...redoStack, snapshot(currentProjects, target.description)];

    set({
      undoStack: newUndoStack,
      redoStack: newRedoStack,
      canUndo: newUndoStack.length > 0,
      canRedo: true,
    });

    return target;
  },

  popRedo: (currentProjects) => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) return null;

    const target = redoStack[redoStack.length - 1];
    const newRedoStack = redoStack.slice(0, -1);
    const newUndoStack = [...undoStack, snapshot(currentProjects, target.description)];

    set({
      undoStack: newUndoStack,
      redoStack: newRedoStack,
      canUndo: true,
      canRedo: newRedoStack.length > 0,
    });

    return target;
  },

  clear: () => {
    set({
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    });
  },
}));
