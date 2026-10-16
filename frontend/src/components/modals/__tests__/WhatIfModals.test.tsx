/**
 * Dialogs in What-If mode.
 *
 * Writes are only queued while What-If is active and loadAllProjects() is a
 * no-op (it returns the local projects), so:
 *   - creating is blocked: a queued POST has no server id and the new item
 *     could only appear after Apply;
 *   - editing stays allowed and must show up in the store right away, as a
 *     local change, not via a reload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { PhaseModal } from '../PhaseModal';
import { SubphaseModal } from '../SubphaseModal';
import { AssignmentModal } from '../AssignmentModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import {
  createPhase,
  createSubphase,
  createStaffAssignment,
  updatePhase,
  updateStaffAssignment,
} from '@/api/endpoints/projects';
import type { Phase, Project, Subphase } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createPhase: vi.fn().mockResolvedValue({}),
  updatePhase: vi.fn().mockResolvedValue({}),
  deletePhase: vi.fn().mockResolvedValue({}),
  createSubphase: vi.fn().mockResolvedValue({}),
  createChildSubphase: vi.fn().mockResolvedValue({}),
  updateSubphase: vi.fn().mockResolvedValue({}),
  deleteSubphase: vi.fn().mockResolvedValue({}),
  updateProject: vi.fn().mockResolvedValue({}),
  createStaffAssignment: vi.fn().mockResolvedValue({}),
  updateStaffAssignment: vi.fn().mockResolvedValue({}),
  deleteStaffAssignment: vi.fn().mockResolvedValue({}),
  createEquipmentAssignment: vi.fn().mockResolvedValue({}),
  updateEquipmentAssignment: vi.fn().mockResolvedValue({}),
  deleteEquipmentAssignment: vi.fn().mockResolvedValue({}),
  // What-If behaviour of the real function: hand back the local projects.
  loadAllProjects: vi.fn(async () => (await import('@/stores/appStore')).useAppStore.getState().projects),
}));

const BLOCKED = /is unavailable while What-If mode is active\. Apply or discard your What-If changes first\./;

const subphase = {
  id: 20,
  name: 'Setup',
  start_date: '2026-09-02',
  end_date: '2026-09-05',
  is_milestone: false,
  parent_phase_id: 10,
  parent_subphase_id: null,
  children: [],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Subphase;

const phase = {
  id: 10,
  name: 'Design',
  project_id: 1,
  start_date: '2026-09-01',
  end_date: '2026-09-30',
  is_milestone: false,
  children: [subphase],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Phase;

const project = {
  id: 1,
  name: 'Bioprocess Scale-Up',
  site_id: 1,
  pm_id: null,
  confirmed: true,
  archived: false,
  start_date: '2026-09-01',
  end_date: '2026-12-31',
  phases: [phase],
  staffAssignments: [
    { id: 11, staff_id: 4, staff_name: 'Bob Brown', allocation: 50, start_date: '2026-09-01', end_date: '2026-09-14' },
  ],
  equipmentAssignments: [],
} as unknown as Project;

const storedProject = () => useAppStore.getState().projects.find((p) => p.id === 1)!;

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.getState().closeModal();
  useUIStore.setState({ editingStaffAssignment: null });
  useAppStore.setState({
    projects: [structuredClone(project)],
    currentSite: { id: 1, name: 'Basel' } as never,
    staff: [{ id: 4, name: 'Bob Brown', site_id: 1, active: true, max_capacity: 100 }] as never,
    currentUser: { id: 1, name: 'Ada Admin', role: 'admin' } as never,
  });
  useWhatIfStore.setState({ whatIfMode: true });
});

describe('PhaseModal in What-If mode', () => {
  it('blocks creating a phase', () => {
    act(() => useUIStore.getState().openPhaseModal(undefined, 1));
    render(<PhaseModal />);

    expect(screen.getByRole('status')).toHaveTextContent(BLOCKED);
    expect(screen.getByRole('status')).toHaveTextContent(/^Adding phases/);
    const add = screen.getByRole('button', { name: 'Add Phase' });
    expect(add).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/Preparation, Analytics/), { target: { value: 'Trial' } });
    fireEvent.submit(document.body.querySelector('form')!);
    expect(createPhase).not.toHaveBeenCalled();
  });

  it('allows creating again once What-If ends', () => {
    useWhatIfStore.setState({ whatIfMode: false });
    act(() => useUIStore.getState().openPhaseModal(undefined, 1));
    render(<PhaseModal />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Phase' })).toBeEnabled();
  });

  it('allows editing and shows the edit in the store right away', async () => {
    act(() => useUIStore.getState().openPhaseModal(phase, 1));
    render(<PhaseModal />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Preparation, Analytics/), { target: { value: 'Design v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(updatePhase).toHaveBeenCalledWith(10, expect.objectContaining({ name: 'Design v2' }));
    expect(storedProject().phases[0].name).toBe('Design v2');
    // The edit replaced the project object instead of mutating the store in place.
    expect(project.phases[0].name).toBe('Design');
  });
});

describe('SubphaseModal in What-If mode', () => {
  it('blocks creating a subphase', () => {
    act(() => useUIStore.getState().openSubphaseModal(undefined, 10, 1));
    render(<SubphaseModal />);

    expect(screen.getByRole('status')).toHaveTextContent(BLOCKED);
    expect(screen.getByRole('button', { name: 'Add Subphase' })).toBeDisabled();
    fireEvent.submit(document.body.querySelector('form')!);
    expect(createSubphase).not.toHaveBeenCalled();
  });
});

describe('AssignmentModal in What-If mode', () => {
  it('blocks creating an assignment', () => {
    act(() => useUIStore.getState().openModal('staffAssignment', { projectId: 1 }));
    render(<AssignmentModal mode="staff" />);

    expect(screen.getByRole('status')).toHaveTextContent(/^Assigning staff/);
    expect(screen.getByRole('button', { name: 'Assign Staff' })).toBeDisabled();
    fireEvent.submit(document.body.querySelector('form')!);
    expect(createStaffAssignment).not.toHaveBeenCalled();
  });

  it('allows editing an assignment and shows it in the store right away', async () => {
    act(() => {
      useUIStore.getState().setEditingStaffAssignment({
        id: 11,
        project_id: 1,
        phase_id: null,
        subphase_id: null,
        staff_id: 4,
        staff_name: 'Bob Brown',
        allocation: 50,
        start_date: '2026-09-01',
        end_date: '2026-09-14',
      });
      useUIStore.getState().openModal('staffAssignment', { projectId: 1 });
    });
    render(<AssignmentModal mode="staff" />);

    const [, end] = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    fireEvent.change(end, { target: { value: '2026-09-21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(updateStaffAssignment).toHaveBeenCalledWith(
      11,
      expect.objectContaining({ end_date: '2026-09-21' }),
      'project'
    );
    expect(storedProject().staffAssignments[0]).toMatchObject({ id: 11, end_date: '2026-09-21', allocation: 50 });
  });
});
