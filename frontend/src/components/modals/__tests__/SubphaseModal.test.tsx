/**
 * Subphase dialog: validation, create under a phase or under another
 * subphase (with upward date cascade to parent subphases, the phase and the
 * project), phantom-sibling presets (dependency lag + order), edit, milestone
 * mode, delete with downward "shrink" cascade, errors and the What-If block.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
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
import { stubConfirm } from '@/test/confirmDialog';
import { dateValue, openDateField, pickDate, pickEnd, pickRange } from '@/test/datePicker';
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

const nameInput = () => screen.getByPlaceholderText(/Task 1, Setup/) as HTMLInputElement;
const rangeValues = () => [dateValue('Start Date *'), dateValue('End Date *')];

function fill(name: string, range?: [start: string, end: string]) {
  fireEvent.change(nameInput(), { target: { value: name } });
  if (range) pickRange('Start Date *', ...range);
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
  it('starts a new subphase with empty dates, opens the picker on the current month and validates the fields', () => {
    openNew({ phaseId: 10, projectId: 1 });
    render(<SubphaseModal />);
    expect(screen.getByText('Feasibility')).toBeInTheDocument();
    // The shared Input links each visible label to its control
    expect(screen.getByLabelText('Subphase Name *')).toHaveValue('');
    expect(rangeValues()).toEqual(['', '']);
    const panel = openDateField('Start Date *');
    expect(within(panel).getAllByRole('combobox', { name: 'Choose the Month' })[0]).toHaveValue(
      String(new Date().getMonth())
    );
    expect(within(panel).getAllByRole('combobox', { name: 'Choose the Year' })[0]).toHaveValue(
      String(new Date().getFullYear())
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    expect(screen.getByText('Please enter a subphase name')).toBeInTheDocument();
    expect(createSubphase).not.toHaveBeenCalled();
  });

  it('asks for the dates in place, like the name, and sends nothing', () => {
    openNew({ phaseId: 10, projectId: 1 });
    render(<SubphaseModal />);
    fill('Report');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    expect(screen.getByText('Please enter a start and an end date')).toBeInTheDocument();
    expect(createSubphase).not.toHaveBeenCalled();
    // The button is not disabled for it: the message is the feedback
    expect(screen.getByRole('button', { name: 'Add Subphase' })).toBeEnabled();

    // A start alone is not enough for a subphase
    pickDate('Start Date *', '2026-02-03');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    expect(screen.getByText('Please enter a start and an end date')).toBeInTheDocument();
    expect(createSubphase).not.toHaveBeenCalled();
  });

  it('needs only the date for a milestone', async () => {
    openNew({ phaseId: 10, projectId: 1 });
    render(<SubphaseModal />);
    fill('Sign-off');
    fireEvent.click(screen.getByRole('switch', { name: /Milestone/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    expect(screen.getByText('Please enter the milestone date')).toBeInTheDocument();
    expect(createSubphase).not.toHaveBeenCalled();

    pickDate('Date *', '2026-02-18');
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    await waitFor(() => expect(createSubphase).toHaveBeenCalled());
    expect(vi.mocked(createSubphase).mock.calls[0][2]).toMatchObject({
      start_date: '2026-02-18',
      end_date: '2026-02-18',
      is_milestone: true,
    });
  });

  // The rule itself is proven in dateRangeLogic.test; this guards the form's payload wiring
  it('never lets the end precede the start', async () => {
    openNew({ phaseId: 10, projectId: 1 });
    render(<SubphaseModal />);
    fill('Early', ['2026-02-02', '2026-02-27']);
    // An end picked before the start becomes the new start, keeping the duration
    pickEnd('End Date *', '2026-01-28');
    expect(rangeValues()).toEqual(['2026-01-28', '2026-02-22']);

    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    await waitFor(() => expect(createSubphase).toHaveBeenCalled());
    expect(vi.mocked(createSubphase).mock.calls[0][2]).toMatchObject({ start_date: '2026-01-28', end_date: '2026-02-22' });
  });

  it('refuses to save without a parent phase', () => {
    openNew({ projectId: 1 });
    render(<SubphaseModal />);
    fill('Orphan', ['2026-02-03', '2026-02-10']);
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
    fill('Report', ['2026-02-20', '2026-07-15']);
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
    fill('Inside', ['2026-02-03', '2026-02-10']);
    fireEvent.click(screen.getByRole('button', { name: 'Add Subphase' }));
    await waitFor(() => expect(createSubphase).toHaveBeenCalled());
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(updatePhase).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('creates a nested subphase and grows every parent subphase on the way up', async () => {
    openNew({ phaseId: 10, projectId: 1, subphaseId: 21 });
    render(<SubphaseModal />);
    fill('Deeper', ['2026-01-30', '2026-02-20']);
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
    expect(rangeValues()).toEqual(['2026-02-17', '2026-02-20']);
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
    fill('Report', ['2026-02-03', '2026-02-10']);
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
    fill('Screening v2', ['2026-02-03', '2026-02-13']);
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
    fireEvent.click(screen.getByRole('switch', { name: /Milestone/ }));
    expect(dateValue('Date *')).toBe('2026-02-16');
    expect(screen.queryByLabelText('Start Date *')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('End Date *')).not.toBeInTheDocument();
    pickDate('Date *', '2026-02-18');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateSubphase).toHaveBeenCalled());
    expect(vi.mocked(updateSubphase).mock.calls[0][1]).toMatchObject({
      is_milestone: true,
      start_date: '2026-02-18',
      end_date: '2026-02-18',
    });
  });

  it('does nothing when the delete is not confirmed', async () => {
    const confirm = stubConfirm(false);
    openEdit();
    render(<SubphaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Subphase' }));
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'Are you sure you want to delete this subphase? This will also delete all nested subphases and assignments.',
          destructive: true,
        })
      )
    );
    expect(deleteSubphase).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeModal).toBe('subphase');
  });

  it('deletes and shrinks the phase and project to the remaining children', async () => {
    stubConfirm(true);
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
  });

  it('shrinks the parent subphase when a nested subphase is deleted', async () => {
    stubConfirm(true);
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
  });

  it('keeps the dialog open with the error when the delete fails', async () => {
    stubConfirm(true);
    vi.mocked(deleteSubphase).mockRejectedValue(new Error('Locked'));
    openEdit();
    render(<SubphaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Subphase' }));
    expect(await screen.findByText('Locked')).toBeInTheDocument();
    expect(useUIStore.getState().activeModal).toBe('subphase');
  });

  it('closes via Cancel without saving', () => {
    openEdit();
    render(<SubphaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useUIStore.getState().activeModal).toBeNull();
    expect(updateSubphase).not.toHaveBeenCalled();
  });
});
