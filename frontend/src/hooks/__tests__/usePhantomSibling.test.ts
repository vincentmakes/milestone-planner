/**
 * Shift+click "phantom sibling": a ghost bar that follows the cursor and,
 * once placed, opens the phase/subphase dialog preset with its dates and an
 * SS/FS dependency on the source item.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePhantomSibling } from '../usePhantomSibling';
import { resetAllStores, useAppStore, useUIStore, useViewStore } from '@/stores';
import { makePhase, makeProject, makeSubphase, makeUser } from '@/test/factories';
import type { TimelineCell } from '@/components/gantt/utils';

const nested = makeSubphase({
  id: 31,
  parent_phase_id: 10,
  parent_subphase_id: 30,
  color: '#ff00aa',
  start_date: '2026-01-12',
  end_date: '2026-01-12',
  is_milestone: true,
});

function seed(role: 'admin' | 'user' = 'admin') {
  useAppStore.setState({
    currentUser: makeUser({ id: 1, role }),
    projects: [
      makeProject({
        id: 1,
        pm_id: 5,
        phases: [
          makePhase({ id: 9, start_date: '2026-01-02', end_date: '2026-01-02' }),
          makePhase({
            id: 10,
            start_date: '2026-01-05',
            end_date: '2026-01-09',
            children: [
              makeSubphase({
                id: 30,
                parent_phase_id: 10,
                color: '',
                start_date: '2026-01-05',
                end_date: '2026-01-14',
                children: [makeSubphase({ id: 29, parent_phase_id: 10, parent_subphase_id: 30 }), nested],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

/** January 2026 as day cells (no DST switch anywhere) */
const januaryCells = Array.from({ length: 31 }, (_, i) => ({ date: new Date(2026, 0, i + 1) })) as TimelineCell[];
const rect = { left: 100 } as DOMRect;

beforeEach(() => {
  resetAllStores();
  useViewStore.setState({ expandedPhases: new Set(), expandedSubphases: new Set() });
  seed();
});

afterEach(() => {
  document.body.classList.remove('phantom-sibling-mode');
});

describe('usePhantomSibling.startPhantom', () => {
  it('starts a finish-to-start phase sibling right after the source and collapses it', () => {
    useViewStore.setState({ expandedPhases: new Set([10]) });
    const { result } = renderHook(() => usePhantomSibling());
    act(() => result.current.startPhantom({ projectId: 1, sourceId: 10, type: 'phase', zone: 'end' }));

    expect(result.current.isPhantomMode).toBe(true);
    expect(useUIStore.getState().phantomSiblingMode).toMatchObject({
      projectId: 1,
      sourceId: 10,
      type: 'phase',
      dependencyType: 'FS',
      phantomStart: '2026-01-10',
      phantomEnd: '2026-01-14',
      siblingDurationDays: 5,
      sourceIndex: 1,
      parentId: null,
    });
    expect(document.body.classList.contains('phantom-sibling-mode')).toBe(true);
    expect(useViewStore.getState().expandedPhases.has(10)).toBe(false);
  });

  it('starts a start-to-start sibling of a nested milestone with a 5-day default', () => {
    useViewStore.setState({ expandedSubphases: new Set([31]) });
    const { result } = renderHook(() => usePhantomSibling());
    act(() => result.current.startPhantom({ projectId: 1, sourceId: 31, type: 'subphase', zone: 'start' }));

    expect(useUIStore.getState().phantomSiblingMode).toMatchObject({
      type: 'subphase',
      dependencyType: 'SS',
      phantomStart: '2026-01-12',
      phantomEnd: '2026-01-16',
      siblingDurationDays: 5,
      phantomColor: '#ff00aa',
      sourceIndex: 1,
      parentId: 30,
      parentType: 'subphase',
    });
    expect(useViewStore.getState().expandedSubphases.has(31)).toBe(false);
  });

  it('keeps the source duration of a top-level subphase and uses its depth colour', () => {
    const { result } = renderHook(() => usePhantomSibling());
    act(() => result.current.startPhantom({ projectId: 1, sourceId: 30, type: 'subphase', zone: 'end' }));
    const mode = useUIStore.getState().phantomSiblingMode!;
    expect(mode).toMatchObject({
      phantomStart: '2026-01-15',
      phantomEnd: '2026-01-24',
      siblingDurationDays: 10,
      parentId: 10,
      parentType: 'phase',
      sourceIndex: 0,
    });
    expect(mode.phantomColor).not.toBe('');
  });

  it('gives a one-day phase a 5-day sibling', () => {
    const { result } = renderHook(() => usePhantomSibling());
    act(() => result.current.startPhantom({ projectId: 1, sourceId: 9, type: 'phase', zone: 'end' }));
    expect(useUIStore.getState().phantomSiblingMode).toMatchObject({
      phantomStart: '2026-01-03',
      phantomEnd: '2026-01-07',
      sourceIndex: 0,
    });
  });

  it('does nothing for non-editors, unknown projects or unknown sources', () => {
    const { result, rerender } = renderHook(() => usePhantomSibling());
    act(() => {
      result.current.startPhantom({ projectId: 2, sourceId: 10, type: 'phase', zone: 'end' });
      result.current.startPhantom({ projectId: 1, sourceId: 77, type: 'phase', zone: 'end' });
      result.current.startPhantom({ projectId: 1, sourceId: 77, type: 'subphase', zone: 'end' });
    });
    expect(useUIStore.getState().phantomSiblingMode).toBeNull();

    act(() => seed('user'));
    rerender();
    act(() => result.current.startPhantom({ projectId: 1, sourceId: 10, type: 'phase', zone: 'end' }));
    expect(useUIStore.getState().phantomSiblingMode).toBeNull();
    expect(document.body.classList.contains('phantom-sibling-mode')).toBe(false);
  });
});

describe('usePhantomSibling while placing', () => {
  it('centres the ghost on the cursor and clamps it to the timeline', () => {
    const { result } = renderHook(() => usePhantomSibling());
    // nothing to move yet
    act(() => result.current.updatePhantom(400, rect, 0, januaryCells, 30));
    expect(useUIStore.getState().phantomSiblingMode).toBeNull();

    act(() => result.current.startPhantom({ projectId: 1, sourceId: 10, type: 'phase', zone: 'end' }));

    act(() => result.current.updatePhantom(400, rect, 0, januaryCells, 30)); // 300px in -> bar from 240px
    expect(useUIStore.getState().phantomSiblingMode).toMatchObject({
      phantomStart: '2026-01-08',
      phantomEnd: '2026-01-12',
    });

    act(() => result.current.updatePhantom(0, rect, 0, januaryCells, 30));
    expect(useUIStore.getState().phantomSiblingMode!.phantomStart).toBe('2026-01-01');

    act(() => result.current.updatePhantom(5000, rect, 0, januaryCells, 30));
    expect(useUIStore.getState().phantomSiblingMode!.phantomEnd).toBe('2026-01-31');

    // an empty timeline leaves the position alone
    act(() => result.current.updatePhantom(400, rect, 0, [], 30));
    expect(useUIStore.getState().phantomSiblingMode!.phantomEnd).toBe('2026-01-31');
  });

  it('reports the lag against the source for FS and SS', () => {
    const { result } = renderHook(() => usePhantomSibling());
    expect(result.current.calculateLag()).toEqual({ lagDays: 0, dependencyType: 'FS' });

    act(() => result.current.startPhantom({ projectId: 1, sourceId: 10, type: 'phase', zone: 'end' }));
    expect(result.current.calculateLag()).toEqual({ lagDays: 0, dependencyType: 'FS' });
    act(() => result.current.updatePhantom(400, rect, 60, januaryCells, 30)); // starts Jan 10 + 2
    expect(result.current.calculateLag()).toEqual({ lagDays: 0, dependencyType: 'FS' });
    act(() => result.current.updatePhantom(460, rect, 60, januaryCells, 30));
    expect(result.current.calculateLag()).toEqual({ lagDays: 2, dependencyType: 'FS' });
    act(() => result.current.cancelPhantom());

    act(() => result.current.startPhantom({ projectId: 1, sourceId: 30, type: 'subphase', zone: 'start' }));
    act(() => result.current.updatePhantom(220, rect, 0, januaryCells, 30)); // centred -> Jan 1
    expect(result.current.calculateLag()).toEqual({ lagDays: -4, dependencyType: 'SS' });
  });

  it('reports no lag when the project or source has gone', () => {
    const { result, rerender } = renderHook(() => usePhantomSibling());
    act(() => result.current.startPhantom({ projectId: 1, sourceId: 30, type: 'subphase', zone: 'end' }));
    act(() => useAppStore.setState({ projects: [makeProject({ id: 1, phases: [] })] }));
    rerender();
    expect(result.current.calculateLag()).toEqual({ lagDays: 0, dependencyType: 'FS' });
    act(() => useAppStore.setState({ projects: [] }));
    rerender();
    expect(result.current.calculateLag()).toEqual({ lagDays: 0, dependencyType: 'FS' });
  });

  it('is cancelled with Escape', () => {
    const { result } = renderHook(() => usePhantomSibling());
    act(() => result.current.startPhantom({ projectId: 1, sourceId: 10, type: 'phase', zone: 'end' }));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(useUIStore.getState().phantomSiblingMode).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useUIStore.getState().phantomSiblingMode).toBeNull();
    expect(document.body.classList.contains('phantom-sibling-mode')).toBe(false);
  });
});

describe('usePhantomSibling.completePhantom', () => {
  it('opens the phase dialog with the placed dates and the dependency preset', async () => {
    const { result } = renderHook(() => usePhantomSibling());
    act(() => result.current.completePhantom()); // no-op outside phantom mode
    act(() => result.current.startPhantom({ projectId: 1, sourceId: 10, type: 'phase', zone: 'end' }));
    act(() => result.current.completePhantom());

    expect(useUIStore.getState().phantomSiblingMode).toBeNull();
    await waitFor(() => expect(useUIStore.getState().activeModal).toBe('phase'));
    expect(useUIStore.getState().modalContext).toEqual({
      projectId: 1,
      phantomPreset: {
        startDate: '2026-01-10',
        endDate: '2026-01-14',
        predecessorId: 10,
        dependencyType: 'FS',
        parentId: null,
        parentType: undefined,
      },
    });
  });

  it('opens the subphase dialog under the parent phase', async () => {
    const { result } = renderHook(() => usePhantomSibling());
    act(() => result.current.startPhantom({ projectId: 1, sourceId: 30, type: 'subphase', zone: 'start' }));
    act(() => result.current.completePhantom());
    await waitFor(() => expect(useUIStore.getState().activeModal).toBe('subphase'));
    expect(useUIStore.getState().modalContext).toMatchObject({ phaseId: 10, projectId: 1, subphaseId: undefined });
  });

  it('opens the subphase dialog under the parent subphase and its root phase', async () => {
    const { result } = renderHook(() => usePhantomSibling());
    act(() => result.current.startPhantom({ projectId: 1, sourceId: 31, type: 'subphase', zone: 'end' }));
    act(() => result.current.completePhantom());
    await waitFor(() => expect(useUIStore.getState().activeModal).toBe('subphase'));
    expect(useUIStore.getState().modalContext).toMatchObject({
      phaseId: 10,
      projectId: 1,
      subphaseId: 30,
      phantomPreset: { predecessorId: 31, dependencyType: 'FS', parentType: 'subphase' },
    });
  });
});
