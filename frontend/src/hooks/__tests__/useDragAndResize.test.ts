/**
 * Bar drag / resize gestures on the Gantt timeline.
 *
 * F1-5: a `projects` change mid-gesture (WebSocket refetch) used to strip the
 * live document listeners, silently abandoning the drag. F1-6: date-only
 * strings were parsed as UTC, so drops landed a day early west of UTC. The
 * file is pinned to America/New_York so both regressions show up anywhere.
 */
// No @types/node in the app tsconfig; vitest runs on Node, where this exists.
declare const process: { env: Record<string, string | undefined> };
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import type React from 'react';
import type { Project, User } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  updatePhase: vi.fn(async () => ({})),
  updateSubphase: vi.fn(async () => ({})),
  updateProject: vi.fn(async () => ({})),
  updateStaffAssignment: vi.fn(async () => ({})),
  updateEquipmentAssignment: vi.fn(async () => ({})),
  loadAllProjects: vi.fn(async () => []),
}));

import { useDragAndDrop } from '../useDragAndDrop';
import { useResize } from '../useResize';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { updatePhase } from '@/api/endpoints/projects';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function makeProject(start: string, end: string): Project {
  return {
    id: 1,
    name: 'Proj',
    site_id: 1,
    confirmed: true,
    archived: false,
    start_date: start,
    end_date: end,
    phases: [
      {
        id: 10,
        project_id: 1,
        name: 'Phase',
        start_date: start,
        end_date: end,
        color: '#000',
        order_index: 0,
        status: 'todo',
        dependencies: [],
        children: [],
        staffAssignments: [],
        equipmentAssignments: [],
      },
    ],
    staffAssignments: [],
    equipmentAssignments: [],
  };
}

/** Header cells as TimelineHeader renders them (data-date = yyyy-MM-dd). */
function renderCells(cells: Array<{ date: string; end?: string }>) {
  const header = document.createElement('div');
  header.id = 'test-header';
  for (const c of cells) {
    const cell = document.createElement('div');
    cell.setAttribute('data-date', c.date);
    if (c.end) cell.setAttribute('data-date-end', c.end);
    header.appendChild(cell);
  }
  document.body.appendChild(header);
}

function marchCells() {
  renderCells(Array.from({ length: 31 }, (_, i) => ({ date: `2026-03-${String(i + 1).padStart(2, '0')}` })));
}

function makeBar(leftPx: number, widthPx = 150): HTMLElement {
  const bar = document.createElement('div');
  bar.dataset.phaseId = '10';
  bar.style.left = `${leftPx}px`;
  bar.style.width = `${widthPx}px`;
  bar.getBoundingClientRect = () => ({ width: widthPx } as DOMRect);
  document.body.appendChild(bar);
  return bar;
}

function mouseDown(el: HTMLElement, clientX: number): React.MouseEvent {
  return {
    clientX,
    target: el,
    currentTarget: el,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.MouseEvent;
}

const move = (clientX: number) => document.dispatchEvent(new MouseEvent('mousemove', { clientX }));
const up = () => document.dispatchEvent(new MouseEvent('mouseup'));

/** A WebSocket refetch landing mid-gesture: same data, new array identity. */
function refetchProjects() {
  act(() => {
    useAppStore.getState().setProjects(structuredClone(useAppStore.getState().projects));
  });
}

describe('Gantt drag & resize (America/New_York)', () => {
  beforeEach(() => {
    vi.mocked(updatePhase).mockClear();
    useAppStore.setState({
      currentUser: { id: 1, role: 'admin' } as User,
      projects: [makeProject('2026-03-02', '2026-03-06')],
    });
    useViewStore.setState({ viewMode: 'month', cellWidth: 30, currentView: 'gantt' });
    useUIStore.setState({ isDragging: false, isResizing: false });
    useUndoStore.getState().clear();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('runs west of UTC', () => {
    expect(new Date(2026, 2, 2).getTimezoneOffset()).toBeGreaterThan(0);
  });

  it('a drag survives a projects refetch mid-gesture and persists the dropped dates', async () => {
    marchCells();
    const bar = makeBar(30); // cell 1 = Mar 2
    const { result, rerender } = renderHook(() => useDragAndDrop());

    act(() => {
      result.current.startPhaseDrag(mouseDown(bar, 100), 10, 1, '2026-03-02', '2026-03-06', false, bar);
    });
    expect(useUIStore.getState().isDragging).toBe(true);

    refetchProjects();
    rerender();

    move(160); // +60px = +2 cells
    up();

    await waitFor(() => expect(updatePhase).toHaveBeenCalled());
    expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-03-04', end_date: '2026-03-08' });
    await waitFor(() => expect(useUIStore.getState().isDragging).toBe(false));
    expect(bar.style.opacity).toBe('1');
    const phase = useAppStore.getState().projects[0].phases[0];
    expect([phase.start_date, phase.end_date]).toEqual(['2026-03-04', '2026-03-08']);
  });

  it('a drag survives a cellWidth change (Ctrl+wheel zoom) mid-gesture', async () => {
    marchCells();
    const bar = makeBar(30);
    const { result, rerender } = renderHook(() => useDragAndDrop());

    act(() => {
      result.current.startPhaseDrag(mouseDown(bar, 100), 10, 1, '2026-03-02', '2026-03-06', false, bar);
    });
    act(() => useViewStore.setState({ cellWidth: 40 }));
    act(() => useViewStore.setState({ cellWidth: 30 }));
    rerender();

    move(130);
    up();

    await waitFor(() => expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-03-03', end_date: '2026-03-07' }));
    await waitFor(() => expect(useUIStore.getState().isDragging).toBe(false));
  });

  it('quarter view: the proportional inverse starts at the first cell, not the day before', async () => {
    useViewStore.setState({ viewMode: 'quarter', cellWidth: 70 });
    // Weekly cells, Mon 2026-01-05 .. Sun 2026-03-01 (no DST switch inside).
    const cells = Array.from({ length: 8 }, (_, i) => {
      const start = new Date(2026, 0, 5 + i * 7);
      const end = new Date(2026, 0, 11 + i * 7);
      const f = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { date: f(start), end: f(end) };
    });
    renderCells(cells);
    useAppStore.setState({ projects: [makeProject('2026-01-05', '2026-01-09')] });
    const bar = makeBar(0);
    const { result } = renderHook(() => useDragAndDrop());

    act(() => {
      result.current.startPhaseDrag(mouseDown(bar, 100), 10, 1, '2026-01-05', '2026-01-09', false, bar);
    });
    move(135); // +35px = 3.5 days at 70px/week
    up();

    await waitFor(() =>
      expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-01-08', end_date: '2026-01-12' })
    );
  });

  it('a resize survives a projects refetch mid-gesture and persists the new end date', async () => {
    marchCells();
    const bar = makeBar(30, 150); // Mar 2 .. Mar 6
    const { result, rerender } = renderHook(() => useResize());

    act(() => {
      result.current.startPhaseResize(mouseDown(bar, 300), 10, 1, 'right', '2026-03-02', '2026-03-06', bar);
    });
    expect(useUIStore.getState().isResizing).toBe(true);

    refetchProjects();
    rerender();

    move(360); // +60px = +2 days on the right edge
    up();

    await waitFor(() =>
      expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-03-02', end_date: '2026-03-08' })
    );
    await waitFor(() => expect(useUIStore.getState().isResizing).toBe(false));
  });

  it('unmounting mid-drag detaches the listeners and ends the drag', () => {
    marchCells();
    const bar = makeBar(30);
    const { result, unmount } = renderHook(() => useDragAndDrop());

    act(() => {
      result.current.startPhaseDrag(mouseDown(bar, 100), 10, 1, '2026-03-02', '2026-03-06', false, bar);
    });
    unmount();

    expect(useUIStore.getState().isDragging).toBe(false);
    move(160);
    up();
    expect(updatePhase).not.toHaveBeenCalled();
  });
});
