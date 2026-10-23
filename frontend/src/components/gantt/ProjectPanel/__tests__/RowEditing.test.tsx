/**
 * Editing from the project tree rows.
 *
 * - F2-6: the completion slider writes completion *and* the status that goes
 *   with it (statusFromCompletion, the mirror of the backend's
 *   apply_completion) into the local tree. The sender gets no broadcast of
 *   its own change, so a stale status left the Kanban card in its old column.
 * - F2-18: custom-column values are self-service (the backend only requires
 *   authentication), so a plain user who cannot edit the project can still
 *   edit them. Definitions stay admin-only (CustomColumnGates.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PhaseRow } from '../PhaseRow';
import { SubphaseRow } from '../SubphaseRow';
import { ReorderProvider } from '@/contexts/ReorderContext';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import type { CustomColumn, Phase, Project, Subphase } from '@/types';
import { makeUser } from '@/test/factories';

const { updatePhase, updateSubphase, setCustomColumnValue } = vi.hoisted(() => ({
  // The update routes answer {success: true}: no status is echoed
  updatePhase: vi.fn().mockResolvedValue({ success: true }),
  updateSubphase: vi.fn().mockResolvedValue({ success: true }),
  setCustomColumnValue: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api')>()),
  updatePhase,
  updateSubphase,
  setCustomColumnValue,
  setCustomColumnValuesBatch: vi.fn().mockResolvedValue([]),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/api/endpoints/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/projects')>()),
  updatePhase,
  updateSubphase,
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

function makeSubphase(overrides: Partial<Subphase> = {}): Subphase {
  return {
    id: 20,
    name: 'DoE setup',
    start_date: '2026-09-01',
    end_date: '2026-09-10',
    color: '#3b82f6',
    order_index: 0,
    completion: 50,
    status: 'in_progress',
    is_milestone: false,
    dependencies: [],
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
    ...overrides,
  } as unknown as Subphase;
}

function makePhase(overrides: Partial<Phase> = {}): Phase {
  return {
    id: 1,
    project_id: 1,
    name: 'Design',
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    color: '#3b82f6',
    order_index: 0,
    completion: 50,
    status: 'in_progress',
    is_milestone: false,
    dependencies: [],
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
    ...overrides,
  } as unknown as Phase;
}

function makeProject(phases: Phase[]): Project {
  return {
    id: 1,
    name: 'Bioprocess Scale-Up',
    site_id: 1,
    pm_id: 42,
    confirmed: true,
    archived: false,
    phases,
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Project;
}

const column: CustomColumn = {
  id: 3,
  name: 'Owner',
  column_type: 'text',
  list_options: null,
  site_id: null,
  display_order: 0,
  width: 120,
} as unknown as CustomColumn;

function renderPhase(phase: Phase, customColumns: CustomColumn[] = []) {
  return render(
    <ReorderProvider>
      <PhaseRow phase={phase} projectId={1} depth={0} phases={[phase]} customColumns={customColumns} nameColumnWidth={320} />
    </ReorderProvider>
  );
}

function renderSubphase(subphase: Subphase) {
  return render(
    <ReorderProvider>
      <SubphaseRow
        subphase={subphase}
        phaseId={1}
        projectId={1}
        depth={1}
        siblings={[subphase]}
        parentId={1}
        parentType="phase"
        nameColumnWidth={320}
      />
    </ReorderProvider>
  );
}

/** Open the badge's slider, pick a quick value and apply it */
async function setCompletion(badgeText: string, quick: string) {
  fireEvent.click(screen.getByText(badgeText));
  fireEvent.click(screen.getByRole('button', { name: quick }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useViewStore.setState({ expandedPhases: new Set(), expandedSubphases: new Set() });
  useCustomColumnStore.setState({ customColumns: [], customColumnValues: {}, customColumnFilters: {} });
});

describe('completion slider keeps status in step', () => {
  it('moves a phase to done when it is set to 100%', async () => {
    const phase = makePhase();
    useAppStore.setState({ projects: [makeProject([phase])], currentUser: makeUser({ id: 1, role: 'admin' }) });
    renderPhase(phase);

    await setCompletion('50%', '100%');

    expect(updatePhase).toHaveBeenCalledWith(1, { completion: 100 });
    const stored = useAppStore.getState().projects[0].phases[0];
    expect(stored).toMatchObject({ completion: 100, status: 'done' });
  });

  it('moves a subphase back to todo at 0% and keeps blocked while in progress', async () => {
    const sub = makeSubphase();
    useAppStore.setState({
      projects: [makeProject([makePhase({ children: [sub] })])],
      currentUser: makeUser({ id: 1, role: 'admin' }),
    });
    const { unmount } = renderSubphase(sub);

    await setCompletion('50%', '0%');

    expect(updateSubphase).toHaveBeenCalledWith(20, { completion: 0 });
    expect(useAppStore.getState().projects[0].phases[0].children[0]).toMatchObject({ completion: 0, status: 'todo' });
    unmount();

    // A blocked card stays blocked when its completion changes in between
    const blocked = makeSubphase({ status: 'blocked', completion: 25 });
    useAppStore.setState({ projects: [makeProject([makePhase({ children: [blocked] })])] });
    renderSubphase(blocked);
    await setCompletion('25%', '75%');
    expect(useAppStore.getState().projects[0].phases[0].children[0]).toMatchObject({ completion: 75, status: 'blocked' });
  });

  it('prefers a status echoed by the server', async () => {
    updatePhase.mockResolvedValueOnce({ status: 'blocked' });
    const phase = makePhase();
    useAppStore.setState({ projects: [makeProject([phase])], currentUser: makeUser({ id: 1, role: 'admin' }) });
    renderPhase(phase);

    await setCompletion('50%', '75%');

    expect(useAppStore.getState().projects[0].phases[0]).toMatchObject({ completion: 75, status: 'blocked' });
  });
});

describe('custom-column values for a plain user', () => {
  it('can be edited by a user who cannot edit the project', async () => {
    const phase = makePhase();
    useAppStore.setState({ projects: [makeProject([phase])], currentUser: makeUser({ id: 43, role: 'user' }) });
    const { container } = renderPhase(phase, [column]);

    // The project itself stays read-only for this user
    expect(screen.queryByTitle('Drag to reorder')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Click to edit'));
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, { target: { value: 'Ada' } });
    await act(async () => {
      fireEvent.blur(input);
    });

    expect(setCustomColumnValue).toHaveBeenCalledWith({
      custom_column_id: 3,
      entity_type: 'phase',
      entity_id: 1,
      value: 'Ada',
    });
    expect(useCustomColumnStore.getState().customColumnValues['3-phase-1']).toBe('Ada');
  });

  it('stays read-only without a signed-in user', () => {
    const phase = makePhase();
    useAppStore.setState({ projects: [makeProject([phase])], currentUser: null });
    const { container } = renderPhase(phase, [column]);

    fireEvent.click(screen.getByTitle('Click to edit'));
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });
});
