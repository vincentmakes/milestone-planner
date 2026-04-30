/**
 * useKeyboardShortcuts Hook
 *
 * Global keyboard shortcuts for common operations.
 *
 * Shortcuts:
 * - Escape: Cancel current operation (phantom mode, dependency linking)
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
  const closeModal = useUIStore((s) => s.closeModal);
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

    // Escape - Cancel current operation
    if (e.key === 'Escape') {
      // Priority: Modal > Dependency Linking > Phantom Mode
      if (activeModal) {
        closeModal();
        e.preventDefault();
        return;
      }
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
    closeModal,
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
