/**
 * The right-hand Gantt rows of one project: the project bar (own dates or
 * spanning its phases), phases/subphases with completion rolled up from
 * children, milestones, assignment bars at every level with absence and
 * site-closure markers, live "just edited by" badges, custom-column filters,
 * phantom rows, critical path, and the bar gestures (drag, resize, link,
 * Shift+click phantom) wired to the stores.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ProjectTimeline } from '../ProjectTimeline';
import { generateTimelineCells } from '../../utils';
import {
  resetAllStores,
  useAppStore,
  useUIStore,
  useViewStore,
  useCustomColumnStore,
} from '@/stores';
import { makePhase, makeProject, makeStaff, makeSubphase, makeTeam, makeUser, makeVacation } from '@/test/factories';
import type { Project } from '@/types';

const ws = vi.hoisted(() => ({ recentChanges: [] as Array<Record<string, unknown>> }));
vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ recentChanges: ws.recentChanges }),
}));

vi.mock('@/api/endpoints/projects', () => ({
  updatePhase: vi.fn(async () => ({})),
  updateSubphase: vi.fn(async () => ({})),
  updateProject: vi.fn(async () => ({})),
  updateStaffAssignment: vi.fn(async () => ({})),
  updateEquipmentAssignment: vi.fn(async () => ({})),
  loadAllProjects: vi.fn(async () => []),
}));

const cells = generateTimelineCells(new Date(2026, 8, 15), 'month', new Set(), []);

function buildProject(overrides: Partial<Project> = {}): Project {
  return makeProject({
    id: 1,
    name: 'Bioprocess Scale-Up',
    pm_id: 7,
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    phases: [
      makePhase({
        id: 10,
        name: 'Design',
        start_date: '2026-09-01',
        end_date: '2026-09-20',
        completion: 5,
        children: [
          makeSubphase({
            id: 20,
            name: 'Prototype',
            start_date: '2026-09-01',
            end_date: '2026-09-11', // 10 days
            completion: null,
            children: [
              makeSubphase({ id: 21, name: 'Rig', start_date: '2026-09-01', end_date: '2026-09-06', completion: 100 }),
              makeSubphase({ id: 22, name: 'Spare', start_date: '2026-09-06', end_date: '2026-09-11', completion: null }),
            ],
            staffAssignments: [{ id: 81, staff_id: 4, staff_name: 'Bob Brown', allocation: 20, start_date: '', end_date: '' }],
            equipmentAssignments: [{ id: 91, equipment_id: 2, equipment_name: 'Lyophilizer', start_date: '', end_date: '' }],
          }),
          makeSubphase({ id: 23, name: 'Review', start_date: '2026-09-14', end_date: '2026-09-20', completion: null }),
        ],
        staffAssignments: [{ id: 71, staff_id: 4, staff_name: 'Bob Brown', allocation: 30, start_date: '', end_date: '' }],
        equipmentAssignments: [{ id: 72, equipment_id: 1, equipment_name: 'Bioreactor 50L', start_date: '', end_date: '' }],
      }),
      makePhase({ id: 11, name: 'Gate review', start_date: '2026-09-25', end_date: '2026-09-25', is_milestone: true }),
    ],
    staffAssignments: [
      { id: 50, staff_id: 4, staff_name: 'Bob Brown', allocation: 40, start_date: '2026-09-07', end_date: '2026-09-18' },
    ],
    equipmentAssignments: [
      { id: 60, equipment_id: 1, equipment_name: 'Bioreactor 50L', start_date: '2026-09-01', end_date: '2026-09-04' },
    ],
    ...overrides,
  });
}

function renderTimeline(project: Project, expanded = { phases: [10], subphases: [20] }) {
  useAppStore.setState({ projects: [project] });
  return render(
    <ProjectTimeline
      project={project}
      cells={cells}
      cellWidth={30}
      isExpanded
      expandedPhases={new Set(expanded.phases)}
      expandedSubphases={new Set(expanded.subphases)}
    />
  );
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;

beforeEach(() => {
  resetAllStores();
  ws.recentChanges = [];
  useViewStore.setState({ viewMode: 'month', showAssignments: true, currentView: 'gantt' });
  useAppStore.setState({
    currentUser: makeUser({ id: 1, role: 'admin' }),
    staff: [makeStaff({ id: 4, site_id: 1 })],
  });
});

describe('ProjectTimeline rows', () => {
  it('rolls completion up from nested subphases', () => {
    renderTimeline(buildProject());
    // Rig 100 % (5 days) + Spare unset (5 days) -> Prototype 50 %
    expect(q('[data-subphase-id="20"][data-project-id="1"]')).toHaveAttribute('title', 'Prototype (50%)');
    // Prototype 50 % x 10 days + Review unset x 6 days -> Design 31 % (own 5 % ignored)
    expect(q('[data-phase-id="10"][data-project-id="1"]')).toHaveAttribute('title', 'Design (31%)');
    // a bar without completion shows no percentage
    expect(q('[data-subphase-id="23"][data-project-id="1"]')).toHaveAttribute('title', 'Review');
    // the milestone is a diamond with its label
    expect(screen.getByText('Gate review')).toBeInTheDocument();
    expect(q('[data-phase-id="11"][data-project-id="1"]')).toHaveAttribute('title', 'Gate review');
  });

  it('draws assignment bars at project, phase and subphase level', () => {
    renderTimeline(buildProject());
    expect(screen.getByTitle('Bob Brown (40%)')).toHaveAttribute('data-assignment-type', 'staff');
    expect(screen.getByTitle('Bob Brown (30%)').style.opacity).toBe('0.7');
    const subStaff = screen.getByTitle('Bob Brown (20%)');
    expect(subStaff.style.height).toBe('14px');
    expect(subStaff).toHaveAttribute('data-start', '2026-09-01');
    expect(screen.getAllByTitle('Bioreactor 50L')).toHaveLength(2);
    expect(screen.getByTitle('Lyophilizer')).toHaveAttribute('data-assignment-type', 'equipment');
  });

  it('hides assignment bars when assignments are switched off, and children when collapsed', () => {
    useViewStore.setState({ showAssignments: false });
    renderTimeline(buildProject(), { phases: [], subphases: [] });
    expect(screen.queryByTitle('Bob Brown (40%)')).not.toBeInTheDocument();
    expect(q('[data-subphase-id="20"][data-project-id="1"]')).toBeNull();
    expect(q('[data-phase-id="10"][data-project-id="1"]')).not.toBeNull();
  });

  it('spans the project bar over its phases when it has no dates of its own', () => {
    const { unmount } = renderTimeline(buildProject({ start_date: '', end_date: '' }));
    expect(screen.getAllByText('Bioprocess Scale-Up').length).toBeGreaterThan(0);
    unmount();
    renderTimeline(buildProject({ start_date: '', end_date: '', phases: [] }));
    expect(screen.queryByText('Bioprocess Scale-Up')).not.toBeInTheDocument();
  });

  it('marks absences and site closures on the staff member\'s bookings', () => {
    useAppStore.setState({
      vacations: [makeVacation({ staff_id: 4, start_date: '2026-09-08', end_date: '2026-09-09', description: 'Ski' })],
    });
    act(() =>
      useAppStore.getState().setCompanyEvents(
        [{ id: 3, site_id: 1, site_ids: [1], date: '2026-09-15', name: 'Shutdown', counts_as_unavailable: true }],
        new Set(['2026-09-15'])
      )
    );
    renderTimeline(buildProject());
    // one two-day strip on each of Bob's bookings covering Sep 8-9
    const absences = screen.getAllByTitle('Ski');
    expect(absences.length).toBeGreaterThan(0);
    absences.forEach((a) => expect(a.style.width).toBe('60px'));
    expect(screen.getAllByTitle('Site closed: Shutdown').length).toBeGreaterThan(0);
  });

  it('marks a team-restricted closure on team members\' bookings only', () => {
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1 }), makeTeam({ id: 2, site_id: 1, name: 'Process' })],
      staff: [
        makeStaff({ id: 4, name: 'Bob Brown', site_id: 1, team_ids: [1] }),
        makeStaff({ id: 5, name: 'Carol White', site_id: 1, team_ids: [2] }),
      ],
    });
    act(() =>
      useAppStore.getState().setCompanyEvents(
        [
          { id: 3, site_id: 1, site_ids: [1], team_ids: [1], date: '2026-09-15', name: 'Team offsite', counts_as_unavailable: true },
          { id: 4, site_id: 1, site_ids: [1], team_ids: [], date: '2026-09-16', name: 'Shutdown', counts_as_unavailable: true },
        ],
        new Set(['2026-09-15', '2026-09-16'])
      )
    );
    const booking = (staffId: number, name: string) =>
      buildProject({
        phases: [],
        equipmentAssignments: [],
        staffAssignments: [
          { id: 50, staff_id: staffId, staff_name: name, allocation: 40, start_date: '2026-09-07', end_date: '2026-09-18' },
        ],
      });

    // A member: both closures
    const { unmount } = renderTimeline(booking(4, 'Bob Brown'));
    expect(screen.getAllByTitle('Site closed: Team offsite')).toHaveLength(1);
    expect(screen.getAllByTitle('Site closed: Shutdown')).toHaveLength(1);
    unmount();

    // A non-member on the same site: only the whole-site closure
    renderTimeline(booking(5, 'Carol White'));
    expect(screen.queryByTitle('Site closed: Team offsite')).not.toBeInTheDocument();
    expect(screen.getAllByTitle('Site closed: Shutdown')).toHaveLength(1);
  });

  it('shows who just edited a phase, subphase or booking', () => {
    ws.recentChanges = [
      { entity_type: 'phase', entity_id: 10, user_name: 'Vincent D.' },
      { entity_type: 'subphase', entity_id: 23, user_name: 'Ada A.' },
      { entity_type: 'staff_assignment', entity_id: 50, user_name: 'Bob B.' },
    ];
    renderTimeline(buildProject());
    expect(screen.getByText('✨ Vincent D.')).toBeInTheDocument();
    expect(screen.getByText('✨ Ada A.')).toBeInTheDocument();
    expect(screen.getByTitle('Bob Brown (40%) — just edited by Bob B.')).toBeInTheDocument();
    expect(screen.getByText('✨ Bob B.')).toBeInTheDocument();
  });

  it('hides phases and subphases filtered out by a custom column', () => {
    useCustomColumnStore.setState({
      customColumnFilters: { 3: ['Yes'] },
      customColumnValues: { '3-subphase-21': 'Yes' },
    });
    renderTimeline(buildProject(), { phases: [10], subphases: [20] });
    // Design stays (a descendant matches), the milestone goes
    expect(q('[data-phase-id="10"][data-project-id="1"]')).not.toBeNull();
    expect(q('[data-phase-id="11"][data-project-id="1"]')).toBeNull();
    expect(q('[data-subphase-id="21"][data-project-id="1"]')).not.toBeNull();
    expect(q('[data-subphase-id="22"][data-project-id="1"]')).toBeNull();
    expect(q('[data-subphase-id="23"][data-project-id="1"]')).toBeNull();
  });

  it('marks critical-path items', () => {
    useAppStore.setState({
      criticalPathEnabled: new Set([1]),
      criticalPathItems: new Map([[1, new Set(['phase-10', 'subphase-23'])]]),
    });
    renderTimeline(buildProject());
    expect(q('[data-phase-id="10"][data-project-id="1"]')!.getAttribute('title')).toMatch(/Critical Path$/);
    expect(q('[data-subphase-id="23"][data-project-id="1"]')).toHaveAttribute('title', 'Review - Critical Path');
  });

  it.each([
    ['phase', { type: 'phase' as const, sourceId: 10 }],
    ['subphase of a phase', { type: 'subphase' as const, sourceId: 20, parentType: 'phase' as const, parentId: 10 }],
    ['nested subphase', { type: 'subphase' as const, sourceId: 21, parentType: 'subphase' as const, parentId: 20 }],
  ])('leaves a phantom row after the %s source', (_label, mode) => {
    useUIStore.setState({
      phantomSiblingMode: {
        projectId: 1,
        dependencyType: 'FS',
        phantomStart: '2026-09-21',
        phantomEnd: '2026-09-25',
        phantomColor: '#000',
        siblingDurationDays: 5,
        sourceIndex: 0,
        ...mode,
      },
    });
    const { container } = renderTimeline(buildProject());
    expect(container.querySelectorAll('[class*="phantomRow"]')).toHaveLength(1);
  });
});

describe('ProjectTimeline gestures', () => {
  it('starts a phase drag once the pointer moves past the threshold', () => {
    renderTimeline(buildProject());
    const bar = q('[data-phase-id="10"][data-project-id="1"]')!;
    fireEvent.mouseDown(bar, { clientX: 100, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 102, clientY: 10 });
    expect(useUIStore.getState().isDragging).toBe(false);
    fireEvent.mouseMove(document, { clientX: 120, clientY: 10 });
    expect(useUIStore.getState().dragType).toBe('phase');
    expect(useUIStore.getState().dragItemId).toBe(10);
    // a drag is not a click
    fireEvent.mouseUp(document);
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('starts a subphase drag, and resizes from either edge', () => {
    renderTimeline(buildProject());
    const sub = q('[data-subphase-id="23"][data-project-id="1"]')!;
    fireEvent.mouseDown(sub, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(document, { clientX: 0, clientY: 20 });
    expect(useUIStore.getState().dragType).toBe('subphase');
    fireEvent.mouseUp(document);

    const handles = sub.querySelectorAll('[class*="resizeHandle"]');
    fireEvent.mouseDown(handles[0], { clientX: 0 });
    expect(useUIStore.getState()).toMatchObject({ isResizing: true, resizeEdge: 'left', resizeItemId: 23 });
    fireEvent.mouseUp(document);
    fireEvent.mouseDown(handles[1], { clientX: 0 });
    expect(useUIStore.getState().resizeEdge).toBe('right');
    fireEvent.mouseUp(document);
  });

  it('drags and resizes project-level bookings', () => {
    renderTimeline(buildProject());
    const staff = screen.getByTitle('Bob Brown (40%)');
    fireEvent.mouseDown(staff, { clientX: 0 });
    expect(useUIStore.getState().dragType).toBe('staffAssignment');
    fireEvent.mouseUp(document);

    fireEvent.mouseDown(staff.querySelector('.resize-handle')!, { clientX: 0 });
    expect(useUIStore.getState()).toMatchObject({ isResizing: true, resizeItemType: 'staffAssignment' });
    fireEvent.mouseUp(document);

    const equip = screen.getAllByTitle('Bioreactor 50L').find((el) => el.getAttribute('data-end') === '2026-09-04')!;
    fireEvent.mouseDown(equip, { clientX: 0 });
    expect(useUIStore.getState().dragType).toBe('equipmentAssignment');
    fireEvent.mouseUp(document);
    const handles = equip.querySelectorAll('.resize-handle');
    fireEvent.mouseDown(handles[1], { clientX: 0 });
    expect(useUIStore.getState()).toMatchObject({ resizeItemType: 'equipmentAssignment', resizeEdge: 'right' });
    fireEvent.mouseUp(document);
  });

  it('starts dependency linking from a link zone and a phantom sibling on Shift+click', () => {
    renderTimeline(buildProject());
    const bar = q('[data-subphase-id="23"][data-project-id="1"]')!;
    fireEvent.click(bar.querySelector('[title^="Click to start linking (FS"]')!);
    expect(useUIStore.getState().isLinkingDependency).toBe(true);
    expect(useUIStore.getState().linkingFrom).toMatchObject({ projectId: 1, itemId: 23, itemType: 'subphase', zone: 'end' });
    act(() => useUIStore.getState().cancelLinking());

    const milestone = q('[data-phase-id="11"][data-project-id="1"]')!;
    fireEvent.click(milestone.querySelector('[title^="Click to start linking (SS"]')!, { shiftKey: true });
    expect(useUIStore.getState().phantomSiblingMode).toMatchObject({ sourceId: 11, type: 'phase', dependencyType: 'SS' });
    document.body.classList.remove('phantom-sibling-mode');
  });

  it('is read-only for someone who cannot edit the project', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 3, role: 'user' }) });
    renderTimeline(buildProject());
    const bar = q('[data-phase-id="10"][data-project-id="1"]')!;
    expect(bar.querySelector('[class*="resizeHandle"]')).toBeNull();
    expect(bar.querySelector('[title^="Click to start linking"]')).toBeNull();
    fireEvent.mouseDown(bar, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(document, { clientX: 50, clientY: 0 });
    fireEvent.mouseUp(document);
    expect(useUIStore.getState().isDragging).toBe(false);
    expect(screen.getByTitle('Bob Brown (40%)').querySelector('.resize-handle')).toBeNull();
  });
});

describe('ProjectTimeline card bookings (linked / unlinked)', () => {
  function withSegment(): Project {
    const project = buildProject();
    project.phases[0].staffAssignments = [
      { id: 71, staff_id: 4, staff_name: 'Bob Brown', allocation: 30, start_date: '2026-09-01', end_date: '2026-09-20', linked: true },
      { id: 73, staff_id: 5, staff_name: 'Cleo Chen', allocation: 60, start_date: '2026-09-07', end_date: '2026-09-09', linked: false },
    ];
    project.phases[0].children[0].staffAssignments = [
      { id: 81, staff_id: 4, staff_name: 'Bob Brown', allocation: 20, start_date: '2026-09-03', end_date: '2026-09-04', linked: false },
    ];
    return project;
  }

  it('draws an unlinked segment at its own dates, movable and resizable within the card', () => {
    renderTimeline(withSegment());
    const segment = screen.getByTitle('Cleo Chen (60%)');
    expect(segment).toHaveAttribute('data-start', '2026-09-07');
    expect(segment).toHaveAttribute('data-end', '2026-09-09');
    expect(segment.className).toMatch(/interactive/);

    fireEvent.mouseDown(segment, { clientX: 0 });
    expect(useUIStore.getState()).toMatchObject({ dragType: 'staffAssignment', dragItemId: 73 });
    fireEvent.mouseUp(document);

    const handles = segment.querySelectorAll('.resize-handle');
    expect(handles).toHaveLength(2);
    fireEvent.mouseDown(handles[1], { clientX: 0 });
    expect(useUIStore.getState()).toMatchObject({ isResizing: true, resizeItemType: 'staffAssignment', resizeItemId: 73 });
    fireEvent.mouseUp(document);

    // A subphase segment too
    const subSegment = screen.getByTitle('Bob Brown (20%)');
    expect(subSegment).toHaveAttribute('data-start', '2026-09-03');
    fireEvent.mouseDown(subSegment, { clientX: 0 });
    expect(useUIStore.getState()).toMatchObject({ dragType: 'staffAssignment', dragItemId: 81 });
    fireEvent.mouseUp(document);
  });

  it('keeps a linked booking read-only, spanning its card', () => {
    renderTimeline(withSegment());
    const linked = screen.getByTitle('Bob Brown (30%)');
    expect(linked).toHaveAttribute('data-start', '2026-09-01');
    expect(linked).toHaveAttribute('data-end', '2026-09-20');
    expect(linked.className).not.toMatch(/interactive/);
    expect(linked.querySelector('.resize-handle')).toBeNull();
    fireEvent.mouseDown(linked, { clientX: 0 });
    expect(useUIStore.getState().isDragging).toBe(false);
  });

  it("keeps someone else's segment read-only for a plain user", () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user' }) });
    renderTimeline(withSegment());
    expect(screen.getByTitle('Cleo Chen (60%)').querySelector('.resize-handle')).toBeNull();
    // ...while their own segment may move
    expect(screen.getByTitle('Bob Brown (20%)').querySelectorAll('.resize-handle')).toHaveLength(2);
  });
});
