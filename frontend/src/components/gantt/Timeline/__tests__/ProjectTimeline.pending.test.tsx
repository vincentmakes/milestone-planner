/**
 * Assignment bars of bookings awaiting approval: hatched and dashed, labelled
 * as pending, and never draggable or resizable — their dates are a request,
 * not a booking (even for the requester or an editor).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ProjectTimeline } from '../ProjectTimeline';
import { generateTimelineCells } from '../../utils';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { makeUser } from '@/test/factories';
import type { AssignmentApproval, Phase, Project, StaffAssignment } from '@/types';

vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ recentChanges: [] }),
}));

vi.mock('@/api/endpoints/projects', () => ({
  updatePhase: vi.fn(),
  updateSubphase: vi.fn(),
  updateProject: vi.fn(),
  updateStaffAssignment: vi.fn(),
  updateEquipmentAssignment: vi.fn(),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

const approval = (over: Partial<AssignmentApproval> = {}): AssignmentApproval => ({
  request_id: 31,
  action: 'assignments.self_create',
  requester_id: 4,
  requested: { allocation: 40 },
  previous: null,
  created_at: null,
  can_decide: false,
  ...over,
});

function row(id: number, over: Partial<StaffAssignment> = {}): StaffAssignment {
  return { id, staff_id: 4, staff_name: 'Ada', allocation: 40, start_date: '2026-09-07', end_date: '2026-09-11', ...over };
}

function makeProject(staff: StaffAssignment[], phaseStaff: StaffAssignment[] = []): Project {
  const phase = {
    id: 3,
    project_id: 1,
    name: 'Design',
    start_date: '2026-09-01',
    end_date: '2026-09-20',
    color: '#000',
    order_index: 0,
    children: [],
    dependencies: [],
    staffAssignments: phaseStaff,
    equipmentAssignments: [],
  } as unknown as Phase;
  return {
    id: 1,
    name: 'Project',
    site_id: 1,
    pm_id: null,
    confirmed: true,
    archived: false,
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    phases: [phase],
    staffAssignments: staff,
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
      expandedPhases={new Set([3])}
      expandedSubphases={new Set()}
    />
  );
}

const bar = (container: HTMLElement, id: number) =>
  container.querySelector(`[data-assignment-id="${id}"][data-assignment-type="staff"]`) as HTMLElement;

beforeEach(() => {
  // An admin: every bar would be interactive if it were not pending.
  useAppStore.setState({ currentUser: makeUser({ id: 1, role: 'admin' }) });
  useUIStore.setState({ isDragging: false, dragType: null, isResizing: false, resizeEdge: null });
  useViewStore.setState({ viewMode: 'month', currentView: 'gantt', showAssignments: true });
});

describe('ProjectTimeline pending assignment bars', () => {
  it('hatches a pending booking, labels it and makes it non-interactive', () => {
    const { container } = renderTimeline(makeProject([row(50, { approval_status: 'pending', approval: approval() })]));
    const el = bar(container, 50);
    expect(el.className).toMatch(/pendingBar/);
    expect(el.className).not.toMatch(/interactive/);
    expect(el.getAttribute('title')).toBe('Ada (40%) — pending approval');
    expect(el.querySelector('.resize-handle')).toBeNull();

    fireEvent.mouseDown(el, { clientX: 100 });
    expect(useUIStore.getState().isDragging).toBe(false);
  });

  it('freezes a bar whose change awaits approval and shows the requested allocation', () => {
    const { container } = renderTimeline(
      makeProject([
        row(51, { approval: approval({ action: 'assignments.self_update', requested: { allocation: 60 } }) }),
      ])
    );
    const el = bar(container, 51);
    expect(el.className).toMatch(/pendingBar/);
    expect(el.className).not.toMatch(/interactive/);
    expect(el.textContent).toBe('Ada (40% → 60%)');
    expect(el.getAttribute('title')).toBe('Ada (40% → 60%) — change pending approval');
  });

  it('labels a requested removal', () => {
    const { container } = renderTimeline(
      makeProject([row(52, { approval: approval({ action: 'assignments.self_remove', requested: null }) })])
    );
    expect(bar(container, 52).getAttribute('title')).toBe('Ada (40%) — removal pending approval');
  });

  it('hatches pending phase-level bookings too', () => {
    const { container } = renderTimeline(
      makeProject([], [row(60, { approval_status: 'pending', approval: approval() })])
    );
    expect(bar(container, 60).className).toMatch(/pendingBar/);
  });

  it('keeps approved bars interactive', () => {
    const { container } = renderTimeline(makeProject([row(53)]));
    const el = bar(container, 53);
    expect(el.className).toMatch(/interactive/);
    expect(el.className).not.toMatch(/pendingBar/);
  });
});
