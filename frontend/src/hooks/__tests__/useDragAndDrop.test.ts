/**
 * Gantt bar dragging beyond the phase path covered in useDragAndResize.test:
 * whole-project moves (confirmed / declined), subphases with nested children,
 * staff and equipment bookings, the dependency lag indicator, the guards
 * (rights, read-only views, resize handles) and the optimistic-write failure
 * protocol (reload + undo history cleared).
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

import { useDragAndDrop } from '../useDragAndDrop';
import { resetAllStores, useAppStore, useUIStore, useUndoStore, useViewStore } from '@/stores';
import {
  updatePhase,
  updateSubphase,
  updateProject,
  updateStaffAssignment,
  updateEquipmentAssignment,
  loadAllProjects,
} from '@/api/endpoints/projects';
import { makePhase, makeProject, makeSubphase, makeUser } from '@/test/factories';
import type { Project } from '@/types';
import { stubConfirm } from '@/test/confirmDialog';
import { setConfirmHandler } from '@/utils/confirmDialog';

function buildProject(): Project {
  return makeProject({
    id: 1,
    pm_id: 7,
    start_date: '2026-03-02',
    end_date: '2026-03-20',
    phases: [
      makePhase({
        id: 10,
        name: 'Design',
        start_date: '2026-03-02',
        end_date: '2026-03-06',
        children: [
          makeSubphase({
            id: 20,
            start_date: '2026-03-02',
            end_date: '2026-03-04',
            children: [makeSubphase({ id: 21, start_date: '2026-03-03', end_date: '2026-03-04' })],
          }),
        ],
        staffAssignments: [{ id: 70, staff_id: 4, allocation: 50, start_date: '2026-03-02', end_date: '2026-03-06' }],
      }),
      makePhase({
        id: 11,
        name: 'Build',
        start_date: '2026-03-09',
        end_date: '2026-03-13',
        dependencies: [{ id: 10, type: 'FS', lag: 0 }],
        children: [
          makeSubphase({
            id: 30,
            parent_phase_id: 11,
            start_date: '2026-03-09',
            end_date: '2026-03-10',
            dependencies: [{ id: 20, type: 'SS', lag: 0, entity: 'subphase' }],
          }),
        ],
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

/** A bar inside a timeline row (the lag indicator is positioned on the row). */
function makeBar(dataset: Record<string, string>, leftPx: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'timeline-row';
  const bar = document.createElement('div');
  Object.assign(bar.dataset, dataset);
  bar.style.left = `${leftPx}px`;
  row.appendChild(bar);
  document.body.appendChild(row);
  return bar;
}

function mouseDown(el: HTMLElement, clientX: number, target: HTMLElement = el): React.MouseEvent {
  return {
    clientX,
    target,
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
/** Touch gestures on the document, as the browser delivers them mid-drag. */
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
const phaseOf = (id: number) =>
  useAppStore.getState().projects[0].phases.find((p) => p.id === id)!;

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  useAppStore.setState({ currentUser: makeUser({ id: 1, role: 'admin' }), projects: [buildProject()] });
  useViewStore.setState({ viewMode: 'month', cellWidth: 30, currentView: 'gantt' });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('useDragAndDrop: whole project', () => {
  it('moves every phase, subphase and booking after confirmation', async () => {
    marchCells();
    const confirm = stubConfirm(true);
    const bar = makeBar({ projectId: '1' }, 30);
    const { result } = renderHook(() => useDragAndDrop());

    act(() => result.current.startProjectDrag(mouseDown(bar, 100), 1, '2026-03-02', '2026-03-20', bar));
    expect(useUIStore.getState().dragType).toBe('project');
    expect(bar.classList.contains('dragging')).toBe(true);
    move(160); // +2 days
    up();

    await waitFor(() => expect(updateProject).toHaveBeenCalledWith(1, { start_date: '2026-03-04', end_date: '2026-03-22' }));
    expect(confirm).toHaveBeenCalledWith({
      title: 'Move project',
      message:
        'Move project by +2 days?\n\nThis will move all 2 phase(s), their subphases, and all staff/equipment assignments.',
      confirmLabel: 'Move',
    });
    await waitFor(() => expect(useUIStore.getState().isDragging).toBe(false));

    expect([phaseOf(10).start_date, phaseOf(10).end_date]).toEqual(['2026-03-04', '2026-03-08']);
    expect(phaseOf(10).children[0].children[0].start_date).toBe('2026-03-05');
    // Project-level bookings move on their own route; a phase row follows its
    // phase (no dates of its own) and is never PUT on the project route.
    expect(useAppStore.getState().projects[0].staffAssignments[0].start_date).toBe('2026-03-04');
    expect(updateStaffAssignment).toHaveBeenCalledWith(
      50,
      { start_date: '2026-03-04', end_date: '2026-03-08', allocation: 40 },
      'project'
    );
    expect(updateStaffAssignment).not.toHaveBeenCalledWith(70, expect.anything(), expect.anything());
    expect(phaseOf(10).staffAssignments[0].start_date).toBe('2026-03-02');
    expect(updatePhase).toHaveBeenCalledWith(11, expect.objectContaining({ start_date: '2026-03-11' }));
    expect(updateSubphase).toHaveBeenCalledWith(21, expect.objectContaining({ start_date: '2026-03-05' }));
    expect(useUndoStore.getState().canUndo).toBe(true);
  });

  it('puts the bar back when the move is declined', async () => {
    marchCells();
    const confirm = stubConfirm(false);
    const bar = makeBar({ projectId: '1' }, 30);
    const { result } = renderHook(() => useDragAndDrop());

    act(() => result.current.startProjectDrag(mouseDown(bar, 100), 1, '2026-03-02', '2026-03-20', bar));
    move(190);
    up();

    await waitFor(() => expect(useUIStore.getState().isDragging).toBe(false));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(bar.style.left).toBe('30px');
    expect(bar.classList.contains('dragging')).toBe(false);
    expect(updateProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().projects[0].start_date).toBe('2026-03-02');
    expect(useUndoStore.getState().canUndo).toBe(false);
  });

  it('holds the bar at the drop while the dialog is open, ignoring the pointer, then snaps back on cancel', async () => {
    marchCells();
    let answer!: (ok: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    setConfirmHandler(confirm);
    const bar = makeBar({ projectId: '1' }, 30);
    const { result } = renderHook(() => useDragAndDrop());

    act(() => result.current.startProjectDrag(mouseDown(bar, 100), 1, '2026-03-02', '2026-03-20', bar));
    move(160);
    up();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));

    // Dialog open: the bar stays where it was dropped and the document
    // listeners are already gone, so pointer movement does not reach it.
    expect(bar.style.left).toBe('90px');
    move(300);
    touchMove(300);
    expect(bar.style.left).toBe('90px');
    expect(updateProject).not.toHaveBeenCalled();

    await act(async () => answer(false));
    await waitFor(() => expect(useUIStore.getState().isDragging).toBe(false));
    expect(bar.style.left).toBe('30px');
    expect(updateProject).not.toHaveBeenCalled();
    expect(useAppStore.getState().projects[0].start_date).toBe('2026-03-02');
  });
});

describe('useDragAndDrop: subphases and bookings', () => {
  it('moves a subphase with its nested children', async () => {
    marchCells();
    const bar = makeBar({ subphaseId: '20' }, 30);
    const { result } = renderHook(() => useDragAndDrop());

    act(() => result.current.startSubphaseDrag(mouseDown(bar, 0), 20, 1, 10, '2026-03-02', '2026-03-04', false, bar));
    move(30); // +1 day
    up();

    await waitFor(() => expect(updateSubphase).toHaveBeenCalledWith(20, { start_date: '2026-03-03', end_date: '2026-03-05' }));
    expect(updateSubphase).toHaveBeenCalledWith(21, expect.objectContaining({ start_date: '2026-03-04', end_date: '2026-03-05' }));
    const moved = phaseOf(10).children[0];
    expect([moved.start_date, moved.end_date]).toEqual(['2026-03-03', '2026-03-05']);
  });

  it('keeps a milestone on a single day', async () => {
    marchCells();
    const bar = makeBar({ phaseId: '10' }, 30);
    const { result } = renderHook(() => useDragAndDrop());
    act(() => result.current.startPhaseDrag(mouseDown(bar, 0), 10, 1, '2026-03-02', '2026-03-02', true, bar));
    move(90);
    up();
    await waitFor(() => expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-03-05', end_date: '2026-03-05' }));
  });

  it('moves a project staff booking and sends its allocation', async () => {
    marchCells();
    const bar = makeBar({ assignmentId: '50' }, 30);
    const { result } = renderHook(() => useDragAndDrop());
    act(() => result.current.startStaffAssignmentDrag(mouseDown(bar, 0), 50, 1, '2026-03-02', '2026-03-06', bar, 4));
    expect(useUIStore.getState().dragType).toBe('staffAssignment');
    move(60);
    up();
    await waitFor(() =>
      expect(updateStaffAssignment).toHaveBeenCalledWith(50, { start_date: '2026-03-04', end_date: '2026-03-08', allocation: 40 })
    );
    expect(useAppStore.getState().projects[0].staffAssignments[0].start_date).toBe('2026-03-04');
  });

  it('moves an equipment booking', async () => {
    marchCells();
    const bar = makeBar({ assignmentId: '60' }, 30);
    const { result } = renderHook(() => useDragAndDrop());
    act(() => result.current.startEquipmentAssignmentDrag(mouseDown(bar, 0), 60, 1, '2026-03-02', '2026-03-04', bar));
    move(-30);
    up();
    await waitFor(() =>
      expect(updateEquipmentAssignment).toHaveBeenCalledWith(60, { start_date: '2026-03-01', end_date: '2026-03-03' })
    );
  });

  it('falls back to whole-day steps when the header cells are not rendered', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bar = makeBar({ phaseId: '10' }, 30);
    const { result } = renderHook(() => useDragAndDrop());
    act(() => result.current.startPhaseDrag(mouseDown(bar, 0), 10, 1, '2026-03-02', '2026-03-06', false, bar));
    move(90); // 3 cells
    up();
    await waitFor(() => expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-03-05', end_date: '2026-03-09' }));
  });

  it('ignores a tiny movement', async () => {
    marchCells();
    const bar = makeBar({ phaseId: '10' }, 30);
    const { result } = renderHook(() => useDragAndDrop());
    act(() => result.current.startPhaseDrag(mouseDown(bar, 0), 10, 1, '2026-03-02', '2026-03-06', false, bar));
    move(10); // snaps back to the same cell
    up();
    await waitFor(() => expect(useUIStore.getState().isDragging).toBe(false));
    expect(bar.style.opacity).toBe('1');
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('ends the drag when the project vanished mid-gesture', async () => {
    marchCells();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bar = makeBar({ phaseId: '10' }, 30);
    const { result, rerender } = renderHook(() => useDragAndDrop());
    act(() => result.current.startPhaseDrag(mouseDown(bar, 0), 10, 1, '2026-03-02', '2026-03-06', false, bar));
    act(() => useAppStore.setState({ projects: [makeProject({ id: 99, pm_id: null })] }));
    rerender();
    move(60);
    up();
    await waitFor(() => expect(useUIStore.getState().isDragging).toBe(false));
    expect(err).toHaveBeenCalledWith('Project not found:', 1);
    expect(updatePhase).not.toHaveBeenCalled();
  });
});

describe('useDragAndDrop: lag indicator', () => {
  it('shows the FS lag of a phase while dragging and hides it on drop', async () => {
    marchCells();
    const bar = makeBar({ phaseId: '11' }, 240); // Mar 9
    const { result } = renderHook(() => useDragAndDrop());
    act(() => result.current.startPhaseDrag(mouseDown(bar, 0), 11, 1, '2026-03-09', '2026-03-13', false, bar));

    move(-60); // Mar 7: Design ends Mar 6 -> lag 0
    expect(useUIStore.getState().dragIndicator).toMatchObject({ visible: true, type: 'drag', lagDays: 0 });
    move(30); // Mar 10 -> 3 days of slack
    expect(useUIStore.getState().dragIndicator.lagDays).toBe(3);
    expect(bar.style.opacity).toBe('0.8');

    up();
    expect(useUIStore.getState().dragIndicator.visible).toBe(false);
    await waitFor(() => expect(updatePhase).toHaveBeenCalled());
  });

  it('measures SS, FF and SF lags for subphases', () => {
    marchCells();
    const project = buildProject();
    const sub = project.phases[1].children[0];
    useAppStore.setState({ projects: [project] });
    const bar = makeBar({ subphaseId: '30' }, 240);
    const { result } = renderHook(() => useDragAndDrop());

    act(() => result.current.startSubphaseDrag(mouseDown(bar, 0), 30, 1, 11, '2026-03-09', '2026-03-10', false, bar));
    move(0); // SS: Mar 9 vs Screening start Mar 2
    expect(useUIStore.getState().dragIndicator.lagDays).toBe(7);
    act(() => up());

    sub.dependencies = [{ id: 20, type: 'FF', lag: 0, entity: 'subphase' }];
    act(() => useAppStore.setState({ projects: [structuredClone(project)] }));
    act(() => result.current.startSubphaseDrag(mouseDown(bar, 0), 30, 1, 11, '2026-03-09', '2026-03-10', false, bar));
    move(0); // FF: ends Mar 10 vs Mar 4
    expect(useUIStore.getState().dragIndicator.lagDays).toBe(6);
    act(() => up());

    sub.dependencies = [{ id: 20, type: 'SF', lag: 0, entity: 'subphase' }];
    act(() => useAppStore.setState({ projects: [structuredClone(project)] }));
    act(() => result.current.startSubphaseDrag(mouseDown(bar, 0), 30, 1, 11, '2026-03-09', '2026-03-10', false, bar));
    move(0); // SF: ends Mar 10 vs start Mar 2
    expect(useUIStore.getState().dragIndicator.lagDays).toBe(8);
    act(() => up());
  });

  it('hides the indicator for an item without dependencies', () => {
    marchCells();
    useUIStore.getState().showDragIndicator(1, 1, 5);
    const bar = makeBar({ phaseId: '10' }, 30);
    const { result } = renderHook(() => useDragAndDrop());
    act(() => result.current.startPhaseDrag(mouseDown(bar, 0), 10, 1, '2026-03-02', '2026-03-06', false, bar));
    move(30);
    expect(useUIStore.getState().dragIndicator.visible).toBe(false);
    act(() => up());
  });
});

describe('useDragAndDrop: guards', () => {
  it('does not start for a user who cannot edit the project', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 3, role: 'user' }) });
    const bar = makeBar({ phaseId: '10' }, 30);
    const { result } = renderHook(() => useDragAndDrop());
    act(() => result.current.startPhaseDrag(mouseDown(bar, 0), 10, 1, '2026-03-02', '2026-03-06', false, bar));
    act(() => result.current.startProjectDrag(mouseDown(bar, 0), 1, '2026-03-02', '2026-03-20', bar));
    act(() => result.current.startEquipmentAssignmentDrag(mouseDown(bar, 0), 60, 1, '2026-03-02', '2026-03-04', bar));
    expect(useUIStore.getState().isDragging).toBe(false);
  });

  it('lets people move their own staff booking', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user' }) });
    const bar = makeBar({ assignmentId: '50' }, 30);
    const { result } = renderHook(() => useDragAndDrop());
    act(() => result.current.startStaffAssignmentDrag(mouseDown(bar, 0), 50, 1, '2026-03-02', '2026-03-06', bar, 4));
    expect(useUIStore.getState().isDragging).toBe(true);
    act(() => up());
  });

  it.each(['staff', 'equipment'] as const)('is disabled in the %s view', (view) => {
    useViewStore.setState({ currentView: view });
    const bar = makeBar({ phaseId: '10', subphaseId: '20', projectId: '1', assignmentId: '50' }, 30);
    const { result } = renderHook(() => useDragAndDrop());
    act(() => {
      result.current.startPhaseDrag(mouseDown(bar, 0), 10, 1, '2026-03-02', '2026-03-06', false, bar);
      result.current.startSubphaseDrag(mouseDown(bar, 0), 20, 1, 10, '2026-03-02', '2026-03-04', false, bar);
      result.current.startProjectDrag(mouseDown(bar, 0), 1, '2026-03-02', '2026-03-20', bar);
      result.current.startStaffAssignmentDrag(mouseDown(bar, 0), 50, 1, '2026-03-02', '2026-03-06', bar, 4);
      result.current.startEquipmentAssignmentDrag(mouseDown(bar, 0), 60, 1, '2026-03-02', '2026-03-04', bar);
    });
    expect(useUIStore.getState().isDragging).toBe(false);
  });

  it('moves an equipment booking with equipment_bookings.manage, not with projects.edit_any', async () => {
    marchCells();
    useAppStore.setState({ currentUser: makeUser({ id: 31, role: 'editor', permissions: ['projects.view', 'projects.edit_any'] }) });
    const bar = makeBar({ assignmentId: '60' }, 30);
    const { result, rerender } = renderHook(() => useDragAndDrop());
    act(() => result.current.startEquipmentAssignmentDrag(mouseDown(bar, 0), 60, 1, '2026-03-02', '2026-03-04', bar));
    expect(useUIStore.getState().isDragging).toBe(false);

    act(() => useAppStore.setState({ currentUser: makeUser({ id: 30, role: 'booker', permissions: ['projects.view', 'equipment_bookings.manage'] }) }));
    rerender();
    act(() => result.current.startEquipmentAssignmentDrag(mouseDown(bar, 0), 60, 1, '2026-03-02', '2026-03-04', bar));
    move(-30);
    up();
    await waitFor(() =>
      expect(updateEquipmentAssignment).toHaveBeenCalledWith(60, { start_date: '2026-03-01', end_date: '2026-03-03' })
    );
  });

  it('leaves a press on a resize handle to the resize hook', () => {
    const bar = makeBar({ phaseId: '10' }, 30);
    const handle = document.createElement('span');
    handle.className = 'resize-handle';
    bar.appendChild(handle);
    const { result } = renderHook(() => useDragAndDrop());
    act(() => {
      result.current.startPhaseDrag(mouseDown(bar, 0, handle), 10, 1, '2026-03-02', '2026-03-06', false, bar);
      result.current.startSubphaseDrag(mouseDown(bar, 0, handle), 20, 1, 10, '2026-03-02', '2026-03-04', false, bar);
      result.current.startProjectDrag(mouseDown(bar, 0, handle), 1, '2026-03-02', '2026-03-20', bar);
      result.current.startStaffAssignmentDrag(mouseDown(bar, 0, handle), 50, 1, '2026-03-02', '2026-03-06', bar, 4);
      result.current.startEquipmentAssignmentDrag(mouseDown(bar, 0, handle), 60, 1, '2026-03-02', '2026-03-04', bar);
    });
    expect(useUIStore.getState().isDragging).toBe(false);
  });

  it('finds the bar from an inner element, and refuses when there is none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bar = makeBar({ phaseId: '10' }, 30);
    const label = document.createElement('span');
    bar.appendChild(label);
    const { result } = renderHook(() => useDragAndDrop());

    act(() => result.current.startPhaseDrag(mouseDown(label, 0), 10, 1, '2026-03-02', '2026-03-06'));
    expect(useUIStore.getState().dragItemId).toBe(10);
    expect(bar.classList.contains('dragging')).toBe(true);
    act(() => up());

    const loose = document.createElement('span');
    document.body.appendChild(loose);
    act(() => {
      result.current.startPhaseDrag(mouseDown(loose, 0), 10, 1, '2026-03-02', '2026-03-06');
      result.current.startSubphaseDrag(mouseDown(loose, 0), 20, 1, 10, '2026-03-02', '2026-03-04');
      result.current.startProjectDrag(mouseDown(loose, 0), 1, '2026-03-02', '2026-03-20');
      result.current.startStaffAssignmentDrag(mouseDown(loose, 0), 50, 1, '2026-03-02', '2026-03-06');
      result.current.startEquipmentAssignmentDrag(mouseDown(loose, 0), 60, 1, '2026-03-02', '2026-03-04');
    });
    expect(useUIStore.getState().isDragging).toBe(false);
    expect(warn).toHaveBeenCalledTimes(5);
  });
});

describe('useDragAndDrop: persist failure', () => {
  it('reloads the projects from the server and clears the undo history', async () => {
    marchCells();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const serverCopy = buildProject();
    vi.mocked(updatePhase).mockRejectedValueOnce(new Error('500'));
    vi.mocked(loadAllProjects).mockResolvedValueOnce([serverCopy]);
    const bar = makeBar({ phaseId: '10' }, 30);
    const { result } = renderHook(() => useDragAndDrop());

    act(() => result.current.startPhaseDrag(mouseDown(bar, 0), 10, 1, '2026-03-02', '2026-03-06', false, bar));
    move(60);
    up();

    await waitFor(() => expect(loadAllProjects).toHaveBeenCalled());
    await waitFor(() => expect(useUIStore.getState().isDragging).toBe(false));
    expect(useAppStore.getState().projects).toEqual([serverCopy]);
    expect(useUndoStore.getState().undoStack).toEqual([]);
    expect(useUndoStore.getState().canUndo).toBe(false);
  });
});

describe('useDragAndDrop: touch', () => {
  it('moves the bar with the finger and persists on touchend', async () => {
    marchCells();
    const bar = makeBar({ phaseId: '10' }, 30);
    const { result } = renderHook(() => useDragAndDrop());

    act(() => result.current.startPhaseDrag(mouseDown(bar, 0), 10, 1, '2026-03-02', '2026-03-06', false, bar));
    const moveEvent = touchMove(60); // +2 days
    expect(moveEvent.defaultPrevented).toBe(true);
    expect(bar.style.left).toBe('90px');

    const endEvent = touchEnd();
    // No synthesized mousedown/click after a handled touch
    expect(endEvent.defaultPrevented).toBe(true);
    await waitFor(() => expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-03-04', end_date: '2026-03-08' }));
    await waitFor(() => expect(useUIStore.getState().isDragging).toBe(false));
  });

  it('detaches the touch listeners after touchend', async () => {
    marchCells();
    const remove = vi.spyOn(document, 'removeEventListener');
    const bar = makeBar({ assignmentId: '50' }, 30);
    const { result } = renderHook(() => useDragAndDrop());

    act(() => result.current.startStaffAssignmentDrag(mouseDown(bar, 0), 50, 1, '2026-03-02', '2026-03-06', bar, 4));
    touchMove(30);
    touchEnd();
    await waitFor(() => expect(updateStaffAssignment).toHaveBeenCalled());

    const removed = remove.mock.calls.map((c) => c[0]);
    expect(removed).toEqual(expect.arrayContaining(['mousemove', 'mouseup', 'touchmove', 'touchend', 'touchcancel']));
    // A later finger movement no longer reaches the bar
    const leftAfter = bar.style.left;
    const stray = touchMove(300);
    expect(bar.style.left).toBe(leftAfter);
    expect(stray.defaultPrevented).toBe(false);
  });

  it('puts the bar back without saving on touchcancel', async () => {
    marchCells();
    const bar = makeBar({ projectId: '1' }, 30);
    const confirm = stubConfirm(true);
    const { result } = renderHook(() => useDragAndDrop());

    act(() => result.current.startProjectDrag(mouseDown(bar, 100), 1, '2026-03-02', '2026-03-20', bar));
    touchMove(190);
    expect(bar.style.left).toBe('120px');
    expect(bar.style.opacity).toBe('0.8');

    touchCancel();
    expect(bar.style.left).toBe('30px');
    expect(bar.style.opacity).toBe('');
    expect(bar.style.zIndex).toBe('');
    expect(bar.classList.contains('dragging')).toBe(false);
    expect(useUIStore.getState().isDragging).toBe(false);
    expect(useUIStore.getState().dragIndicator.visible).toBe(false);

    touchMove(250);
    touchEnd();
    expect(bar.style.left).toBe('30px');
    await Promise.resolve();
    expect(confirm).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });
});
