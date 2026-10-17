/**
 * useKeyboardShortcuts Hook
 *
 * Global keyboard shortcuts for common operations.
 *
 * Shortcuts:
 * - Escape: Cancel current operation (dependency linking, then phantom mode).
 *
 * Every shortcut is ignored while a modal is open: the shared Modal owns
 * Escape and calls its own (possibly guarded, e.g. unsaved-changes) onClose,
 * and undo/redo must not change the Gantt behind a dialog.
 * - Ctrl+Z: Undo
 * - Ctrl+Y / Ctrl+Shift+Z: Redo
 * - Home: Jump to today
 * - +/-: Zoom in/out
 */

import { useEffect, useCallback } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { useUndoRedo } from './useUndoRedo';

// Zoom limits (same as useCtrlScrollZoom)
const MIN_CELL_WIDTH = 12;
const MAX_CELL_WIDTH = 120;
const ZOOM_STEP = 4;

export function useKeyboardShortcuts() {
  const triggerScrollToToday = useUIStore((s) => s.triggerScrollToToday);
  const triggerZoom = useUIStore((s) => s.triggerZoom);
  const endPhantomSibling = useUIStore((s) => s.endPhantomSibling);
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  const cancelLinking = useUIStore((s) => s.cancelLinking);
  const isLinkingDependency = useUIStore((s) => s.isLinkingDependency);
  const activeModal = useUIStore((s) => s.activeModal);

  const cellWidth = useViewStore((s) => s.cellWidth);
  const setCellWidth = useViewStore((s) => s.setCellWidth);

  const { undo, redo } = useUndoRedo();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Don't handle shortcuts when focused on input elements
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    // Nothing global while a modal is open: the modal owns the keyboard.
    // An open modal handles Escape itself (shared Modal / useEscapeKey), and
    // closing it from here would bypass its guarded onClose; Ctrl+Z/Ctrl+Y
    // with focus on one of its buttons would undo/redo (and persist) the
    // Gantt hidden behind it; Home/+/- would scroll or zoom it.
    if (activeModal) return;

    // Escape - Cancel current operation
    if (e.key === 'Escape') {
      // Priority: Dependency Linking > Phantom Mode
      if (isLinkingDependency) {
        cancelLinking();
        e.preventDefault();
        return;
      }
      if (phantomSiblingMode) {
        document.body.classList.remove('phantom-sibling-mode');
        endPhantomSibling();
        e.preventDefault();
        return;
      }
    }

    // Home - Jump to today
    if (e.key === 'Home' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      triggerScrollToToday();
      e.preventDefault();
      return;
    }

    // + or = - Zoom in (centered)
    if ((e.key === '+' || e.key === '=') && !e.ctrlKey) {
      const newWidth = Math.min(cellWidth + ZOOM_STEP, MAX_CELL_WIDTH);
      if (newWidth !== cellWidth) {
        triggerZoom(1, newWidth);
        setCellWidth(newWidth);
      }
      e.preventDefault();
      return;
    }

    // - Zoom out (centered)
    if (e.key === '-' && !e.ctrlKey) {
      const newWidth = Math.max(cellWidth - ZOOM_STEP, MIN_CELL_WIDTH);
      if (newWidth !== cellWidth) {
        triggerZoom(-1, newWidth);
        setCellWidth(newWidth);
      }
      e.preventDefault();
      return;
    }

    const ctrlOrMeta = e.ctrlKey || e.metaKey;

    // Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y - Redo
    if (
      ctrlOrMeta &&
      ((e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey) || e.key === 'y' || e.key === 'Y')
    ) {
      void redo();
      e.preventDefault();
      return;
    }

    // Ctrl/Cmd+Z - Undo
    if (ctrlOrMeta && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      void undo();
      e.preventDefault();
      return;
    }
  }, [
    activeModal,
    isLinkingDependency,
    cancelLinking,
    phantomSiblingMode,
    endPhantomSibling,
    triggerScrollToToday,
    triggerZoom,
    cellWidth,
    setCellWidth,
    undo,
    redo,
  ]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
