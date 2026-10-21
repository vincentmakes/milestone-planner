/**
 * Bar edge resizing on the Gantt timeline: left/right edges for phases,
 * subphases and bookings, the live resize indicator, the proportional
 * quarter-view inverse, the no-header fallback, the guards and the
 * optimistic-write failure protocol (reload + undo history cleared).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup, fireEvent, createEvent } from '@testing-library/react';
import type React from 'react';

vi.mock('@/api/endpoints/projects', () => ({
  updatePhase: vi.fn(async () => ({})),
  updateSubphase: vi.fn(async () => ({})),
  updateProject: vi.fn(async () => ({})),
  updateStaffAssignment: vi.fn(async () => ({})),
  updateEquipmentAssignment: vi.fn(async () => ({})),
  loadAllProjects: vi.fn(async () => []),
}));

import { useResize } from '../useResize';
import { resetAllStores, useAppStore, useUIStore, useUndoStore, useViewStore } from '@/stores';
import {
  updatePhase,
  updateSubphase,
  updateStaffAssignment,
  updateEquipmentAssignment,
  loadAllProjects,
} from '@/api/endpoints/projects';
import { makePhase, makeProject, makeSubphase, makeUser } from '@/test/factories';
import type { Project } from '@/types';
import { USER_DEFAULTS } from '@/test/permissionFixtures';

function buildProject(): Project {
  return makeProject({
    id: 1,
    start_date: '2026-03-02',
    end_date: '2026-03-20',
    phases: [
      makePhase({
        id: 10,
        start_date: '2026-03-02',
        end_date: '2026-03-06',
        children: [makeSubphase({ id: 20, start_date: '2026-03-02', end_date: '2026-03-04' })],
      }),
    ],
    staffAssignments: [{ id: 50, staff_id: 4, allocation: 40, start_date: '2026-03-02', end_date: '2026-03-06' }],
    equipmentAssignments: [{ id: 60, equipment_id: 1, start_date: '2026-03-02', end_date: '2026-03-04' }],
  });
}

function marchCells() {
  const header = document.createElement('div');
  for (let d = 1; d <= 31; d++) {
    const cell = document.createElement('div');
    cell.setAttribute('data-date', `2026-03-${String(d).padStart(2, '0')}`);
    header.appendChild(cell);
  }
  document.body.appendChild(header);
}

function makeBar(dataset: Record<string, string>, leftPx: number, widthPx: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'timeline-row';
  const bar = document.createElement('div');
  Object.assign(bar.dataset, dataset);
  bar.style.left = `${leftPx}px`;
  bar.style.width = `${widthPx}px`;
  bar.getBoundingClientRect = () => ({ width: widthPx }) as DOMRect;
  row.appendChild(bar);
  document.body.appendChild(row);
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

const move = (clientX: number) =>
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX }));
  });
const up = () => document.dispatchEvent(new MouseEvent('mouseup'));
/** Touch gestures on the document, as the browser delivers them mid-resize. */
const touchMove = (clientX: number) => {
  const ev = createEvent.touchMove(document, { touches: [{ clientX, clientY: 5 }] });
  act(() => {
    fireEvent(document, ev);
  });
  return ev;
};
const touchEnd = () => {
  const ev = createEvent.touchEnd(document, { changedTouches: [{ clientX: 0, clientY: 5 }] });
  act(() => {
    fireEvent(document, ev);
  });
  return ev;
};
const touchCancel = () =>
  act(() => {
    fireEvent.touchCancel(document);
  });

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  useAppStore.setState({ currentUser: makeUser({ id: 1, role: 'admin' }), projects: [buildProject()] });
  useViewStore.setState({ viewMode: 'month', cellWidth: 30, currentView: 'gantt' });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  document.body.style.cursor = '';
  vi.restoreAllMocks();
});

describe('useResize: phases and subphases', () => {
  it('drags the left edge, shows the new start and duration, and persists', async () => {
    marchCells();
    const bar = makeBar({ phaseId: '10' }, 30, 150); // Mar 2 .. Mar 6
    const { result } = renderHook(() => useResize());

    act(() => result.current.startPhaseResize(mouseDown(bar, 30), 10, 1, 'left', '2026-03-02', '2026-03-06', bar));
    expect(useUIStore.getState().resizeEdge).toBe('left');
    expect(document.body.style.cursor).toBe('ew-resize');
    expect(bar.classList.contains('resizing')).toBe(true);

    move(5); // -25px snaps to -1 cell
    expect(bar.style.left).toBe('0px');
    expect(bar.style.width).toBe('180px');
    expect(useUIStore.getState().dragIndicator).toMatchObject({
      visible: true,
      type: 'resize',
      date: '2026-03-01',
      duration: 6,
      edge: 'left',
    });

    up();
    expect(useUIStore.getState().dragIndicator.visible).toBe(false);
    await waitFor(() => expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-03-01', end_date: '2026-03-06' }));
    await waitFor(() => expect(useUIStore.getState().isResizing).toBe(false));
    expect(document.body.style.cursor).toBe('');
    const phase = useAppStore.getState().projects[0].phases[0];
    expect(phase.start_date).toBe('2026-03-01');
    // the project grows to hold its phases
    expect(useAppStore.getState().projects[0].start_date).toBe('2026-03-01');
    expect(useUndoStore.getState().canUndo).toBe(true);
  });

  it('drags the right edge of a subphase', async () => {
    marchCells();
    const bar = makeBar({ subphaseId: '20' }, 30, 90); // Mar 2 .. Mar 4
    const { result } = renderHook(() => useResize());
    act(() => result.current.startSubphaseResize(mouseDown(bar, 120), 20, 1, 'right', '2026-03-02', '2026-03-04', bar));
    move(180);
    expect(useUIStore.getState().dragIndicator).toMatchObject({ date: '2026-03-06', duration: 5, edge: 'right' });
    up();
    await waitFor(() =>
      expect(updateSubphase).toHaveBeenCalledWith(20, { start_date: '2026-03-02', end_date: '2026-03-06' })
    );
    expect(useAppStore.getState().projects[0].phases[0].children[0].end_date).toBe('2026-03-06');
  });

  it('never shrinks a bar below one cell', () => {
    marchCells();
    const bar = makeBar({ phaseId: '10' }, 30, 150);
    const { result } = renderHook(() => useResize());
    act(() => result.current.startPhaseResize(mouseDown(bar, 180), 10, 1, 'right', '2026-03-02', '2026-03-06', bar));
    move(0);
    expect(bar.style.width).toBe('150px');
    act(() => result.current.startPhaseResize(mouseDown(bar, 30), 10, 1, 'left', '2026-03-02', '2026-03-06', bar));
    move(400);
    expect(bar.style.left).toBe('30px');
  });

  it('ignores a resize that did not change the bar', async () => {
    marchCells();
    const bar = makeBar({ phaseId: '10' }, 30, 150);
    const { result } = renderHook(() => useResize());
    act(() => result.current.startPhaseResize(mouseDown(bar, 180), 10, 1, 'right', '2026-03-02', '2026-03-06', bar));
    move(185);
    up();
    await waitFor(() => expect(useUIStore.getState().isResizing).toBe(false));
    expect(bar.style.width).toBe('150px');
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('uses the proportional inverse in quarter view', async () => {
    useViewStore.setState({ viewMode: 'quarter', cellWidth: 70 });
    const header = document.createElement('div');
    for (let i = 0; i < 8; i++) {
      const cell = document.createElement('div');
      const start = new Date(2026, 0, 5 + i * 7);
      const end = new Date(2026, 0, 11 + i * 7);
      const f = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      cell.setAttribute('data-date', f(start));
      cell.setAttribute('data-date-end', f(end));
      header.appendChild(cell);
    }
    document.body.appendChild(header);
    useAppStore.setState({
      projects: [
        makeProject({
          id: 1,
          start_date: '2026-01-05',
          end_date: '2026-03-01',
          phases: [makePhase({ id: 10, start_date: '2026-01-05', end_date: '2026-01-09' })],
        }),
      ],
    });
    const bar = makeBar({ phaseId: '10' }, 0, 50);
    const { result } = renderHook(() => useResize());
    act(() => result.current.startPhaseResize(mouseDown(bar, 50), 10, 1, 'right', '2026-01-05', '2026-01-09', bar));
    move(85); // right edge at 85px of 560px over 56 days = day 8.5 -> Jan 13, minus one
    up();
    await waitFor(() =>
      expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-01-05', end_date: '2026-01-12' })
    );
  });
});

describe('useResize: no header cells', () => {
  it.each([
    ['month', 30, 60, '2026-03-08'],
    ['quarter', 30, 30, '2026-03-13'],
    ['year', 30, 30, '2026-04-05'],
  ] as const)('%s view: steps by the cell unit', async (viewMode, cellWidth, dx, expectedEnd) => {
    useViewStore.setState({ viewMode, cellWidth });
    const bar = makeBar({ phaseId: '10' }, 30, 150);
    const { result } = renderHook(() => useResize());
    act(() => result.current.startPhaseResize(mouseDown(bar, 180), 10, 1, 'right', '2026-03-02', '2026-03-06', bar));
    move(180 + dx);
    up();
    await waitFor(() =>
      expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-03-02', end_date: expectedEnd })
    );
  });

  it('moves the start with the left edge', async () => {
    const bar = makeBar({ phaseId: '10' }, 60, 150);
    const { result } = renderHook(() => useResize());
    act(() => result.current.startPhaseResize(mouseDown(bar, 60), 10, 1, 'left', '2026-03-02', '2026-03-06', bar));
    move(0);
    up();
    await waitFor(() =>
      expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-02-28', end_date: '2026-03-06' })
    );
  });
});

describe('useResize: bookings', () => {
  it('resizes a staff booking and sends its allocation', async () => {
    marchCells();
    const bar = makeBar({ assignmentId: '50' }, 30, 150);
    const { result } = renderHook(() => useResize());
    act(() =>
      result.current.startStaffAssignmentResize(mouseDown(bar, 180), 50, 1, 'right', '2026-03-02', '2026-03-06', bar, 4)
    );
    expect(useUIStore.getState().resizeItemType).toBe('staffAssignment');
    move(240);
    up();
    await waitFor(() =>
      expect(updateStaffAssignment).toHaveBeenCalledWith(50, {
        start_date: '2026-03-02',
        end_date: '2026-03-08',
        allocation: 40,
      })
    );
    expect(useAppStore.getState().projects[0].staffAssignments[0].end_date).toBe('2026-03-08');
  });

  it('brings the server state back when the own resize was sent for approval (202)', async () => {
    marchCells();
    useAppStore.setState({
      currentUser: makeUser({
        id: 4,
        role: 'user',
        permissions: USER_DEFAULTS.filter((k) => k !== 'assignments.self_update'),
        approval_required: ['assignments.self_update'],
      }),
    });
    const server = buildProject();
    vi.mocked(updateStaffAssignment).mockResolvedValueOnce({ success: true, pending: true, request_id: 31, id: 50 });
    vi.mocked(loadAllProjects).mockResolvedValueOnce([server]);
    const bar = makeBar({ assignmentId: '50' }, 30, 150);
    const { result } = renderHook(() => useResize());
    act(() =>
      result.current.startStaffAssignmentResize(mouseDown(bar, 180), 50, 1, 'right', '2026-03-02', '2026-03-06', bar, 4)
    );
    move(240);
    up();
    await waitFor(() => expect(useUIStore.getState().flashNotice?.message).toBe('Sent for approval'));
    expect(useAppStore.getState().projects).toEqual([server]);
    expect(useAppStore.getState().projects[0].staffAssignments[0].end_date).toBe('2026-03-06');
    expect(useUndoStore.getState().undoStack).toEqual([]);
    await waitFor(() => expect(useUIStore.getState().isResizing).toBe(false));
  });

  it('resizes an equipment booking from the left', async () => {
    marchCells();
    const bar = makeBar({ assignmentId: '60' }, 30, 90);
    const { result } = renderHook(() => useResize());
    act(() =>
      result.current.startEquipmentAssignmentResize(mouseDown(bar, 30), 60, 1, 'left', '2026-03-02', '2026-03-04', bar)
    );
    move(60);
    up();
    await waitFor(() =>
      expect(updateEquipmentAssignment).toHaveBeenCalledWith(60, { start_date: '2026-03-03', end_date: '2026-03-04' })
    );
  });

  it('finds the booking bar from the handle and gives up without one', () => {
    const bar = makeBar({ assignmentId: '50' }, 30, 150);
    const handle = document.createElement('span');
    bar.appendChild(handle);
    const { result } = renderHook(() => useResize());
    act(() =>
      result.current.startStaffAssignmentResize(mouseDown(handle, 0), 50, 1, 'right', '2026-03-02', '2026-03-06')
    );
    expect(bar.classList.contains('resizing')).toBe(true);
    act(() => up());

    const loose = document.createElement('span');
    document.body.appendChild(loose);
    act(() => {
      result.current.startStaffAssignmentResize(mouseDown(loose, 0), 50, 1, 'right', '2026-03-02', '2026-03-06');
      result.current.startEquipmentAssignmentResize(mouseDown(loose, 0), 60, 1, 'right', '2026-03-02', '2026-03-04');
    });
    expect(useUIStore.getState().isResizing).toBe(false);
  });
});

describe('useResize: guards and failures', () => {
  it('resizes an equipment booking with equipment_bookings.manage, not with projects.edit_any', () => {
    const bar = makeBar({ phaseId: '10' }, 30, 150);
    useAppStore.setState({ currentUser: makeUser({ id: 31, role: 'editor', permissions: ['projects.view', 'projects.edit_any'] }) });
    const { result, rerender } = renderHook(() => useResize());
    act(() => result.current.startEquipmentAssignmentResize(mouseDown(bar, 0), 60, 1, 'left', '2026-03-02', '2026-03-04', bar));
    expect(useUIStore.getState().isResizing).toBe(false);

    act(() => useAppStore.setState({ currentUser: makeUser({ id: 30, role: 'booker', permissions: ['projects.view', 'equipment_bookings.manage'] }) }));
    rerender();
    act(() => result.current.startEquipmentAssignmentResize(mouseDown(bar, 0), 60, 1, 'left', '2026-03-02', '2026-03-04', bar));
    expect(useUIStore.getState().isResizing).toBe(true);
  });

  it('does not start without edit rights or in the read-only views', () => {
    const bar = makeBar({ phaseId: '10' }, 30, 150);
    const { result } = renderHook(() => useResize());
    const startAll = () =>
      act(() => {
        result.current.startPhaseResize(mouseDown(bar, 0), 10, 1, 'left', '2026-03-02', '2026-03-06', bar);
        result.current.startSubphaseResize(mouseDown(bar, 0), 20, 1, 'left', '2026-03-02', '2026-03-04', bar);
        result.current.startStaffAssignmentResize(mouseDown(bar, 0), 50, 1, 'left', '2026-03-02', '2026-03-06', bar, 4);
        result.current.startEquipmentAssignmentResize(mouseDown(bar, 0), 60, 1, 'left', '2026-03-02', '2026-03-04', bar);
      });

    act(() => useViewStore.setState({ currentView: 'staff' }));
    startAll();
    expect(useUIStore.getState().isResizing).toBe(false);

    act(() => useViewStore.setState({ currentView: 'equipment' }));
    startAll();
    expect(useUIStore.getState().isResizing).toBe(false);

    act(() => {
      useViewStore.setState({ currentView: 'gantt' });
      useAppStore.setState({ currentUser: makeUser({ id: 9, role: 'user' }) });
    });
    startAll();
    expect(useUIStore.getState().isResizing).toBe(false);
  });

  it('ends the resize when the project vanished mid-gesture', async () => {
    marchCells();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bar = makeBar({ phaseId: '10' }, 30, 150);
    const { result, rerender } = renderHook(() => useResize());
    act(() => result.current.startPhaseResize(mouseDown(bar, 180), 10, 1, 'right', '2026-03-02', '2026-03-06', bar));
    act(() => useAppStore.setState({ projects: [] }));
    rerender();
    move(240);
    up();
    await waitFor(() => expect(useUIStore.getState().isResizing).toBe(false));
    expect(err).toHaveBeenCalledWith('Project not found:', 1);
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('reloads and clears the undo history when the save fails', async () => {
    marchCells();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = buildProject();
    vi.mocked(updatePhase).mockRejectedValueOnce(new Error('500'));
    vi.mocked(loadAllProjects).mockResolvedValueOnce([server]);
    const bar = makeBar({ phaseId: '10' }, 30, 150);
    const { result } = renderHook(() => useResize());
    act(() => result.current.startPhaseResize(mouseDown(bar, 180), 10, 1, 'right', '2026-03-02', '2026-03-06', bar));
    move(240);
    up();
    await waitFor(() => expect(loadAllProjects).toHaveBeenCalled());
    await waitFor(() => expect(useUIStore.getState().isResizing).toBe(false));
    expect(useAppStore.getState().projects).toEqual([server]);
    expect(useUndoStore.getState().undoStack).toEqual([]);
  });

  it('abandons the resize cleanly on unmount', () => {
    const bar = makeBar({ phaseId: '10' }, 30, 150);
    const { result, unmount } = renderHook(() => useResize());
    act(() => result.current.startPhaseResize(mouseDown(bar, 180), 10, 1, 'right', '2026-03-02', '2026-03-06', bar));
    unmount();
    expect(useUIStore.getState().isResizing).toBe(false);
    expect(document.body.style.cursor).toBe('');
    expect(bar.classList.contains('resizing')).toBe(false);
    move(260);
    up();
    expect(updatePhase).not.toHaveBeenCalled();
  });
});

describe('useResize: touch', () => {
  it('resizes the right edge with the finger and persists the end date', async () => {
    marchCells();
    const bar = makeBar({ phaseId: '10' }, 30, 150); // Mar 2 .. Mar 6
    const { result } = renderHook(() => useResize());

    act(() => result.current.startPhaseResize(mouseDown(bar, 180), 10, 1, 'right', '2026-03-02', '2026-03-06', bar));
    const moveEvent = touchMove(240); // +60px = +2 days
    expect(moveEvent.defaultPrevented).toBe(true);
    expect(bar.style.width).toBe('210px');

    const endEvent = touchEnd();
    expect(endEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-03-02', end_date: '2026-03-08' }));
    await waitFor(() => expect(useUIStore.getState().isResizing).toBe(false));
    expect(document.body.style.cursor).toBe('');
  });

  it('restores the bar without saving on touchcancel', async () => {
    marchCells();
    const bar = makeBar({ assignmentId: '50' }, 30, 150);
    const { result } = renderHook(() => useResize());

    act(() =>
      result.current.startStaffAssignmentResize(mouseDown(bar, 30), 50, 1, 'left', '2026-03-02', '2026-03-06', bar, 4)
    );
    touchMove(-30); // -2 days on the left edge
    expect(bar.style.left).toBe('-30px');
    expect(bar.style.width).toBe('210px');
    expect(useUIStore.getState().dragIndicator.visible).toBe(true);

    touchCancel();
    expect(bar.style.left).toBe('30px');
    expect(bar.style.width).toBe('150px');
    expect(bar.classList.contains('resizing')).toBe(false);
    expect(document.body.style.cursor).toBe('');
    expect(useUIStore.getState().isResizing).toBe(false);
    expect(useUIStore.getState().dragIndicator.visible).toBe(false);

    // The gesture is over: later touches change nothing and save nothing
    touchMove(-60);
    touchEnd();
    expect(bar.style.width).toBe('150px');
    await Promise.resolve();
    expect(updateStaffAssignment).not.toHaveBeenCalled();
  });
});
