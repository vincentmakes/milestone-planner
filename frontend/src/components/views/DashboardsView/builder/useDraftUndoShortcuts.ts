/**
 * useDraftUndoShortcuts — the builder's undo / redo keys (2.1.0).
 *
 * While the dashboard is edited, Ctrl/Cmd+Z undoes the draft's last change
 * and Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z redoes it. Same ignore rules as the
 * Gantt's `useKeyboardShortcuts`: nothing while focus is in an input, a
 * textarea or a contentEditable (the field's own undo), nothing while a
 * modal is open (the widget editor and the dialogs own their keys), and
 * nothing while the draft is being saved. The listener is registered only
 * while editing; the Gantt's shortcut stands down outside the Gantt view.
 */

import { useEffect, useRef } from 'react';
import { useUIStore } from '@/stores/uiStore';
import type { DashboardEditor } from './useDashboardEditor';

type UndoTarget = Pick<DashboardEditor, 'editing' | 'saving' | 'undo' | 'redo'>;

/** Whether a key press is undo, redo, or neither. */
export function undoKeyOf(e: KeyboardEvent): 'undo' | 'redo' | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === 'y' || (key === 'z' && e.shiftKey)) return 'redo';
  if (key === 'z') return 'undo';
  return null;
}

export function useDraftUndoShortcuts(editor: UndoTarget): void {
  const latest = useRef(editor);
  latest.current = editor;
  const { editing } = editor;

  useEffect(() => {
    if (!editing) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      const action = undoKeyOf(e);
      if (!action) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const { activeModal, openModalCount } = useUIStore.getState();
      if (activeModal || openModalCount > 0) return;
      const current = latest.current;
      if (current.saving) return;
      e.preventDefault();
      if (action === 'undo') current.undo();
      else current.redo();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [editing]);
}
