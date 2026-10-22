/**
 * Who the staff-assignment dialog lets you book (utils/permissions.ts).
 *
 * A project's editors -- admins, superusers and its manager -- pick anyone on
 * the site. Everyone else may only book their own time: the picker is fixed to
 * them, the allocation starts at their capacity, and only their own booking
 * can be removed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AssignmentModal } from '../AssignmentModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { createStaffAssignment, deleteStaffAssignment } from '@/api/endpoints/projects';
import { stubConfirm } from '@/test/confirmDialog';
import { dateValue, pickDate, pickEnd } from '@/test/datePicker';
import type { Project } from '@/types';
import { useViewStore } from '@/stores/viewStore';
import { tagFilterKey } from '@/utils/tags';
import { makeTeam, makeUser } from '@/test/factories';

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
    currentUser: makeUser({ name: 'Someone', ...user }),
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

  it('removes the booking once the confirmation is accepted', async () => {
    const confirm = stubConfirm(true);
    seed({ id: 42, role: 'user' });
    openEditing(4);
    render(<AssignmentModal mode="staff" />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Assignment' }));

    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(confirm).toHaveBeenCalledWith({
      title: 'Remove assignment',
      message: 'Are you sure you want to remove this staff assignment?',
      destructive: true,
    });
    expect(deleteStaffAssignment).toHaveBeenCalledWith(11, 'project');
  });

  it('keeps the booking and the dialog when the confirmation is declined', async () => {
    const confirm = stubConfirm(false);
    seed({ id: 42, role: 'user' });
    openEditing(4);
    render(<AssignmentModal mode="staff" />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Assignment' }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(deleteStaffAssignment).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeModal).toBe('staffAssignment');
  });
});

describe('AssignmentModal initialisation', () => {
  it('keeps what the user typed when staff is refetched while open', () => {
    seed({ id: 7, role: 'user', name: 'Alice Anderson' });
    openForProject();
    render(<AssignmentModal mode="staff" />);

    expect(dateValue('Start Date *')).toBe('2026-09-01');
    pickDate('Start Date *', '2026-10-05');

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

    expect(dateValue('Start Date *')).toBe('2026-10-05');
    // The allocation is not reset to the refetched capacity either
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '60%');
  });

  it('initialises again when reopened', () => {
    seed({ id: 7, role: 'user', name: 'Alice Anderson' });
    openForProject();
    render(<AssignmentModal mode="staff" />);
    pickDate('Start Date *', '2026-10-05');

    act(() => useUIStore.getState().closeModal());
    act(() => openForProject());

    expect(dateValue('Start Date *')).toBe('2026-09-01');
  });

  it('refuses an allocation below 5 %', () => {
    seed({ id: 7, role: 'user', name: 'Alice Anderson' });
    // A person at 0 % capacity starts at 0 %
    useAppStore.setState({ staff: [{ id: 7, name: 'Alice Anderson', site_id: 1, active: true, max_capacity: 0 }] as never });
    openForProject();
    render(<AssignmentModal mode="staff" />);

    fireEvent.click(screen.getByRole('button', { name: 'Assign me' }));
    expect(screen.getByText('Allocation must be at least 5%')).toBeInTheDocument();
    expect(createStaffAssignment).not.toHaveBeenCalled();
  });

  // The rule itself is proven in dateRangeLogic.test; this guards the form's payload wiring
  it('never lets the end precede the start', async () => {
    seed({ id: 7, role: 'user', name: 'Alice Anderson' });
    openForProject();
    render(<AssignmentModal mode="staff" />);

    // An end picked before the start becomes the new start, keeping the duration
    pickEnd('End Date *', '2026-08-25');
    expect(dateValue('Start Date *')).toBe('2026-08-25');
    expect(dateValue('End Date *')).toBe('2026-12-24');

    fireEvent.click(screen.getByRole('button', { name: 'Assign me' }));
    await waitFor(() => expect(createStaffAssignment).toHaveBeenCalled());
    expect(vi.mocked(createStaffAssignment).mock.calls[0][0]).toMatchObject({
      start_date: '2026-08-25',
      end_date: '2026-12-24',
    });
  });
});

describe('AssignmentModal picker with a team filter', () => {
  afterEach(() => {
    useViewStore.setState({ teamFilters: {} });
    useAppStore.setState({ teams: [] });
  });

  it('keeps the currently selected item even when it no longer matches', () => {
    seed({ id: 1, role: 'admin' });
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1 }), makeTeam({ id: 2, site_id: 1, name: 'Process' })],
      staff: [
        { id: 7, name: 'Alice Anderson', role: 'Scientist', site_id: 1, active: true, team_ids: [1] },
        { id: 4, name: 'Bob Brown', role: 'Scientist', site_id: 1, active: true, team_ids: [2] },
        { id: 5, name: 'Carol White', role: 'Scientist', site_id: 1, active: true, team_ids: [2] },
      ] as never,
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
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
    render(<AssignmentModal mode="staff" />);

    const picker = screen.getByLabelText('Staff Member') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.text)).toEqual([
      'Select staff member',
      'Alice Anderson (Scientist)',
      'Bob Brown (Scientist)',
    ]);
    expect(picker).toHaveValue('4');
  });
});
