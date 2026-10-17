/**
 * Who the staff-assignment dialog lets you book (utils/permissions.ts).
 *
 * A project's editors -- admins, superusers and its manager -- pick anyone on
 * the site. Everyone else may only book their own time: the picker is fixed to
 * them, the allocation starts at their capacity, and only their own booking
 * can be removed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AssignmentModal } from '../AssignmentModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { createStaffAssignment } from '@/api/endpoints/projects';
import type { Project } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createStaffAssignment: vi.fn().mockResolvedValue({}),
  updateStaffAssignment: vi.fn().mockResolvedValue({}),
  deleteStaffAssignment: vi.fn().mockResolvedValue({}),
  createEquipmentAssignment: vi.fn().mockResolvedValue({}),
  updateEquipmentAssignment: vi.fn().mockResolvedValue({}),
  deleteEquipmentAssignment: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

const project = {
  id: 1,
  name: 'Bioprocess Scale-Up',
  site_id: 1,
  pm_id: 42,
  confirmed: true,
  archived: false,
  start_date: '2026-09-01',
  end_date: '2026-12-31',
  phases: [],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

function seed(user: { id: number; role: 'admin' | 'superuser' | 'user'; name?: string }) {
  useAppStore.setState({
    projects: [project],
    currentSite: { id: 1, name: 'Basel' } as never,
    staff: [
      { id: 7, name: 'Alice Anderson', site_id: 1, active: true, max_capacity: 60 },
      { id: 4, name: 'Bob Brown', site_id: 1, active: true },
    ] as never,
    currentUser: { name: 'Someone', ...user } as never,
  });
}

function openForProject() {
  useUIStore.setState({ editingStaffAssignment: null });
  useUIStore.getState().openModal('staffAssignment', { projectId: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AssignmentModal picker', () => {
  it('is fixed to "You" for someone who does not manage the project', async () => {
    seed({ id: 7, role: 'user', name: 'Alice Anderson' });
    openForProject();
    render(<AssignmentModal mode="staff" />);

    const picker = screen.getByLabelText('Staff Member') as HTMLInputElement;
    expect(picker.tagName).toBe('INPUT');
    expect(picker).toHaveValue('You');
    expect(picker).toHaveAttribute('readonly');

    // Allocation starts at the person's own capacity, not a flat 100.
    expect(screen.getByText('60%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Assign me' }));
    await waitFor(() => expect(createStaffAssignment).toHaveBeenCalled());
    expect(vi.mocked(createStaffAssignment).mock.calls[0][0]).toMatchObject({
      staff_id: 7,
      allocation: 60,
      project_id: 1,
    });
  });

  it('lets the project manager pick anyone on the site', () => {
    seed({ id: 42, role: 'user' });
    openForProject();
    render(<AssignmentModal mode="staff" />);

    const picker = screen.getByLabelText('Staff Member') as HTMLSelectElement;
    expect(picker.tagName).toBe('SELECT');
    expect(screen.getByRole('option', { name: /Alice Anderson/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Bob Brown/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign Staff' })).toBeInTheDocument();
  });

  it('lets superusers pick anyone, as before', () => {
    seed({ id: 99, role: 'superuser' });
    openForProject();
    render(<AssignmentModal mode="staff" />);
    expect((screen.getByLabelText('Staff Member') as HTMLElement).tagName).toBe('SELECT');
  });

  it('lists the site equipment with its type in equipment mode', () => {
    seed({ id: 99, role: 'superuser' });
    useAppStore.setState({
      equipment: [
        { id: 11, name: 'Bioreactor', type: 'Reactor', site_id: 1 },
        { id: 12, name: 'Scale', type: '', site_id: 1 },
        { id: 13, name: 'Elsewhere', type: 'HPLC', site_id: 2 },
      ] as never,
    });
    useUIStore.setState({ editingEquipmentAssignment: null });
    useUIStore.getState().openModal('equipmentAssignment', { projectId: 1 });
    render(<AssignmentModal mode="equipment" />);

    const picker = screen.getByLabelText('Equipment');
    expect(screen.getByRole('option', { name: 'Bioreactor (Reactor)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Scale (No type)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Elsewhere/ })).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: '11' } });
    expect(picker).toHaveValue('11');
    expect(screen.getByRole('button', { name: 'Assign Equipment' })).toBeInTheDocument();
  });
});

describe('AssignmentModal remove button', () => {
  function openEditing(staffId: number) {
    useUIStore.getState().setEditingStaffAssignment({
      id: 11,
      project_id: 1,
      phase_id: null,
      subphase_id: null,
      staff_id: staffId,
      staff_name: 'Bob Brown',
      allocation: 50,
      start_date: '2026-09-01',
      end_date: '2026-09-14',
    });
    useUIStore.getState().openModal('staffAssignment', { projectId: 1 });
  }

  it('is shown to a plain user for their own booking only', () => {
    seed({ id: 4, role: 'user' });
    openEditing(4);
    render(<AssignmentModal mode="staff" />);
    expect(screen.getByRole('button', { name: 'Remove Assignment' })).toBeInTheDocument();
  });

  it('is hidden from a plain user on someone else\'s booking', () => {
    seed({ id: 7, role: 'user' });
    openEditing(4);
    render(<AssignmentModal mode="staff" />);
    expect(screen.queryByRole('button', { name: 'Remove Assignment' })).not.toBeInTheDocument();
  });

  it('is shown to the project manager for anyone', () => {
    seed({ id: 42, role: 'user' });
    openEditing(4);
    render(<AssignmentModal mode="staff" />);
    expect(screen.getByRole('button', { name: 'Remove Assignment' })).toBeInTheDocument();
  });
});

describe('AssignmentModal initialisation', () => {
  // The dialog renders in a portal, outside the render container
  const dateInputs = () =>
    Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="date"]'));

  it('keeps what the user typed when staff is refetched while open', () => {
    seed({ id: 7, role: 'user', name: 'Alice Anderson' });
    openForProject();
    render(<AssignmentModal mode="staff" />);

    const [start] = dateInputs();
    expect(start).toHaveValue('2026-09-01');
    fireEvent.change(start, { target: { value: '2026-10-05' } });

    // A WebSocket refetch replaces the staff list (new array, new capacity)
    act(() => {
      useAppStore.setState({
        staff: [
          { id: 7, name: 'Alice Anderson', site_id: 1, active: true, max_capacity: 80 },
          { id: 4, name: 'Bob Brown', site_id: 1, active: true },
        ] as never,
        projects: [{ ...project }],
      });
    });

    expect(dateInputs()[0]).toHaveValue('2026-10-05');
    // The allocation is not reset to the refetched capacity either
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '60%');
  });

  it('initialises again when reopened', () => {
    seed({ id: 7, role: 'user', name: 'Alice Anderson' });
    openForProject();
    render(<AssignmentModal mode="staff" />);
    fireEvent.change(dateInputs()[0], { target: { value: '2026-10-05' } });

    act(() => useUIStore.getState().closeModal());
    act(() => openForProject());

    expect(dateInputs()[0]).toHaveValue('2026-09-01');
  });
});
