/**
 * Subphase dialog: validation, create under a phase or under another
 * subphase (with upward date cascade to parent subphases, the phase and the
 * project), phantom-sibling presets (dependency lag + order), edit, milestone
 * mode, delete with downward "shrink" cascade, errors and the What-If block.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SubphaseModal } from '../SubphaseModal';
import { resetAllStores, useAppStore, useUIStore, useViewStore, useWhatIfStore } from '@/stores';
import {
  createSubphase,
  createChildSubphase,
  updateSubphase,
  deleteSubphase,
  loadAllProjects,
  updatePhase,
  updateProject,
} from '@/api/endpoints/projects';
import { makePhase, makeProject, makeSubphase, makeUser } from '@/test/factories';
import type { Project } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createSubphase: vi.fn(),
  createChildSubphase: vi.fn(),
  updateSubphase: vi.fn(),
  deleteSubphase: vi.fn(),
  loadAllProjects: vi.fn(),
  updatePhase: vi.fn(),
  updateProject: vi.fn(),
}));

const grandchild = makeSubphase({
  id: 21,
  name: 'Buffer prep',
  parent_phase_id: 10,
  parent_subphase_id: 20,
  start_date: '2026-02-02',
  end_date: '2026-02-06',
});
const screening = makeSubphase({
  id: 20,
  name: 'Screening',
  parent_phase_id: 10,
  start_date: '2026-02-02',
  end_date: '2026-02-13',
  order_index: 3,
  color: '#123456',
  children: [grandchild],
});
const trials = makeSubphase({
  id: 22,
  name: 'Trials',
  parent_phase_id: 10,
  start_date: '2026-02-16',
  end_date: '2026-02-27',
});

function buildProject(): Project {
  return makeProject({
    id: 1,
    start_date: '2026-01-05',
    end_date: '2026-06-30',
    phases: [
      makePhase({
        id: 10,
        name: 'Feasibility',
        start_date: '2026-02-02',
        end_date: '2026-02-27',
        children: [screening, trials],
      }),
    ],
  });
}

const dateInputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="date"]'));
const nameInput = () => screen.getByPlaceholderText(/Task 1, Setup/) as HTMLInputElement;

function fill(name: string, start?: string, end?: string) {
  fireEvent.change(nameInput(), { target: { value: name } });
  const [s, e] = dateInputs();
  if (start !== undefined) fireEvent.change(s, { target: { value: start } });
  if (end !== undefined) fireEvent.change(e, { target: { value: end } });
}

function openNew(context: Record<string, unknown>) {
  act(() => {
    useUIStore.setState({ activeModal: 'subphase', editingSubphase: null, modalContext: context });
  });
}

beforeEach(() => {
  resetAllStores();
  vi.mocked(createSubphase).mockReset().mockResolvedValue({} as never);
  vi.mocked(createChildSubphase).mockReset().mockResolvedValue({} as never);
  vi.mocked(updateSubphase).mockReset().mockResolvedValue({} as never);
  vi.mocked(deleteSubphase).mockReset().mockResolvedValue({} as never);
  vi.mocked(updatePhase).mockReset().mockResolvedValue({} as never);
  vi.mocked(updateProject).mockReset().mockResolvedValue({} as never);
  vi.mocked(loadAllProjects).mockReset().mockResolvedValue([buildProject()]);
  useViewStore.setState({ expandedPhases: new Set(), expandedSubphases: new Set() });
  useAppStore.setState({ projects: [buildProject()], currentUser: makeUser() });
});

describe('SubphaseModal validation', () => {
  it('defaults a new subphase to the parent phase dates and validates the fields', () => {
    openNew({ phaseId: 10, projectId: 1 });
    render(<SubphaseModal />);
    expect(screen.getByText('Feasibility')).toBeInTheDocument();
    expect(dateInputs().map((i) => i.value)).toEqual(['2026-02-02', '2026-02-27']);

    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    expect(screen.getByText('Please enter a subphase name')).toBeInTheDocument();

    fill('Analysis', '', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    expect(screen.getByText('Please select a start date')).toBeInTheDocument();

    fill('Analysis', '2026-02-03', '');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    expect(screen.getByText('Please select an end date')).toBeInTheDocument();
    expect(createSubphase).not.toHaveBeenCalled();
  });

  it('refuses to save without a parent phase', () => {
    openNew({ projectId: 1 });
    render(<SubphaseModal />);
    fill('Orphan');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    expect(screen.getByText('No parent phase selected')).toBeInTheDocument();
  });

  it('is blocked for new subphases in What-If mode', () => {
    useWhatIfStore.setState({ whatIfMode: true });
    openNew({ phaseId: 10, projectId: 1 });
    render(<SubphaseModal />);
    const add = screen.getByRole('button', { name: 'Add Subphase' });
    expect(add).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Adding subphases/);
    fill('Blocked');
    fireEvent.submit(nameInput().closest('form')!);
    expect(createSubphase).not.toHaveBeenCalled();
  });
});

describe('SubphaseModal create', () => {
  it('creates under the phase, expands it and grows the phase and the project', async () => {
    openNew({ phaseId: 10, projectId: 1 });
    render(<SubphaseModal />);
    fill('Report', '2026-02-20', '2026-07-15');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));

    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(createSubphase).toHaveBeenCalledWith(
      10,
      1,
      expect.objectContaining({
        name: 'Report',
        start_date: '2026-02-20',
        end_date: '2026-07-15',
        is_milestone: false,
        color: expect.any(String),
      })
    );
    expect(useViewStore.getState().expandedPhases.has(10)).toBe(true);
    expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-02-02', end_date: '2026-07-15' });
    expect(updateProject).toHaveBeenCalledWith(1, { start_date: '2026-01-05', end_date: '2026-07-15' });
    expect(loadAllProjects).toHaveBeenCalled();
  });

  it('does not touch the parents when the new subphase fits inside them', async () => {
    openNew({ phaseId: 10, projectId: 1 });
    render(<SubphaseModal />);
    fill('Inside', '2026-02-03', '2026-02-10');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    await waitFor(() => expect(createSubphase).toHaveBeenCalled());
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(updatePhase).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('creates a nested subphase and grows every parent subphase on the way up', async () => {
    openNew({ phaseId: 10, projectId: 1, subphaseId: 21 });
    render(<SubphaseModal />);
    fill('Deeper', '2026-01-30', '2026-02-20');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));

    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(createChildSubphase).toHaveBeenCalledWith(21, 1, expect.objectContaining({ name: 'Deeper' }));
    expect(useViewStore.getState().expandedSubphases.has(21)).toBe(true);
    expect(updateSubphase).toHaveBeenCalledWith(21, { start_date: '2026-01-30', end_date: '2026-02-20' });
    expect(updateSubphase).toHaveBeenCalledWith(20, { start_date: '2026-01-30', end_date: '2026-02-20' });
    expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-01-30', end_date: '2026-02-27' });
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('adds a finish-to-start dependency on the phantom source and inserts after it', async () => {
    openNew({
      phaseId: 10,
      projectId: 1,
      phantomPreset: { startDate: '2026-02-17', endDate: '2026-02-20', predecessorId: 20, dependencyType: 'FS' },
    });
    render(<SubphaseModal />);
    expect(dateInputs().map((i) => i.value)).toEqual(['2026-02-17', '2026-02-20']);
    fill('Follow-up');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    await waitFor(() => expect(createSubphase).toHaveBeenCalled());
    const data = vi.mocked(createSubphase).mock.calls[0][2];
    // Screening ends Feb 13 -> FS lag counts from Feb 14
    expect(data.dependencies).toEqual([{ id: 20, type: 'FS', lag: 3, entity: 'subphase' }]);
    expect(data.order_index).toBe(4);
  });

  it('measures a start-to-start lag from the source start', async () => {
    openNew({
      phaseId: 10,
      projectId: 1,
      phantomPreset: { startDate: '2026-02-09', endDate: '2026-02-12', predecessorId: 20, dependencyType: 'SS' },
    });
    render(<SubphaseModal />);
    fill('Parallel');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    await waitFor(() => expect(createSubphase).toHaveBeenCalled());
    expect(vi.mocked(createSubphase).mock.calls[0][2].dependencies).toEqual([
      { id: 20, type: 'SS', lag: 7, entity: 'subphase' },
    ]);
  });

  it('shows the API error and stays open', async () => {
    vi.mocked(createSubphase).mockRejectedValue(new Error('Server says no'));
    openNew({ phaseId: 10, projectId: 1 });
    render(<SubphaseModal />);
    fill('Report');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    expect(await screen.findByText('Server says no')).toBeInTheDocument();
    expect(useUIStore.getState().activeModal).toBe('subphase');
  });
});

describe('SubphaseModal edit and delete', () => {
  function openEdit(subphase = trials) {
    act(() => useUIStore.getState().openSubphaseModal(subphase, 10, 1));
  }

  it('saves edits, keeping the colour, and patches the local tree', async () => {
    openEdit(screening);
    render(<SubphaseModal />);
    expect(screen.getByText('Edit Subphase')).toBeInTheDocument();
    fill('Screening v2', '2026-02-03');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(updateSubphase).toHaveBeenCalledWith(
      20,
      expect.objectContaining({ name: 'Screening v2', start_date: '2026-02-03', color: '#123456' })
    );
    expect(createSubphase).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('turns into a single-date milestone', async () => {
    openEdit();
    render(<SubphaseModal />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('Date *')).toBeInTheDocument();
    expect(dateInputs()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateSubphase).toHaveBeenCalled());
    expect(vi.mocked(updateSubphase).mock.calls[0][1]).toMatchObject({
      is_milestone: true,
      start_date: '2026-02-16',
      end_date: '2026-02-16',
    });
  });

  it('does nothing when the delete is not confirmed', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    openEdit();
    render(<SubphaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Subphase' }));
    expect(deleteSubphase).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('deletes and shrinks the phase and project to the remaining children', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const afterDelete = buildProject();
    afterDelete.phases[0].children = [{ ...screening, children: [] }];
    const final = buildProject();
    vi.mocked(loadAllProjects).mockResolvedValueOnce([afterDelete]).mockResolvedValueOnce([final]);
    openEdit();
    render(<SubphaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Subphase' }));

    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(deleteSubphase).toHaveBeenCalledWith(22);
    expect(updatePhase).toHaveBeenCalledWith(10, { start_date: '2026-02-02', end_date: '2026-02-13' });
    expect(updateProject).toHaveBeenCalledWith(1, { start_date: '2026-02-02', end_date: '2026-02-13' });
    expect(loadAllProjects).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().projects).toEqual([final]);
    confirm.mockRestore();
  });

  it('shrinks the parent subphase when a nested subphase is deleted', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const afterDelete = buildProject();
    afterDelete.phases[0].children = [
      { ...screening, children: [{ ...grandchild, start_date: '2026-02-04', end_date: '2026-02-05' }] },
      trials,
    ];
    vi.mocked(loadAllProjects).mockResolvedValue([afterDelete]);
    const doomed = { ...grandchild, id: 23, start_date: '2026-02-09', end_date: '2026-02-13' };
    const before = buildProject();
    before.phases[0].children = [{ ...screening, children: [grandchild, doomed] }, trials];
    useAppStore.setState({ projects: [before] });
    act(() => useUIStore.getState().openSubphaseModal(doomed, 10, 1));
    render(<SubphaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Subphase' }));
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(updateSubphase).toHaveBeenCalledWith(20, { start_date: '2026-02-04', end_date: '2026-02-05' });
    confirm.mockRestore();
  });

  it('keeps the dialog open with the error when the delete fails', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deleteSubphase).mockRejectedValue(new Error('Locked'));
    openEdit();
    render(<SubphaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Subphase' }));
    expect(await screen.findByText('Locked')).toBeInTheDocument();
    expect(useUIStore.getState().activeModal).toBe('subphase');
    confirm.mockRestore();
  });

  it('closes via Cancel without saving', () => {
    openEdit();
    render(<SubphaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(updateSubphase).not.toHaveBeenCalled();
  });
});
