/**
 * The project row of the Gantt tree: summary (status, PM, customer, completion
 * weighted from phases), expand/collapse by click and by level, critical-path
 * toggle, edit on double-click for editors only, context menu, drag-to-reorder,
 * project-level assignment rows, custom-column filters and the phantom row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, createEvent, within } from '@testing-library/react';
import { ProjectRow } from '../ProjectRow';
import { ReorderProvider } from '@/contexts/ReorderContext';
import { resetAllStores, useAppStore, useUIStore, useViewStore, useCustomColumnStore } from '@/stores';
import {
  makeCustomColumn,
  makeEquipment,
  makePhase,
  makeProject,
  makeStaff,
  makeSubphase,
  makeUser,
} from '@/test/factories';
import type { Project } from '@/types';

vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api')>()),
  updatePhase: vi.fn().mockResolvedValue({ success: true }),
  updateSubphase: vi.fn().mockResolvedValue({ success: true }),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

function buildProject(overrides: Partial<Project> = {}): Project {
  return makeProject({
    id: 1,
    name: 'Bioprocess Scale-Up',
    pm_id: 7,
    pm_name: 'Pat Manager',
    customer: 'Acme Pharma',
    confirmed: false,
    phases: [
      makePhase({
        id: 10,
        name: 'Feasibility',
        start_date: '2026-01-05',
        end_date: '2026-01-14', // 10 days
        completion: 100,
        children: [
          makeSubphase({
            id: 100,
            name: 'Literature review',
            children: [makeSubphase({ id: 101, name: 'Deep dive' })],
          }),
        ],
      }),
      makePhase({
        id: 11,
        name: 'Scale-up',
        start_date: '2026-01-15',
        end_date: '2026-01-24', // 10 days, unset -> 0 %
        completion: null,
      }),
    ],
    staffAssignments: [
      { id: 50, staff_id: 4, allocation: 40, start_date: '2026-01-05', end_date: '2026-01-30' },
      { id: 51, staff_id: 99, staff_name: 'Gone Person', allocation: 20, start_date: '2026-01-05', end_date: '2026-01-30' },
    ],
    equipmentAssignments: [
      { id: 60, equipment_id: 1, start_date: '2026-01-05', end_date: '2026-01-09' },
      { id: 61, equipment_id: 77, start_date: '2026-01-05', end_date: '2026-01-09' },
    ],
    ...overrides,
  });
}

function renderRow(project: Project, props: Partial<React.ComponentProps<typeof ProjectRow>> = {}) {
  useAppStore.setState({ projects: [project] });
  return render(
    <ReorderProvider>
      <ProjectRow project={project} nameColumnWidth={320} {...props} />
    </ReorderProvider>
  );
}

const projectRow = () => document.querySelector('[data-project-id="1"]') as HTMLElement;

beforeEach(() => {
  resetAllStores();
  useViewStore.setState({
    expandedProjects: new Set(),
    expandedPhases: new Set(),
    expandedSubphases: new Set(),
    showAssignments: true,
  });
  useAppStore.setState({
    currentUser: makeUser({ id: 1, role: 'admin' }),
    staff: [makeStaff({ id: 4, name: 'Bob Brown', role: 'Scientist' })],
    equipment: [makeEquipment({ id: 1, name: 'Bioreactor 50L', type: 'Bioreactor' })],
  });
});

describe('ProjectRow summary', () => {
  it('shows name, PM, customer, unconfirmed status and the duration-weighted completion', () => {
    renderRow(buildProject());
    expect(screen.getByTitle('Bioprocess Scale-Up')).toBeInTheDocument();
    expect(screen.getByText('Pat Manager')).toBeInTheDocument();
    expect(screen.getByText(/Acme Pharma/)).toBeInTheDocument();
    expect(screen.getByTitle('Unconfirmed')).toBeInTheDocument();
    // 100 % x 10 days + 0 % x 10 days
    expect(screen.getByTitle('Project completion (calculated from phases)')).toHaveTextContent('50%');
  });

  it('leaves out the customer while the Customer field is hidden', () => {
    useAppStore.setState({ instanceSettings: { project_fields_hidden: '["customer"]' } });
    renderRow(buildProject());
    expect(screen.getByText('Pat Manager')).toBeInTheDocument();
    expect(screen.queryByText(/Acme Pharma/)).not.toBeInTheDocument();
  });

  it('derives a phase completion from its children when one has a value', () => {
    const project = buildProject({
      confirmed: true,
      phases: [
        makePhase({
          id: 10,
          start_date: '2026-01-05',
          end_date: '2026-01-14',
          completion: 10,
          children: [
            makeSubphase({ id: 100, start_date: '2026-01-05', end_date: '2026-01-09', completion: 80 }),
            makeSubphase({ id: 101, start_date: '2026-01-12', end_date: '2026-01-16', completion: null }),
          ],
        }),
      ],
    });
    renderRow(project);
    expect(screen.getByTitle('Confirmed')).toBeInTheDocument();
    expect(screen.getByTitle('Project completion (calculated from phases)')).toHaveTextContent('40%');
  });

  it('shows no completion badge for a project without phases and renders custom-column placeholders', () => {
    const columns = [makeCustomColumn({ id: 1, width: 90 }), makeCustomColumn({ id: 2, width: 140 })];
    renderRow(buildProject({ phases: [], pm_name: null, customer: null }), { customColumns: columns });
    expect(screen.queryByTitle('Project completion (calculated from phases)')).not.toBeInTheDocument();
    const nameColumn = projectRow().firstElementChild as HTMLElement;
    expect(nameColumn.style.width).toBe('320px');
    const cells = (nameColumn.nextElementSibling as HTMLElement).children;
    expect(Array.from(cells).map((c) => (c as HTMLElement).style.width)).toEqual(['90px', '140px']);
  });
});

describe('ProjectRow expansion', () => {
  it('expands and collapses by clicking the info area or the status dot', () => {
    renderRow(buildProject());
    expect(screen.queryByText('Feasibility')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Bioprocess Scale-Up'));
    expect(useViewStore.getState().expandedProjects.has(1)).toBe(true);
    expect(screen.getByText('Feasibility')).toBeInTheDocument();
    expect(screen.getByText('Scale-up')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Unconfirmed'));
    expect(useViewStore.getState().expandedProjects.has(1)).toBe(false);
  });

  it('steps through expansion levels with the +/- buttons', () => {
    renderRow(buildProject());
    const collapse = screen.getByTitle('Collapse one level');
    const expand = screen.getByTitle('Expand one level');
    expect(collapse).toBeDisabled();

    fireEvent.click(expand);
    expect(useViewStore.getState().expandedProjects.has(1)).toBe(true);
    expect(collapse).not.toBeDisabled();
    fireEvent.click(expand);
    expect(useViewStore.getState().expandedPhases.has(10)).toBe(true);
    fireEvent.click(expand);
    expect(useViewStore.getState().expandedSubphases.has(100)).toBe(true);
    // phase -> subphase -> nested: fully expanded, nothing left for "+"
    expect(expand).toBeDisabled();

    fireEvent.click(collapse);
    expect(expand).not.toBeDisabled();
    fireEvent.click(expand);
    expect(useViewStore.getState().expandedSubphases.has(100)).toBe(true);

    fireEvent.click(collapse);
    expect(useViewStore.getState().expandedSubphases.has(100)).toBe(false);
    expect(useViewStore.getState().expandedPhases.has(10)).toBe(true);
    fireEvent.click(collapse);
    fireEvent.click(collapse);
    expect(useViewStore.getState().expandedProjects.has(1)).toBe(false);
    expect(collapse).toBeDisabled();
  });

  it('disables "+" after two steps when phases only have direct subphases', () => {
    renderRow(
      buildProject({
        phases: [
          makePhase({ id: 10, name: 'Feasibility', children: [makeSubphase({ id: 100, name: 'Review' })] }),
          makePhase({ id: 11, name: 'Scale-up' }),
        ],
      })
    );
    const expand = screen.getByTitle('Expand one level');

    fireEvent.click(expand);
    expect(expand).not.toBeDisabled();
    fireEvent.click(expand);
    expect(useViewStore.getState().expandedPhases.has(10)).toBe(true);
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(expand).toBeDisabled();
  });

  it('disables "+" once a project whose phases have no subphases is open', () => {
    renderRow(buildProject({ phases: [makePhase({ id: 10, name: 'Feasibility' })] }));
    const expand = screen.getByTitle('Expand one level');
    fireEvent.click(expand);
    expect(screen.getByText('Feasibility')).toBeInTheDocument();
    expect(expand).toBeDisabled();
  });

  it('allows one level for a project without phases (to add the first one)', () => {
    renderRow(buildProject({ phases: [] }));
    const expand = screen.getByTitle('Expand one level');
    expect(expand).not.toBeDisabled();
    fireEvent.click(expand);
    expect(useViewStore.getState().expandedProjects.has(1)).toBe(true);
    expect(expand).toBeDisabled();
  });

  it('lists project-level staff and equipment, resolving names from the stores', () => {
    useViewStore.setState({ expandedProjects: new Set([1]) });
    renderRow(buildProject());
    expect(screen.getAllByText('STAFF')).toHaveLength(2);
    expect(screen.getAllByText('EQUIP')).toHaveLength(2);
    expect(screen.getByTitle('Bob Brown - Scientist')).toBeInTheDocument();
    expect(screen.getByTitle('Gone Person')).toBeInTheDocument();
    expect(screen.getByTitle('Bioreactor 50L - Bioreactor')).toBeInTheDocument();
    expect(screen.getByTitle('Unknown')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('hides assignment rows when assignments are switched off', () => {
    useViewStore.setState({ expandedProjects: new Set([1]), showAssignments: false });
    renderRow(buildProject());
    expect(screen.getByText('Feasibility')).toBeInTheDocument();
    expect(screen.queryByText('STAFF')).not.toBeInTheDocument();
    expect(screen.queryByText('EQUIP')).not.toBeInTheDocument();
  });

  it('applies custom-column filters to phases, keeping a phase whose descendant matches', () => {
    useViewStore.setState({ expandedProjects: new Set([1]) });
    useCustomColumnStore.setState({
      customColumnFilters: { 5: ['High'] },
      customColumnValues: { '5-subphase-101': 'High' },
    });
    renderRow(buildProject());
    // Feasibility kept because its nested subphase 101 matches; Scale-up dropped
    expect(screen.getByText('Feasibility')).toBeInTheDocument();
    expect(screen.queryByText('Scale-up')).not.toBeInTheDocument();
  });

  it('lets the "(empty)" filter keep phases without a value', () => {
    useViewStore.setState({ expandedProjects: new Set([1]) });
    useCustomColumnStore.setState({
      customColumnFilters: { 5: ['__empty__'] },
      customColumnValues: { '5-phase-10': 'High', '5-subphase-100': 'Low', '5-subphase-101': 'Low' },
    });
    renderRow(buildProject());
    expect(screen.queryByText('Feasibility')).not.toBeInTheDocument();
    expect(screen.getByText('Scale-up')).toBeInTheDocument();
  });

  it('shows the phantom row right after the source phase', () => {
    useViewStore.setState({ expandedProjects: new Set([1]) });
    useUIStore.setState({
      phantomSiblingMode: {
        projectId: 1,
        sourceId: 10,
        type: 'phase',
        dependencyType: 'SS',
        phantomStart: '2026-01-15',
        phantomEnd: '2026-01-20',
        phantomColor: '#3b82f6',
        siblingDurationDays: 5,
        sourceIndex: 0,
      },
    });
    renderRow(buildProject());
    expect(screen.getByText('New Phase')).toBeInTheDocument();
    expect(screen.getByText(/Start-to-Start/)).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Cancel (Esc)'));
    expect(useUIStore.getState().phantomSiblingMode).toBeNull();
  });
});

describe('ProjectRow actions', () => {
  it('toggles the critical path for the project', () => {
    renderRow(buildProject());
    fireEvent.click(screen.getByTitle('Show Critical Path'));
    expect(useAppStore.getState().criticalPathEnabled.has(1)).toBe(true);
  });

  it('shows the active critical-path state', () => {
    useAppStore.setState({ criticalPathEnabled: new Set([1]) });
    renderRow(buildProject());
    fireEvent.click(screen.getByTitle('Hide Critical Path'));
    expect(useAppStore.getState().criticalPathEnabled.has(1)).toBe(false);
  });

  it('opens the project editor on double-click for an editor only', () => {
    const project = buildProject();
    const { unmount } = renderRow(project);
    fireEvent.doubleClick(projectRow());
    expect(useUIStore.getState().activeModal).toBe('project');
    expect(useUIStore.getState().editingProject?.id).toBe(1);
    unmount();

    useUIStore.setState({ activeModal: null, editingProject: null });
    useAppStore.setState({ currentUser: makeUser({ id: 3, role: 'user' }) });
    renderRow(project);
    fireEvent.doubleClick(projectRow());
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('opens the project context menu at the cursor', () => {
    renderRow(buildProject());
    fireEvent.contextMenu(projectRow(), { clientX: 40, clientY: 60 });
    expect(useUIStore.getState().contextMenu).toMatchObject({
      visible: true,
      type: 'project',
      targetId: 1,
      x: 40,
      y: 60,
    });
  });
});

describe('ProjectRow reordering', () => {
  // jsdom has no DragEvent: pointer coordinates and relatedTarget are set by hand
  const drag = (
    kind: 'dragOver' | 'drop' | 'dragLeave',
    el: HTMLElement,
    init: { dataTransfer?: object; clientY?: number; relatedTarget?: EventTarget }
  ) => {
    const { clientY, relatedTarget, ...rest } = init;
    const event = createEvent[kind](el, rest);
    if (clientY !== undefined) Object.defineProperty(event, 'clientY', { value: clientY });
    if (relatedTarget) Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
    fireEvent(el, event);
  };
  const dt = (id: string, types = ['application/x-project-reorder']) => ({
    types,
    getData: () => id,
    setData: vi.fn(),
    effectAllowed: '',
  });

  it('only shows a drag handle to editors when reordering is enabled', () => {
    const { unmount } = renderRow(buildProject());
    expect(screen.queryByTitle('Drag to reorder')).not.toBeInTheDocument();
    unmount();

    renderRow(buildProject(), { onReorder: vi.fn() });
    expect(screen.getByTitle('Drag to reorder')).toBeInTheDocument();
  });

  it('marks the row being dragged and stores the project id', () => {
    renderRow(buildProject(), { onReorder: vi.fn() });
    const transfer = dt('');
    fireEvent.dragStart(screen.getByTitle('Drag to reorder'), { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith('application/x-project-reorder', '1');
    expect(projectRow().className).toMatch(/dragging/);
    fireEvent.dragEnd(screen.getByTitle('Drag to reorder'));
    expect(projectRow().className).not.toMatch(/dragging/);
  });

  it('reports before/after drops of another project', () => {
    const onReorder = vi.fn();
    renderRow(buildProject(), { onReorder });
    const row = projectRow();

    drag('dragOver', row, { dataTransfer: dt('2'), clientY: -5 });
    expect(row.className).toMatch(/dropAbove/);
    drag('dragOver', row, { dataTransfer: dt('2'), clientY: 5 });
    expect(row.className).toMatch(/dropBelow/);
    drag('dragLeave', row, { relatedTarget: document.body });
    expect(row.className).not.toMatch(/dropBelow/);

    drag('drop', row, { dataTransfer: dt('2'), clientY: -5 });
    expect(onReorder).toHaveBeenLastCalledWith(2, 1, 'before');
    drag('drop', row, { dataTransfer: dt('3'), clientY: 5 });
    expect(onReorder).toHaveBeenLastCalledWith(3, 1, 'after');
  });

  it('ignores foreign drags, drops on itself and unparsable ids', () => {
    const onReorder = vi.fn();
    renderRow(buildProject(), { onReorder });
    const row = projectRow();

    drag('dragOver', row, { dataTransfer: dt('2', ['text/plain']), clientY: 5 });
    expect(row.className).not.toMatch(/dropBelow/);

    drag('dragOver', row, { dataTransfer: dt('2'), clientY: 5 });
    // leaving into a child keeps the indicator
    drag('dragLeave', row, { relatedTarget: within(row).getByTitle('Bioprocess Scale-Up') });
    expect(row.className).toMatch(/dropBelow/);

    drag('drop', row, { dataTransfer: dt('1') });
    drag('drop', row, { dataTransfer: dt('abc') });
    expect(onReorder).not.toHaveBeenCalled();
    expect(row.className).not.toMatch(/dropBelow/);
  });
});
