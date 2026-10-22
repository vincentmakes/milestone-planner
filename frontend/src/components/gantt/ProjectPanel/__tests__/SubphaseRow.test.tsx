/**
 * Subphase rows in the Gantt tree: WBS level badge (scrolls the timeline),
 * dates and milestones, completion rolled up from children (read-only) vs set
 * by hand through the completion slider, expand/collapse into nested rows and
 * assignments, edit on double-click for editors, context menu, critical path,
 * custom-column filters, the phantom row and drag-to-reorder.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SubphaseRow } from '../SubphaseRow';
import { ReorderProvider } from '@/contexts/ReorderContext';
import { resetAllStores, useAppStore, useUIStore, useViewStore, useCustomColumnStore } from '@/stores';
import { updateSubphase } from '@/api/endpoints/projects';
import {
  makeCustomColumn,
  makeEquipment,
  makePhase,
  makeProject,
  makeStaff,
  makeSubphase,
  makeUser,
} from '@/test/factories';
import type { Subphase } from '@/types';

vi.mock('@/api/endpoints/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/projects')>()),
  updateSubphase: vi.fn(),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api')>()),
  setCustomColumnValue: vi.fn().mockResolvedValue({}),
  setCustomColumnValuesBatch: vi.fn().mockResolvedValue([]),
}));

const nestedA = makeSubphase({
  id: 31,
  name: 'Column A',
  parent_subphase_id: 30,
  start_date: '2026-03-02',
  end_date: '2026-03-06',
  completion: 80,
});
const nestedB = makeSubphase({
  id: 32,
  name: 'Column B',
  parent_subphase_id: 30,
  start_date: '2026-03-09',
  end_date: '2026-03-13',
  completion: null,
  is_milestone: false,
});

const parent = makeSubphase({
  id: 30,
  name: 'Screening',
  color: '#123456',
  start_date: '2026-03-02',
  end_date: '2026-03-13',
  children: [nestedA, nestedB],
  staffAssignments: [{ id: 81, staff_id: 4, allocation: 20, start_date: '', end_date: '' }],
  equipmentAssignments: [{ id: 91, equipment_id: 77, equipment_name: 'Old rig', start_date: '', end_date: '' }],
});
const leaf = makeSubphase({ id: 40, name: 'Report', start_date: '2026-03-16', end_date: '2026-03-20', completion: 25 });
const milestone = makeSubphase({ id: 41, name: 'Sign-off', start_date: '2026-03-23', end_date: '2026-03-23', is_milestone: true });

function seed(role: 'admin' | 'user' = 'admin') {
  useAppStore.setState({
    currentUser: makeUser({ id: 1, role }),
    staff: [makeStaff({ id: 4, name: 'Bob Brown', role: 'Scientist' })],
    equipment: [makeEquipment({ id: 1 })],
    projects: [makeProject({ id: 1, pm_id: 9, phases: [makePhase({ id: 10, children: [parent, leaf, milestone] })] })],
  });
}

function renderRow(subphase: Subphase, props: Partial<React.ComponentProps<typeof SubphaseRow>> = {}) {
  return render(
    <ReorderProvider>
      <SubphaseRow
        subphase={subphase}
        phaseId={10}
        projectId={1}
        depth={2}
        siblings={[parent, leaf, milestone]}
        parentId={10}
        parentType="phase"
        nameColumnWidth={320}
        {...props}
      />
    </ReorderProvider>
  );
}

const row = (id: number) => document.querySelector(`[data-subphase-id="${id}"]`) as HTMLElement;

beforeEach(() => {
  resetAllStores();
  vi.mocked(updateSubphase).mockReset().mockResolvedValue({ success: true } as never);
  useViewStore.setState({ expandedSubphases: new Set(), showAssignments: true });
  seed();
});

describe('SubphaseRow display', () => {
  it('shows the level, name, dates and a calculated completion', () => {
    renderRow(parent, { wbsLevel: 2 });
    const level = screen.getByTitle('Level 2 - Click to scroll to start date');
    expect(level).toHaveTextContent('L2');
    expect(level.style.backgroundColor).toBe('rgb(18, 52, 86)');
    expect(screen.getByTitle('Screening')).toBeInTheDocument();
    // 80 % over 4 days, unset sibling 0 % over 4 days
    expect(screen.getByTitle('Calculated from children')).toHaveTextContent('40%');
    expect(row(30).firstElementChild).toHaveStyle({ paddingLeft: '40px', width: '320px' });

    fireEvent.click(level);
    expect(useUIStore.getState().scrollToDateTrigger?.date).toBe('2026-03-02');
  });

  it('shows a dash without completion and a single date for a milestone', () => {
    renderRow(milestone);
    expect(screen.getByTitle('Click to set completion')).toHaveTextContent('—');
    // a leaf without assignments cannot be expanded
    expect(row(41).querySelector('button')).toBeDisabled();
  });

  it('marks critical-path items', () => {
    renderRow(leaf, { criticalPathItems: new Set(['subphase-40']) });
    expect(screen.getByTitle('On Critical Path')).toBeInTheDocument();
  });

  it('renders a custom-column cell per column', () => {
    renderRow(leaf, { customColumns: [makeCustomColumn({ id: 1, width: 90 }), makeCustomColumn({ id: 2, width: 60 })] });
    const cells = row(40).lastElementChild!.children;
    expect(Array.from(cells).map((c) => (c as HTMLElement).style.width)).toEqual(['90px', '60px']);
  });
});

describe('SubphaseRow expansion', () => {
  it('expands into nested rows and the subphase assignments', () => {
    renderRow(parent);
    fireEvent.click(row(30).querySelector('button')!);
    expect(useViewStore.getState().expandedSubphases.has(30)).toBe(true);

    expect(screen.getByTitle('Column A')).toBeInTheDocument();
    expect(screen.getAllByTitle('Level 2 - Click to scroll to start date')).toHaveLength(2);
    expect(screen.getByTitle('Bob Brown')).toBeInTheDocument();
    expect(screen.getByText('📌 Screening')).toBeInTheDocument();
    expect(screen.getByTitle('Old rig')).toBeInTheDocument();

    fireEvent.click(row(30).querySelector('button')!);
    expect(screen.queryByTitle('Column A')).not.toBeInTheDocument();
  });

  it('hides assignments when switched off', () => {
    useViewStore.setState({ expandedSubphases: new Set([30]), showAssignments: false });
    renderRow(parent);
    expect(screen.getByTitle('Column A')).toBeInTheDocument();
    expect(screen.queryByTitle('Bob Brown')).not.toBeInTheDocument();
  });

  it('filters nested rows by custom-column values', () => {
    useViewStore.setState({ expandedSubphases: new Set([30]) });
    useCustomColumnStore.setState({
      customColumnFilters: { 4: ['Done'] },
      customColumnValues: { '4-subphase-32': 'Done' },
    });
    renderRow(parent);
    expect(screen.queryByTitle('Column A')).not.toBeInTheDocument();
    expect(screen.getByTitle('Column B')).toBeInTheDocument();
  });

  it('shows the phantom row after its source', () => {
    useViewStore.setState({ expandedSubphases: new Set([30]) });
    useUIStore.setState({
      phantomSiblingMode: {
        projectId: 1,
        sourceId: 31,
        type: 'subphase',
        dependencyType: 'FS',
        phantomStart: '2026-03-07',
        phantomEnd: '2026-03-11',
        phantomColor: '#000',
        siblingDurationDays: 5,
        sourceIndex: 0,
        parentId: 30,
        parentType: 'subphase',
      },
    });
    renderRow(parent);
    expect(screen.getByText('New Subphase')).toBeInTheDocument();
    expect(screen.getByText(/Finish-to-Start/)).toBeInTheDocument();
  });
});

describe('SubphaseRow editing', () => {
  it('opens the editor on double-click and the context menu on right-click', () => {
    renderRow(leaf);
    fireEvent.doubleClick(row(40));
    expect(useUIStore.getState().activeModal).toBe('subphase');
    expect(useUIStore.getState().editingSubphase?.id).toBe(40);

    fireEvent.contextMenu(row(40), { clientX: 12, clientY: 34 });
    expect(useUIStore.getState().contextMenu).toMatchObject({ type: 'subphase', targetId: 40, x: 12, y: 34 });
  });

  it('does not open the slider on a calculated completion', () => {
    renderRow(parent);
    fireEvent.click(screen.getByTitle('Calculated from children'));
    expect(screen.queryByText('Set Completion')).not.toBeInTheDocument();
  });

  it('sets the completion with the slider, quick buttons and Apply', async () => {
    renderRow(leaf);
    fireEvent.click(screen.getByTitle('Click to edit'));
    const slider = screen.getByText('Set Completion').closest('div')!.parentElement as HTMLElement;
    const display = () => slider.querySelector('[class*="valueDisplay"]');
    expect(display()).toHaveTextContent('25%');

    fireEvent.change(within(slider).getByRole('slider'), { target: { value: '62' } });
    // rounded to the 5 % grid
    expect(display()).toHaveTextContent('60%');
    fireEvent.click(within(slider).getByRole('button', { name: '75%' }));
    fireEvent.click(within(slider).getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(updateSubphase).toHaveBeenCalledWith(40, { completion: 75 }));
    await waitFor(() => {
      const updated = useAppStore.getState().projects[0].phases[0].children.find((s) => s.id === 40)!;
      expect(updated.completion).toBe(75);
      expect(updated.status).toBe('in_progress');
    });
    expect(screen.queryByText('Set Completion')).not.toBeInTheDocument();
  });

  it('clears the completion, and closes the slider on Escape or an outside click', async () => {
    renderRow(leaf);
    fireEvent.click(screen.getByTitle('Click to edit'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Set Completion')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Click to edit'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Set Completion')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Click to edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(updateSubphase).toHaveBeenCalledWith(40, { completion: null }));
  });

  it('logs a failed completion save and keeps the tree', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(updateSubphase).mockRejectedValue(new Error('x'));
    renderRow(leaf);
    fireEvent.click(screen.getByTitle('Click to edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(useAppStore.getState().projects[0].phases[0].children.find((s) => s.id === 40)!.completion).toBe(25);
    err.mockRestore();
  });

  it('is read-only for someone who cannot edit the project', () => {
    seed('user');
    renderRow(leaf);
    expect(screen.queryByTitle('Drag to reorder')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Completion'));
    expect(screen.queryByText('Set Completion')).not.toBeInTheDocument();
    fireEvent.doubleClick(row(40));
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('marks the row being dragged for reordering', () => {
    renderRow(leaf);
    const transfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '', types: [] };
    const handle = within(row(40)).getByTitle('Drag to reorder');
    fireEvent.dragStart(handle, { dataTransfer: transfer });
    expect(transfer.setDragImage).toHaveBeenCalled();
    expect(row(40).className).toMatch(/dragging/);
    fireEvent.dragEnd(handle);
    expect(row(40).className).not.toMatch(/dragging/);
  });
});

describe('SubphaseRow per-person booking groups', () => {
  const grouped = makeSubphase({
    id: 30,
    name: 'Screening',
    start_date: '2026-03-02',
    end_date: '2026-03-13',
    staffAssignments: [
      { id: 81, staff_id: 4, allocation: 20, start_date: '2026-03-02', end_date: '2026-03-03', linked: false },
      { id: 82, staff_id: 4, allocation: 50, start_date: '2026-03-09', end_date: '2026-03-10', linked: false },
      { id: 83, staff_id: 6, staff_name: 'Dana Diaz', allocation: 30, start_date: '', end_date: '' },
    ],
  });
  const badges = () => screen.queryAllByText(/^(📌|📍) Screening$/);

  beforeEach(() => {
    useViewStore.setState({ expandedSubphases: new Set([30]), collapsedStaffGroups: new Set() });
  });

  it('groups the person with two bookings, rows one level deeper, singles unchanged', () => {
    renderRow(grouped);
    const toggle = screen.getByRole('button', { name: "Collapse Bob Brown's bookings" });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle.parentElement).toHaveTextContent('ScreeningBob Brown2 bookings20–50%');
    expect(toggle.parentElement).toHaveStyle({ paddingLeft: '76px' }); // like a booking row at depth 3
    const badge = within(toggle.parentElement!).getByText('Screening');
    expect(badge.getAttribute('style')).toBe(badges()[0].getAttribute('style'));
    expect(badges().map((b) => (b.parentElement as HTMLElement).style.paddingLeft)).toEqual(['92px', '92px', '76px']);
    expect(screen.queryByRole('button', { name: /Dana Diaz's bookings/ })).not.toBeInTheDocument();
  });

  it('collapses the group to its overview row', () => {
    renderRow(grouped);
    fireEvent.click(screen.getByRole('button', { name: "Collapse Bob Brown's bookings" }));
    expect(useViewStore.getState().collapsedStaffGroups.has('subphase:30:4')).toBe(true);
    expect(screen.getByRole('button', { name: "Expand Bob Brown's bookings" })).toHaveAttribute('aria-expanded', 'false');
    expect(badges()).toHaveLength(1);
    expect(screen.getByTitle('Dana Diaz')).toBeInTheDocument();
  });
});
