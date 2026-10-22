/**
 * viewStore: view-mode zoom defaults, overview mutual exclusion, Kanban
 * settings, tree expansion (toggle / ensure / all / level-by-level) and the
 * persist round-trip of the Set-valued expansion state. Tag filters, Gantt
 * grouping/colouring and date navigation live in viewStore.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useViewStore } from '../viewStore';
import { makePhase, makeProject, makeSubphase } from '@/test/factories';
import type { Project } from '@/types';

const KEY = 'milestone-view-storage-v1';
const view = () => useViewStore.getState();

beforeEach(() => {
  localStorage.clear();
  view().resetView();
});

describe('view mode and simple settings', () => {
  it('applies the per-mode default cell width on a mode switch, then zooms freely', () => {
    view().setViewMode('week');
    expect(view()).toMatchObject({ viewMode: 'week', cellWidth: 100 });
    view().setCellWidth(70);
    expect(view().cellWidth).toBe(70);
    view().setViewMode('quarter');
    expect(view().cellWidth).toBe(50);
    view().setViewMode('year');
    expect(view().cellWidth).toBe(80);
    view().setViewMode('month');
    expect(view().cellWidth).toBe(36);
  });

  it('sets the current view, resource tab, scroll offset and date', () => {
    const date = new Date(2026, 4, 1);
    view().setCurrentView('kanban');
    view().setCurrentResourceTab('equipment');
    view().setTimelineScrollLeft(420);
    view().setCurrentDate(date);
    expect(view()).toMatchObject({
      currentView: 'kanban',
      currentResourceTab: 'equipment',
      timelineScrollLeft: 420,
      currentDate: date,
    });
  });

  it('goToToday moves the date back to now', () => {
    view().setCurrentDate(new Date(2000, 0, 1));
    view().goToToday();
    expect(view().currentDate.toDateString()).toBe(new Date().toDateString());
  });

  it('toggles assignments, sidebar and resource panel', () => {
    view().toggleShowAssignments();
    expect(view().showAssignments).toBe(false);
    view().setShowAssignments(true);
    expect(view().showAssignments).toBe(true);
    view().toggleSidebar();
    view().toggleResourcePanel();
    expect(view()).toMatchObject({ sidebarCollapsed: true, resourcePanelCollapsed: true });
    view().setSidebarCollapsed(false);
    view().setResourcePanelCollapsed(false);
    expect(view()).toMatchObject({ sidebarCollapsed: false, resourcePanelCollapsed: false });
  });

  it('keeps the staff and equipment overviews mutually exclusive', () => {
    view().setShowStaffOverview(true);
    view().setShowEquipmentOverview(true);
    expect(view()).toMatchObject({ showStaffOverview: false, showEquipmentOverview: true });
    view().toggleShowStaffOverview();
    expect(view()).toMatchObject({ showStaffOverview: true, showEquipmentOverview: false });
    view().toggleShowEquipmentOverview();
    expect(view()).toMatchObject({ showStaffOverview: false, showEquipmentOverview: true });
    view().toggleShowEquipmentOverview();
    expect(view()).toMatchObject({ showStaffOverview: false, showEquipmentOverview: false });
    view().setShowEquipmentOverview(false);
    view().setShowStaffOverview(false);
    view().toggleShowStaffOverview();
    view().toggleShowStaffOverview();
    expect(view()).toMatchObject({ showStaffOverview: false, showEquipmentOverview: false });
  });

  it('only keeps a Kanban grouping column for custom-column grouping', () => {
    view().setKanbanGrouping('customColumn', 7);
    expect(view()).toMatchObject({ kanbanGrouping: 'customColumn', kanbanGroupingColumnId: 7 });
    view().setKanbanGrouping('assignee' as never, 7);
    expect(view().kanbanGroupingColumnId).toBeNull();
    view().setKanbanProjectId(3);
    view().setKanbanMyTodoOnly(true);
    expect(view()).toMatchObject({ kanbanProjectId: 3, kanbanMyTodoOnly: true });
    view().toggleKanbanMyTodoOnly();
    expect(view().kanbanMyTodoOnly).toBe(false);
  });
});

describe('expansion state', () => {
  it('toggles each kind of row', () => {
    view().toggleProjectExpanded(1);
    view().togglePhaseExpanded(2);
    view().toggleSubphaseExpanded(3);
    view().toggleStaffExpanded(4);
    view().toggleEquipmentExpanded(5);
    view().toggleBankHolidaysExpanded();
    expect([...view().expandedProjects]).toEqual([1]);
    expect([...view().expandedPhases]).toEqual([2]);
    expect([...view().expandedSubphases]).toEqual([3]);
    expect([...view().expandedStaff]).toEqual([4]);
    expect([...view().expandedEquipment]).toEqual([5]);
    expect(view().expandedBankHolidays).toBe(true);

    view().toggleProjectExpanded(1);
    view().togglePhaseExpanded(2);
    view().toggleSubphaseExpanded(3);
    view().toggleStaffExpanded(4);
    view().toggleEquipmentExpanded(5);
    expect(view().expandedProjects.size + view().expandedPhases.size).toBe(0);
    expect(view().expandedSubphases.size + view().expandedStaff.size + view().expandedEquipment.size).toBe(0);
  });

  it('ensure* only adds and keeps the same Set when already expanded', () => {
    view().ensureProjectExpanded(1);
    view().ensurePhaseExpanded(2);
    view().ensureSubphaseExpanded(3);
    const before = view().expandedProjects;
    view().ensureProjectExpanded(1);
    view().ensurePhaseExpanded(2);
    view().ensureSubphaseExpanded(3);
    expect(view().expandedProjects).toBe(before);
    expect([...view().expandedPhases]).toEqual([2]);
    expect([...view().expandedSubphases]).toEqual([3]);
  });

  it('setExpanded*, expandAll and collapseAll', () => {
    view().setExpandedProjects(new Set([9]));
    view().setExpandedPhases(new Set([8]));
    expect([...view().expandedProjects]).toEqual([9]);
    expect([...view().expandedPhases]).toEqual([8]);

    const deep = makeSubphase({ id: 31, children: [makeSubphase({ id: 32 })] });
    view().expandAll([
      makeProject({ id: 1, phases: [makePhase({ id: 10, children: [deep] })] }),
      makeProject({ id: 2 }),
    ]);
    expect([...view().expandedProjects]).toEqual([1, 2]);
    expect([...view().expandedPhases]).toEqual([10]);
    expect([...view().expandedSubphases]).toEqual([31, 32]);

    view().toggleStaffExpanded(4);
    view().collapseAll();
    expect(view().expandedProjects.size).toBe(0);
    expect(view().expandedSubphases.size).toBe(0);
    expect(view().expandedStaff.size).toBe(0);
  });
});

describe('per-person booking groups', () => {
  it('starts expanded and toggles a group collapsed and back', () => {
    expect(view().collapsedStaffGroups.size).toBe(0);
    view().toggleStaffGroup('phase:10:4');
    view().toggleStaffGroup('subphase:21:5');
    expect([...view().collapsedStaffGroups]).toEqual(['phase:10:4', 'subphase:21:5']);
    view().toggleStaffGroup('phase:10:4');
    expect([...view().collapsedStaffGroups]).toEqual(['subphase:21:5']);
  });

  it('collapseAll and expandAll both reopen every group', () => {
    view().toggleStaffGroup('phase:10:4');
    view().collapseAll();
    expect(view().collapsedStaffGroups.size).toBe(0);

    view().toggleStaffGroup('phase:10:4');
    view().expandAll([makeProject({ id: 1 })]);
    expect(view().collapsedStaffGroups.size).toBe(0);
  });

  it('is session-only: never persisted, never restored', async () => {
    view().toggleStaffGroup('phase:10:4');
    view().setExpandedProjects(new Set([1]));
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state).not.toHaveProperty('collapsedStaffGroups');

    localStorage.setItem(KEY, JSON.stringify({ state: { collapsedStaffGroups: ['phase:1:2'] }, version: 0 }));
    view().resetView();
    await useViewStore.persist.rehydrate();
    expect(view().collapsedStaffGroups.size).toBe(0);
  });
});

describe('level-by-level expansion', () => {
  // Project 1 → phases 10 (sub 20 → sub 30), 11 (no children), milestone 12.
  const tree: Project[] = [
    makeProject({
      id: 1,
      phases: [
        makePhase({
          id: 10,
          children: [makeSubphase({ id: 20, children: [makeSubphase({ id: 30 })] })],
        }),
        makePhase({ id: 11 }),
        makePhase({ id: 12, is_milestone: true }),
      ],
    }),
    makeProject({ id: 2, phases: [] }),
  ];

  const snapshot = () => ({
    projects: [...view().expandedProjects].sort(),
    phases: [...view().expandedPhases].sort(),
    subphases: [...view().expandedSubphases].sort(),
  });

  it('steps down one level per call and stops at the deepest level', () => {
    view().expandProjectLevel(1, tree);
    expect(snapshot()).toEqual({ projects: [1], phases: [], subphases: [] });
    view().expandProjectLevel(1, tree);
    expect(snapshot()).toEqual({ projects: [1], phases: [10, 11], subphases: [] });
    view().expandProjectLevel(1, tree);
    expect(snapshot()).toEqual({ projects: [1], phases: [10, 11], subphases: [20] });
    view().expandProjectLevel(1, tree);
    expect(snapshot()).toEqual({ projects: [1], phases: [10, 11], subphases: [20] });
  });

  it('steps back up one level per call, down to collapsed', () => {
    view().setExpandedProjects(new Set([1]));
    view().setExpandedPhases(new Set([10, 11]));
    useViewStore.setState({ expandedSubphases: new Set([20, 30]) });
    view().collapseProjectLevel(1, tree);
    expect(snapshot()).toEqual({ projects: [1], phases: [10, 11], subphases: [] });
    view().collapseProjectLevel(1, tree);
    expect(snapshot()).toEqual({ projects: [1], phases: [], subphases: [] });
    view().collapseProjectLevel(1, tree);
    expect(snapshot()).toEqual({ projects: [], phases: [], subphases: [] });
    view().collapseProjectLevel(1, tree);
    expect(snapshot().projects).toEqual([]);
  });

  it('treats a project without phases as level 1 and ignores unknown projects', () => {
    view().expandProjectLevel(2, tree);
    expect(snapshot().projects).toEqual([2]);
    view().expandProjectLevel(2, tree);
    expect(snapshot().projects).toEqual([2]);
    view().collapseProjectLevel(2, tree);
    expect(snapshot().projects).toEqual([]);
    const before = view().expandedProjects;
    view().expandProjectLevel(99, tree);
    view().collapseProjectLevel(99, tree);
    expect(view().expandedProjects).toBe(before);
  });
});

describe('persistence', () => {
  it('persists the expansion Sets as arrays and not the scroll offset or date', () => {
    view().setViewMode('week');
    view().setExpandedProjects(new Set([1, 2]));
    view().ensureSubphaseExpanded(7);
    view().setTimelineScrollLeft(999);
    view().toggleStaffExpanded(3);
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state).toMatchObject({
      viewMode: 'week',
      cellWidth: 100,
      expandedProjects: [1, 2],
      expandedSubphases: [7],
    });
    expect(raw.state).not.toHaveProperty('timelineScrollLeft');
    expect(raw.state).not.toHaveProperty('currentDate');
    expect(raw.state).not.toHaveProperty('expandedStaff');
  });

  it('restores persisted fields and turns arrays back into Sets', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          viewMode: 'quarter',
          currentView: 'staff',
          cellWidth: 55,
          currentResourceTab: 'equipment',
          sidebarCollapsed: true,
          resourcePanelCollapsed: true,
          showStaffOverview: true,
          showEquipmentOverview: false,
          kanbanProjectId: 4,
          kanbanGrouping: 'customColumn',
          kanbanGroupingColumnId: 2,
          kanbanMyTodoOnly: true,
          expandedProjects: [1],
          expandedPhases: [10, 11],
          expandedSubphases: [20],
        },
        version: 0,
      })
    );
    await useViewStore.persist.rehydrate();
    expect(view()).toMatchObject({
      viewMode: 'quarter',
      currentView: 'staff',
      cellWidth: 55,
      currentResourceTab: 'equipment',
      sidebarCollapsed: true,
      resourcePanelCollapsed: true,
      showStaffOverview: true,
      kanbanProjectId: 4,
      kanbanGrouping: 'customColumn',
      kanbanGroupingColumnId: 2,
      kanbanMyTodoOnly: true,
    });
    expect(view().expandedProjects).toEqual(new Set([1]));
    expect(view().expandedPhases).toEqual(new Set([10, 11]));
    expect(view().expandedSubphases).toEqual(new Set([20]));
  });

  it('keeps the current values for missing or non-array persisted fields', async () => {
    view().setExpandedProjects(new Set([5]));
    localStorage.setItem(KEY, JSON.stringify({ state: { expandedProjects: 'nope' }, version: 0 }));
    await useViewStore.persist.rehydrate();
    expect(view().expandedProjects).toEqual(new Set([5]));
    expect(view().viewMode).toBe('month');
  });

  it('logs a hydration error from a broken storage backend', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(KEY, '{broken');
    await useViewStore.persist.rehydrate();
    expect(error).toHaveBeenCalledWith('[ViewStore] Hydration error:', expect.anything());
    error.mockRestore();
  });
});
