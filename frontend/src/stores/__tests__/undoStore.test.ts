import { describe, it, expect, beforeEach } from 'vitest';
import { useUndoStore } from '../undoStore';
import { makeProject } from '@/test/factories';

const undo = () => useUndoStore.getState();

describe('undoStore', () => {
  beforeEach(() => undo().clear());

  it('snapshots deep copies and walks undo/redo in order', () => {
    const v1 = [makeProject({ name: 'v1' })];
    undo().saveState(v1, 'rename');
    v1[0].name = 'mutated after save';
    expect(undo()).toMatchObject({ canUndo: true, canRedo: false });

    const target = undo().popUndo([makeProject({ name: 'v2' })]);
    expect(target?.projects[0].name).toBe('v1');
    expect(target?.description).toBe('rename');
    expect(undo()).toMatchObject({ canUndo: false, canRedo: true });

    const redo = undo().popRedo([makeProject({ name: 'v1' })]);
    expect(redo?.projects[0].name).toBe('v2');
    expect(undo()).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('returns null on empty stacks', () => {
    expect(undo().popUndo([])).toBeNull();
    expect(undo().popRedo([])).toBeNull();
  });

  it('drops the redo stack on a new save and caps history at 50', () => {
    undo().saveState([], 'a');
    undo().popUndo([]);
    expect(undo().canRedo).toBe(true);
    undo().saveState([], 'b');
    expect(undo().canRedo).toBe(false);

    for (let i = 0; i < 60; i++) undo().saveState([], `edit ${i}`);
    expect(undo().undoStack).toHaveLength(50);
    expect(undo().undoStack[0].description).toBe('edit 10');
  });

  it('clear() empties both stacks', () => {
    undo().saveState([], 'a');
    undo().popUndo([]);
    undo().saveState([], 'b');
    undo().clear();
    expect(undo()).toMatchObject({ undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  });
});
