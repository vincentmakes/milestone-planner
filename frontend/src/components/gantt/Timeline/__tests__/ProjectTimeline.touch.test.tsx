/**
 * Touch on the project bar and the project-level assignment bars starts the
 * real drag / resize hooks (only PhaseBar had touch handlers before): the bars
 * convert the touch into a mouse-like event, and the hooks finish the gesture
 * on the document touchend.
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

    fireEvent.touchStart(handles[1], touch(340));
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

    fireEvent.touchStart(handle, touch(180));
    expect(useUIStore.getState().resizeEdge).toBe('left');
  });

  it('drags the project bar with a finger', () => {
    const { container } = renderTimeline(makeProject());
    const bar = container.querySelector('.gantt-bar[data-project-id="1"]') as HTMLElement;
    expect(bar).not.toBeNull();

    fireEvent.touchStart(bar, touch(100));
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
    fireEvent.touchStart(bar, touch(200));
    expect(useUIStore.getState().isDragging).toBe(false);
  });
});
