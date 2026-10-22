/**
 * Phase dialog: defaults, validation, create (project expanded and grown to
 * fit), phantom-sibling dependency + order, edit with assigned staff,
 * milestone mode, delete with project shrink, errors and the What-If block.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { PhaseModal } from '../PhaseModal';
import { resetAllStores, useAppStore, useUIStore, useViewStore, useWhatIfStore } from '@/stores';
import {
  createPhase,
  updatePhase,
  deletePhase,
  loadAllProjects,
  updateProject,
} from '@/api/endpoints/projects';
import { makePhase, makeProject, makeUser } from '@/test/factories';
import { stubConfirm } from '@/test/confirmDialog';
import { dateValue, pickDate, pickEnd, pickRange } from '@/test/datePicker';
import type { Project } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createPhase: vi.fn(),
  updatePhase: vi.fn(),
  deletePhase: vi.fn(),
  loadAllProjects: vi.fn(),
  updateProject: vi.fn(),
}));

const design = makePhase({
  id: 10,
  project_id: 1,
  name: 'Design',
  start_date: '2026-02-02',
  end_date: '2026-02-27',
  order_index: 2,
  color: '#abcdef',
  staffAssignments: [
    { id: 1, staff_id: 4, staff_name: 'Bob Brown', allocation: 60, start_date: '', end_date: '' },
    { id: 2, staff_id: 9, allocation: 30, start_date: '', end_date: '' },
  ],
});
const build = makePhase({ id: 11, project_id: 1, name: 'Build', start_date: '2026-03-02', end_date: '2026-04-30' });

function buildProject(): Project {
  return makeProject({ id: 1, start_date: '2026-02-02', end_date: '2026-04-30', phases: [design, build] });
}

const nameInput = () => screen.getByPlaceholderText(/Preparation, Analytics/) as HTMLInputElement;
const rangeValues = () => [dateValue('Start Date *'), dateValue('End Date *')];

function fill(name: string, start?: string, end?: string) {
  fireEvent.change(nameInput(), { target: { value: name } });
  if (start !== undefined && end !== undefined) pickRange('Start Date *', start, end);
}

beforeEach(() => {
  resetAllStores();
  vi.mocked(createPhase).mockReset().mockResolvedValue({} as never);
  vi.mocked(updatePhase).mockReset().mockResolvedValue({} as never);
  vi.mocked(deletePhase).mockReset().mockResolvedValue({} as never);
  vi.mocked(updateProject).mockReset().mockResolvedValue({} as never);
  vi.mocked(loadAllProjects).mockReset().mockResolvedValue([buildProject()]);
  useViewStore.setState({ expandedProjects: new Set() });
  useAppStore.setState({ projects: [buildProject()], currentUser: makeUser() });
});

describe('PhaseModal create', () => {
  it('defaults to the project dates and validates the fields', () => {
    act(() => useUIStore.getState().openPhaseModal(undefined, 1));
    render(<PhaseModal />);
    // The shared Input links each visible label to its control
    expect(screen.getByLabelText('Phase Name *')).toHaveValue('');
    expect(rangeValues()).toEqual(['2026-02-02', '2026-04-30']);

    fireEvent.click(screen.getByRole('button', { name: 'Add Phase' }));
    expect(screen.getByText('Please enter a phase name')).toBeInTheDocument();
    expect(createPhase).not.toHaveBeenCalled();
  });

  it('never lets the end precede the start', async () => {
    act(() => useUIStore.getState().openPhaseModal(undefined, 1));
    render(<PhaseModal />);
    fireEvent.change(nameInput(), { target: { value: 'Early' } });
    // An end picked before the start becomes the new start, keeping the duration
    pickEnd('End Date *', '2026-01-26');
    expect(rangeValues()).toEqual(['2026-01-26', '2026-04-23']);

    fireEvent.click(screen.getByRole('button', { name: 'Add Phase' }));
    await waitFor(() => expect(createPhase).toHaveBeenCalled());
    expect(vi.mocked(createPhase).mock.calls[0][1]).toMatchObject({ start_date: '2026-01-26', end_date: '2026-04-23' });
  });

  it('needs a project', () => {
    act(() => useUIStore.getState().openPhaseModal(undefined));
    render(<PhaseModal />);
    fill('QA');
    fireEvent.click(screen.getByRole('button', { name: 'Add Phase' }));
    expect(screen.getByText('No project selected')).toBeInTheDocument();
  });

  it('creates the phase, expands the project and grows it to fit', async () => {
    act(() => useUIStore.getState().openPhaseModal(undefined, 1));
    render(<PhaseModal />);
    fill('Transfer', '2026-01-19', '2026-05-15');
    fireEvent.click(screen.getByRole('button', { name: 'Add Phase' }));

    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(createPhase).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ name: 'Transfer', start_date: '2026-01-19', end_date: '2026-05-15', is_milestone: false })
    );
    expect(useViewStore.getState().expandedProjects.has(1)).toBe(true);
    expect(updateProject).toHaveBeenCalledWith(1, { start_date: '2026-01-19', end_date: '2026-05-15' });
  });

  it('leaves the project dates alone when the phase fits', async () => {
    act(() => useUIStore.getState().openPhaseModal(undefined, 1));
    render(<PhaseModal />);
    fill('Inside', '2026-03-02', '2026-03-06');
    fireEvent.click(screen.getByRole('button', { name: 'Add Phase' }));
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('links a phantom sibling to its source phase (FS) and orders it after', async () => {
    act(() => {
      useUIStore.setState({
        activeModal: 'phase',
        editingPhase: null,
        modalContext: {
          projectId: 1,
          phantomPreset: { startDate: '2026-03-04', endDate: '2026-03-10', predecessorId: 10, dependencyType: 'FS' },
        },
      });
    });
    render(<PhaseModal />);
    expect(rangeValues()).toEqual(['2026-03-04', '2026-03-10']);
    fill('Follow-up');
    fireEvent.click(screen.getByRole('button', { name: 'Add Phase' }));
    await waitFor(() => expect(createPhase).toHaveBeenCalled());
    const data = vi.mocked(createPhase).mock.calls[0][1];
    expect(data.dependencies).toEqual([{ id: 10, type: 'FS', lag: 4, entity: 'phase' }]);
    expect(data.order_index).toBe(3);
  });

  it('links an SS phantom by start offset and warns when the source is gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(() => {
      useUIStore.setState({
        activeModal: 'phase',
        editingPhase: null,
        modalContext: {
          projectId: 1,
          phantomPreset: { startDate: '2026-02-09', endDate: '2026-02-13', predecessorId: 10, dependencyType: 'SS' },
        },
      });
    });
    const { unmount } = render(<PhaseModal />);
    fill('Parallel');
    fireEvent.click(screen.getByRole('button', { name: 'Add Phase' }));
    await waitFor(() => expect(createPhase).toHaveBeenCalled());
    expect(vi.mocked(createPhase).mock.calls[0][1].dependencies).toEqual([
      { id: 10, type: 'SS', lag: 7, entity: 'phase' },
    ]);
    unmount();

    act(() => {
      useUIStore.setState({
        activeModal: 'phase',
        editingPhase: null,
        modalContext: {
          projectId: 1,
          phantomPreset: { startDate: '2026-02-09', endDate: '2026-02-13', predecessorId: 999, dependencyType: 'SS' },
        },
      });
    });
    render(<PhaseModal />);
    fill('Orphan');
    fireEvent.click(screen.getByRole('button', { name: 'Add Phase' }));
    await waitFor(() => expect(createPhase).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createPhase).mock.calls[1][1].dependencies).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is blocked in What-If mode', () => {
    useWhatIfStore.setState({ whatIfMode: true });
    act(() => useUIStore.getState().openPhaseModal(undefined, 1));
    render(<PhaseModal />);
    expect(screen.getByRole('button', { name: 'Add Phase' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/Adding phases/);
    fill('Blocked');
    fireEvent.submit(nameInput().closest('form')!);
    expect(createPhase).not.toHaveBeenCalled();
  });

  it('shows the API error and stays open', async () => {
    vi.mocked(createPhase).mockRejectedValue(new Error('Duplicate phase'));
    act(() => useUIStore.getState().openPhaseModal(undefined, 1));
    render(<PhaseModal />);
    fill('Design');
    fireEvent.click(screen.getByRole('button', { name: 'Add Phase' }));
    expect(await screen.findByText('Duplicate phase')).toBeInTheDocument();
    expect(useUIStore.getState().activeModal).toBe('phase');
  });
});

describe('PhaseModal edit and delete', () => {
  it('lists assigned staff and saves edits keeping the colour', async () => {
    act(() => useUIStore.getState().openPhaseModal(design, 1));
    render(<PhaseModal />);
    expect(screen.getByText('Edit Phase')).toBeInTheDocument();
    expect(screen.getByText('Assigned Staff')).toBeInTheDocument();
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
    expect(screen.getByText('Staff #9')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();

    fill('Design v2');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(updatePhase).toHaveBeenCalledWith(10, expect.objectContaining({ name: 'Design v2', color: '#abcdef' }));
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('saves a milestone with a single date', async () => {
    act(() => useUIStore.getState().openPhaseModal(build, 1));
    render(<PhaseModal />);
    expect(screen.queryByText('Assigned Staff')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Milestone/ }));
    expect(dateValue('Date *')).toBe('2026-03-02');
    expect(screen.queryByLabelText('Start Date *')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('End Date *')).not.toBeInTheDocument();
    pickDate('Date *', '2026-03-09');
    expect(dateValue('Date *')).toBe('2026-03-09');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updatePhase).toHaveBeenCalled());
    expect(vi.mocked(updatePhase).mock.calls[0][1]).toMatchObject({
      is_milestone: true,
      start_date: '2026-03-09',
      end_date: '2026-03-09',
    });
  });

  it('asks before deleting', async () => {
    const confirm = stubConfirm(false);
    act(() => useUIStore.getState().openPhaseModal(build, 1));
    render(<PhaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Phase' }));
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Are you sure you want to delete this phase? This will also delete all subphases and assignments.',
          destructive: true,
        })
      )
    );
    expect(deletePhase).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeModal).toBe('phase');
  });

  it('deletes and shrinks the project to the remaining phases', async () => {
    stubConfirm(true);
    const remaining = { ...buildProject(), phases: [design] };
    const final = { ...remaining, end_date: '2026-02-27' };
    vi.mocked(loadAllProjects).mockResolvedValueOnce([remaining]).mockResolvedValueOnce([final]);
    act(() => useUIStore.getState().openPhaseModal(build, 1));
    render(<PhaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Phase' }));

    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(deletePhase).toHaveBeenCalledWith(11);
    expect(updateProject).toHaveBeenCalledWith(1, { start_date: '2026-02-02', end_date: '2026-02-27' });
    expect(useAppStore.getState().projects).toEqual([final]);
  });

  it('keeps the reloaded projects when no shrink is needed', async () => {
    stubConfirm(true);
    const remaining = { ...buildProject(), phases: [design, build] };
    vi.mocked(loadAllProjects).mockResolvedValue([remaining]);
    act(() => useUIStore.getState().openPhaseModal(build, 1));
    render(<PhaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Phase' }));
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(updateProject).not.toHaveBeenCalled();
    expect(loadAllProjects).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().projects).toEqual([remaining]);
  });

  it('shows the delete error', async () => {
    stubConfirm(true);
    vi.mocked(deletePhase).mockRejectedValue(new Error('Has bookings'));
    act(() => useUIStore.getState().openPhaseModal(build, 1));
    render(<PhaseModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Phase' }));
    expect(await screen.findByText('Has bookings')).toBeInTheDocument();
  });
});
