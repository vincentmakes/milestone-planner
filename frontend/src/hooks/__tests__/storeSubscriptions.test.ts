/**
 * F1-17: hooks subscribe to the store fields they use, not to whole stores.
 * A whole-store subscription re-rendered every host (App via useDataLoader,
 * every timeline row via the drag/resize hooks) on any unrelated change,
 * e.g. each tooltip move during a drag.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { Project } from '@/types';

vi.mock('@/api', () => ({}));

import { useDataLoader } from '../useDataLoader';
import { useDragAndDrop } from '../useDragAndDrop';
import { useResize } from '../useResize';
import { useDependencyLinking } from '../useDependencyLinking';
import { useGanttGrouping } from '../useGanttGrouping';
import { useGanttColorBy } from '../useGanttColorBy';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';

function countRenders<T>(hook: () => T) {
  let renders = 0;
  renderHook(() => {
    renders++;
    return hook();
  });
  return () => renders;
}

afterEach(() => {
  cleanup();
});

describe('store subscriptions', () => {
  it('useDataLoader does not re-render on data or UI changes', () => {
    const renders = countRenders(() => useDataLoader());
    const before = renders();

    act(() => {
      useAppStore.setState({ projects: [{ id: 99 } as Project] });
      useCustomColumnStore.setState({ customColumnValues: { '1-phase-1': 'x' } });
      useUIStore.setState({ activeModal: 'project' });
    });

    expect(renders()).toBe(before);
    act(() => useUIStore.setState({ activeModal: null }));
  });

  const gestureHooks: Array<[string, () => unknown]> = [
    ['useDragAndDrop', () => useDragAndDrop()],
    ['useResize', () => useResize()],
    ['useDependencyLinking', () => useDependencyLinking()],
  ];
  it.each(gestureHooks)('%s ignores unrelated uiStore / viewStore changes', (_name, hook) => {
    const renders = countRenders(hook);
    const before = renders();

    act(() => {
      // Tooltip / indicator / modal state the hooks do not read.
      useUIStore.setState({ activeModal: 'phase' });
      useUIStore.getState().showTooltip('x', 10, 10);
      useViewStore.setState({ timelineScrollLeft: 1234 });
    });

    expect(renders()).toBe(before);
    act(() => useUIStore.setState({ activeModal: null }));
  });

  it('useGanttGrouping ignores project data, scroll and other sites\' preferences', () => {
    useAppStore.setState({ currentSite: { id: 1, name: 'Basel' } as never });
    const renders = countRenders(() => useGanttGrouping());
    const before = renders();

    act(() => {
      useAppStore.setState({ projects: [{ id: 98 } as Project] });
      useViewStore.setState({ timelineScrollLeft: 4321 });
      useViewStore.getState().setGanttGrouping(2, 7);
      useViewStore.getState().toggleGanttSection(2, 'none');
    });

    expect(renders()).toBe(before);

    // ...but follows its own site's grouping.
    act(() => useViewStore.getState().setGanttGrouping(1, 7));
    expect(renders()).toBeGreaterThan(before);
    act(() => useViewStore.setState({ ganttGrouping: {}, collapsedGanttSections: {} }));
  });

  it('useGanttColorBy ignores project data, scroll, grouping and other sites\' preferences', () => {
    useAppStore.setState({ currentSite: { id: 1, name: 'Basel' } as never });
    const renders = countRenders(() => useGanttColorBy());
    const before = renders();

    act(() => {
      useAppStore.setState({ projects: [{ id: 97 } as Project] });
      useViewStore.setState({ timelineScrollLeft: 5678 });
      useViewStore.getState().setGanttColorBy(2, 7);
      useViewStore.getState().setGanttGrouping(1, 7);
    });

    expect(renders()).toBe(before);

    // ...but follows its own site's colouring.
    act(() => useViewStore.getState().setGanttColorBy(1, 7));
    expect(renders()).toBeGreaterThan(before);
    act(() => useViewStore.setState({ ganttColorBy: {}, ganttGrouping: {}, collapsedGanttSections: {} }));
  });

  it('useDragAndDrop still re-renders when the drag state it reads changes', () => {
    const renders = countRenders(() => useDragAndDrop());
    const before = renders();

    act(() => useUIStore.setState({ isDragging: true }));

    expect(renders()).toBeGreaterThan(before);
    act(() => useUIStore.setState({ isDragging: false }));
  });
});
