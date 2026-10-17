/**
 * Touch on the project bar and the project-level assignment bars starts the
 * real drag / resize hooks (only PhaseBar had touch handlers before): the bars
 * arm the touch and, once the finger has moved past the threshold, hand a
 * mouse-like event to the hooks, which finish the gesture on the document
 * touchend. A jittery tap below the threshold starts nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ProjectTimeline } from '../ProjectTimeline';
import { generateTimelineCells } from '../../utils';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import type { Project, User } from '@/types';

vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ recentChanges: [] }),
}));

// The drag/resize hooks import the API layer; nothing here persists.
vi.mock('@/api/endpoints/projects', () => ({
  updatePhase: vi.fn(),
  updateSubphase: vi.fn(),
  updateProject: vi.fn(),
  updateStaffAssignment: vi.fn(),
  updateEquipmentAssignment: vi.fn(),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

function makeProject(): Project {
  return {
    id: 1,
    name: 'Project',
    site_id: 1,
    pm_id: null,
    confirmed: true,
    archived: false,
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    phases: [],
    staffAssignments: [
      { id: 50, staff_id: 4, staff_name: 'Ada', allocation: 40, start_date: '2026-09-07', end_date: '2026-09-11' },
    ],
    equipmentAssignments: [],
  } as unknown as Project;
}

function renderTimeline(project: Project) {
  useAppStore.setState({ projects: [project] });
  const cells = generateTimelineCells(new Date(2026, 8, 15), 'month', new Set(), []);
  return render(
    <ProjectTimeline
      project={project}
      cells={cells}
      cellWidth={30}
      isExpanded
      expandedPhases={new Set()}
      expandedSubphases={new Set()}
    />
  );
}

const touch = (x: number) => ({ touches: [{ clientX: x, clientY: 10 }] });

/** Touch down at `x`, then move the finger past the 5 px threshold. */
function touchAndMove(el: Element, x: number, dx = 20) {
  fireEvent.touchStart(el, touch(x));
  fireEvent.touchMove(document, touch(x + dx));
}

/** Touch down at `x`, wiggle 3 px, lift: a tap, not a gesture. */
function jitteryTap(el: Element, x: number) {
  fireEvent.touchStart(el, touch(x));
  fireEvent.touchMove(document, { touches: [{ clientX: x + 3, clientY: 12 }] });
  fireEvent.touchEnd(document, { changedTouches: [{ clientX: x + 3, clientY: 12 }] });
}

beforeEach(() => {
  useAppStore.setState({ currentUser: { id: 1, role: 'admin' } as unknown as User });
  useUIStore.setState({ isDragging: false, dragType: null, isResizing: false, resizeEdge: null });
  useViewStore.setState({ viewMode: 'month', currentView: 'gantt', showAssignments: true });
});

afterEach(() => {
  // Finish any gesture a failing test left open, then unmount.
  fireEvent.touchEnd(document);
  cleanup();
  document.body.style.cursor = '';
});

describe('ProjectTimeline touch', () => {
  it('drags a staff assignment bar with a finger', () => {
    const { container } = renderTimeline(makeProject());
    const bar = container.querySelector('[data-assignment-id="50"]') as HTMLElement;
    expect(bar).not.toBeNull();

    fireEvent.touchStart(bar, touch(200));
    expect(useUIStore.getState().isDragging).toBe(false);
    fireEvent.touchMove(document, touch(220));
    expect(useUIStore.getState().isDragging).toBe(true);
    expect(useUIStore.getState().dragType).toBe('staffAssignment');
    expect(bar.classList.contains('dragging')).toBe(true);

    fireEvent.touchEnd(document);
    expect(useUIStore.getState().isDragging).toBe(false);
  });

  it('resizes an assignment from its handle with a finger', () => {
    const { container } = renderTimeline(makeProject());
    const bar = container.querySelector('[data-assignment-id="50"]') as HTMLElement;
    const handles = bar.querySelectorAll('.resize-handle');
    expect(handles).toHaveLength(2);

    touchAndMove(handles[1], 340);
    expect(useUIStore.getState().isResizing).toBe(true);
    expect(useUIStore.getState().resizeEdge).toBe('right');
    // A handle touch is not also a bar drag
    expect(useUIStore.getState().isDragging).toBe(false);
    expect(document.body.style.cursor).toBe('ew-resize');
    expect(bar.classList.contains('resizing')).toBe(true);

    fireEvent.touchEnd(document);
    expect(document.body.style.cursor).toBe('');
    expect(bar.classList.contains('resizing')).toBe(false);
  });

  it('resizes from the left handle too', () => {
    const { container } = renderTimeline(makeProject());
    const handle = container.querySelector('[data-assignment-id="50"] .resize-handle') as HTMLElement;

    touchAndMove(handle, 180, -20);
    expect(useUIStore.getState().resizeEdge).toBe('left');
  });

  it('drags the project bar with a finger', () => {
    const { container } = renderTimeline(makeProject());
    const bar = container.querySelector('.gantt-bar[data-project-id="1"]') as HTMLElement;
    expect(bar).not.toBeNull();

    touchAndMove(bar, 100);
    expect(useUIStore.getState().dragType).toBe('project');
    expect(useUIStore.getState().dragItemId).toBe(1);

    fireEvent.touchEnd(document);
    expect(useUIStore.getState().isDragging).toBe(false);
  });

  it('leaves a read-only assignment bar alone', () => {
    useAppStore.setState({ currentUser: { id: 5, role: 'user' } as unknown as User });
    const { container } = renderTimeline(makeProject());
    const bar = container.querySelector('[data-assignment-id="50"]') as HTMLElement;

    expect(bar.querySelector('.resize-handle')).toBeNull();
    touchAndMove(bar, 200);
    expect(useUIStore.getState().isDragging).toBe(false);
  });

  it('a jittery tap does not drag an assignment bar', () => {
    const { container } = renderTimeline(makeProject());
    const bar = container.querySelector('[data-assignment-id="50"]') as HTMLElement;

    jitteryTap(bar, 200);
    expect(useUIStore.getState().isDragging).toBe(false);
    expect(bar.classList.contains('dragging')).toBe(false);
  });

  it('a jittery tap does not resize an assignment bar', () => {
    const { container } = renderTimeline(makeProject());
    const handles = container.querySelectorAll('[data-assignment-id="50"] .resize-handle');

    jitteryTap(handles[0], 180);
    jitteryTap(handles[1], 340);
    expect(useUIStore.getState().isResizing).toBe(false);
    expect(useUIStore.getState().isDragging).toBe(false);
    expect(document.body.style.cursor).toBe('');
  });

  it('a jittery tap does not drag the project bar (no move confirm)', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { container } = renderTimeline(makeProject());
    const bar = container.querySelector('.gantt-bar[data-project-id="1"]') as HTMLElement;

    jitteryTap(bar, 100);
    expect(useUIStore.getState().isDragging).toBe(false);
    expect(useUIStore.getState().dragType).toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('still drags and resizes an assignment bar with the mouse at once', () => {
    const { container } = renderTimeline(makeProject());
    const bar = container.querySelector('[data-assignment-id="50"]') as HTMLElement;

    fireEvent.mouseDown(bar, { clientX: 200, clientY: 10 });
    expect(useUIStore.getState().dragType).toBe('staffAssignment');
    fireEvent.mouseUp(document);
    expect(useUIStore.getState().isDragging).toBe(false);

    fireEvent.mouseDown(bar.querySelectorAll('.resize-handle')[1], { clientX: 340, clientY: 10 });
    expect(useUIStore.getState().resizeEdge).toBe('right');
    fireEvent.mouseUp(document);
  });
});
