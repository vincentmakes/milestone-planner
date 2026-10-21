/**
 * A single click on a phase or subphase bar opens its edit modal -- but only
 * for someone who may edit the project (admin, superuser, or its manager).
 * Anyone else would fill in the modal and then get a 403 on save, so for
 * them the click does nothing (the bar's title tooltip still shows).
 *
 * PhaseBar turns a mousedown + mouseup without movement into a click, so the
 * tests drive it with those two events.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { Profiler } from 'react';
import { ProjectTimeline } from '../ProjectTimeline';
import { generateTimelineCells } from '../../utils';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import type { Phase, Project, Site, Subphase, Tag, TagGroup, User } from '@/types';
import { makeUser } from '@/test/factories';

vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ recentChanges: [] }),
}));

// The drag/resize/link hooks import the API layer; nothing here persists.
vi.mock('@/api/endpoints/projects', () => ({
  updatePhase: vi.fn(),
  updateSubphase: vi.fn(),
  updateProject: vi.fn(),
  updateStaffAssignment: vi.fn(),
  updateEquipmentAssignment: vi.fn(),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

const PM = 7;

function makeSubphase(): Subphase {
  return {
    id: 2,
    project_id: 1,
    parent_phase_id: 1,
    parent_subphase_id: null,
    name: 'Prototype',
    start_date: '2026-09-08',
    end_date: '2026-09-15',
    color: '#10b981',
    order_index: 0,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies: [],
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
  };
}

function makeProject(pmId: number | null): Project {
  const phase = {
    id: 1,
    project_id: 1,
    name: 'Design',
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    color: '#3b82f6',
    order_index: 0,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies: [],
    children: [makeSubphase()],
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Phase;
  return {
    id: 1,
    name: 'Project',
    site_id: 1,
    pm_id: pmId,
    confirmed: true,
    archived: false,
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    phases: [phase],
    staffAssignments: [],
    equipmentAssignments: [],
  };
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
      expandedPhases={new Set([1])}
      expandedSubphases={new Set()}
    />
  );
}

function clickBar(container: HTMLElement, selector: string) {
  const bar = container.querySelector(selector);
  expect(bar).not.toBeNull();
  fireEvent.mouseDown(bar!, { clientX: 10, clientY: 10 });
  fireEvent.mouseUp(document);
}

function asUser(id: number, role: User['role']) {
  useAppStore.setState({ currentUser: makeUser({ id, role }) });
}

beforeEach(() => {
  useUIStore.setState({ activeModal: null, editingPhase: null, editingSubphase: null });
  useViewStore.setState({ viewMode: 'month', showAssignments: false });
});

describe('ProjectTimeline bar click', () => {
  it('opens the phase modal for the project manager', () => {
    asUser(PM, 'user');
    const { container } = renderTimeline(makeProject(PM));

    clickBar(container, '[data-phase-id="1"][data-project-id="1"]');

    expect(useUIStore.getState().activeModal).toBe('phase');
    expect(useUIStore.getState().editingPhase?.id).toBe(1);
  });

  it('opens the subphase modal for a superuser on any project', () => {
    asUser(9, 'superuser');
    const { container } = renderTimeline(makeProject(PM));

    clickBar(container, '[data-subphase-id="2"][data-project-id="1"]');

    expect(useUIStore.getState().activeModal).toBe('subphase');
    expect(useUIStore.getState().editingSubphase?.id).toBe(2);
  });

  it('does nothing for a plain user who does not manage the project', () => {
    asUser(5, 'user');
    const { container } = renderTimeline(makeProject(PM));

    clickBar(container, '[data-phase-id="1"][data-project-id="1"]');
    clickBar(container, '[data-subphase-id="2"][data-project-id="1"]');

    expect(useUIStore.getState().activeModal).toBeNull();
    expect(useUIStore.getState().editingPhase).toBeNull();
    expect(useUIStore.getState().editingSubphase).toBeNull();
  });

  it('opens the phase modal on a touch tap (the converted event keeps stopPropagation)', () => {
    asUser(PM, 'user');
    const { container } = renderTimeline(makeProject(PM));
    const bar = container.querySelector('[data-phase-id="1"][data-project-id="1"]');
    expect(bar).not.toBeNull();

    fireEvent.touchStart(bar!, { touches: [{ clientX: 10, clientY: 10 }] });
    expect(() => fireEvent.touchEnd(document)).not.toThrow();

    expect(useUIStore.getState().activeModal).toBe('phase');
    expect(useUIStore.getState().editingPhase?.id).toBe(1);
  });

  it('does nothing on a project without a manager for a plain user', () => {
    asUser(5, 'user');
    const { container } = renderTimeline(makeProject(null));

    clickBar(container, '[data-phase-id="1"][data-project-id="1"]');

    expect(useUIStore.getState().activeModal).toBeNull();
  });
});

/**
 * Every project row subscribed to the whole uiStore (F2-11), so each tooltip
 * or context-menu update re-rendered all rows despite `memo`.
 */
describe('ProjectTimeline subscriptions', () => {
  it('does not re-render on unrelated UI-store updates', () => {
    asUser(PM, 'user');
    const project = makeProject(PM);
    useAppStore.setState({ projects: [project] });
    const cells = generateTimelineCells(new Date(2026, 8, 15), 'month', new Set(), []);
    const onRender = vi.fn();
    render(
      <Profiler id="row" onRender={onRender}>
        <ProjectTimeline
          project={project}
          cells={cells}
          cellWidth={30}
          isExpanded
          expandedPhases={new Set([1])}
          expandedSubphases={new Set()}
        />
      </Profiler>
    );
    const before = onRender.mock.calls.length;

    act(() => useUIStore.getState().showTooltip('Hello', 10, 10));
    act(() => useUIStore.getState().showContextMenu('phase', 1, 10, 10, 1));
    act(() => useUIStore.getState().hideContextMenu());

    expect(onRender.mock.calls.length).toBe(before);
  });
});


/** "Colour by": the bar takes the store colour of the project's tag in the chosen group. */
describe('ProjectTimeline colour by', () => {
  const TYPE: TagGroup = { id: 1, name: 'Project type', single_select: true, sort_order: 0 };
  const AREA: TagGroup = { id: 2, name: 'Area', single_select: false, sort_order: 1 };
  const internal: Tag = {
    id: 10, name: 'Internal', color: '#f59e0b', group_id: 1, all_sites: true, site_ids: [], sort_order: 0,
  };

  beforeEach(() => {
    localStorage.clear();
    asUser(PM, 'user');
    useAppStore.setState({
      tags: [internal],
      tagGroups: [TYPE, AREA],
      currentSite: { id: 1, name: 'Basel' } as Site,
    });
    useViewStore.setState({ ganttColorBy: {} });
  });

  function taggedProject(): Project {
    // Inline colour is stale on purpose: the store's tag colour wins.
    return { ...makeProject(PM), tags: [{ id: 10, name: 'Internal', color: '#000000', group_id: 1 }] };
  }

  it('has no tag colour while Colour by is unset', () => {
    const { container } = renderTimeline(taggedProject());
    expect(container.querySelector('[data-tag-color]')).toBeNull();
  });

  it('uses the colour of the project tag in the chosen group', () => {
    useViewStore.setState({ ganttColorBy: { ':1': 1 } });
    const { container } = renderTimeline(taggedProject());
    const bar = container.querySelector('[data-tag-color]');
    expect(bar).not.toBeNull();
    expect(bar).toHaveAttribute('data-tag-color', '#f59e0b');
    expect(bar).toHaveStyle({ background: '#f59e0b' });
  });

  it('keeps the default colour when the project has no tag in the chosen group', () => {
    useViewStore.setState({ ganttColorBy: { ':1': 2 } });
    const { container } = renderTimeline(taggedProject());
    expect(container.querySelector('[data-tag-color]')).toBeNull();
  });
});
