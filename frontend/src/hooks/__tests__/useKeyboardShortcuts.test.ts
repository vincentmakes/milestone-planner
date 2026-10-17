/**
 * Global shortcuts must leave open modals alone (F1-25: no undo/redo of the
 * Gantt behind a dialog). The global Escape shortcut must leave open modals alone: the shared Modal
 * owns Escape and calls its own onClose (the Settings hub's is guarded by an
 * unsaved-changes confirm). With no modal open, Escape still cancels
 * dependency linking first, then phantom-sibling mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, fireEvent } from '@testing-library/react';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { useUIStore } from '@/stores/uiStore';

const undoRedo = vi.hoisted(() => ({ undo: vi.fn(), redo: vi.fn() }));
vi.mock('../useUndoRedo', () => ({
  useUndoRedo: () => undoRedo,
}));

const pressEscape = () => fireEvent.keyDown(document, { key: 'Escape' });

const originalEndPhantomSibling = useUIStore.getState().endPhantomSibling;

describe('useKeyboardShortcuts – Escape', () => {
  beforeEach(() => {
    useUIStore.setState({
      activeModal: null,
      isLinkingDependency: false,
      phantomSiblingMode: null,
    });
  });

  afterEach(() => {
    cleanup();
    useUIStore.setState({ endPhantomSibling: originalEndPhantomSibling });
  });

  it('does not close an open modal (the modal handles Escape itself)', () => {
    useUIStore.setState({ activeModal: 'settingsHub' });
    renderHook(() => useKeyboardShortcuts());

    pressEscape();

    expect(useUIStore.getState().activeModal).toBe('settingsHub');
  });

  it('does not cancel dependency linking while a modal is open', () => {
    useUIStore.setState({ activeModal: 'project', isLinkingDependency: true });
    renderHook(() => useKeyboardShortcuts());

    pressEscape();

    expect(useUIStore.getState().isLinkingDependency).toBe(true);
    expect(useUIStore.getState().activeModal).toBe('project');
  });

  it('cancels dependency linking when no modal is open', () => {
    useUIStore.setState({ isLinkingDependency: true });
    renderHook(() => useKeyboardShortcuts());

    pressEscape();

    expect(useUIStore.getState().isLinkingDependency).toBe(false);
  });

  it('ends phantom-sibling mode when no modal is open and nothing is being linked', () => {
    const endPhantomSibling = vi.fn();
    useUIStore.setState({
      phantomSiblingMode: {
        projectId: 1,
        sourceId: 2,
        type: 'phase',
        dependencyType: 'FS',
        phantomStart: '2026-01-05',
        phantomEnd: '2026-01-09',
        phantomColor: '#000000',
        siblingDurationDays: 5,
        sourceIndex: 0,
      },
      endPhantomSibling,
    });
    renderHook(() => useKeyboardShortcuts());

    pressEscape();

    expect(endPhantomSibling).toHaveBeenCalledTimes(1);
  });
});

describe('useKeyboardShortcuts – while a modal is open', () => {
  const { undo, redo } = undoRedo;
  const originalTriggerScrollToToday = useUIStore.getState().triggerScrollToToday;

  beforeEach(() => {
    undo.mockReset();
    redo.mockReset();
    useUIStore.setState({ activeModal: null, isLinkingDependency: false, phantomSiblingMode: null });
  });

  afterEach(() => {
    cleanup();
    useUIStore.setState({ activeModal: null, triggerScrollToToday: originalTriggerScrollToToday });
  });

  it('does not undo/redo the Gantt behind an open modal (focus on one of its buttons)', () => {
    useUIStore.setState({ activeModal: 'phase' });
    renderHook(() => useKeyboardShortcuts());
    const button = document.createElement('button');
    document.body.appendChild(button);

    fireEvent.keyDown(button, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(button, { key: 'y', ctrlKey: true });
    fireEvent.keyDown(button, { key: 'z', metaKey: true, shiftKey: true });

    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    button.remove();
  });

  it('does not scroll or zoom the Gantt behind an open modal', () => {
    const triggerScrollToToday = vi.fn();
    useUIStore.setState({ activeModal: 'phase', triggerScrollToToday });
    renderHook(() => useKeyboardShortcuts());

    fireEvent.keyDown(document, { key: 'Home' });

    expect(triggerScrollToToday).not.toHaveBeenCalled();
  });

  it('undoes and redoes when no modal is open', () => {
    renderHook(() => useKeyboardShortcuts());

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'y', ctrlKey: true });

    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });
});
