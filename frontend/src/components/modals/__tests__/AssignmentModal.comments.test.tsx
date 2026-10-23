/**
 * The booking dialog's comment thread and its lock:
 * - editing a staff booking shows the thread of its card (phase / subphase)
 *   or, for a project-level booking, of its project; creating one or editing
 *   an equipment booking shows none;
 * - the thread sits outside the booking form: posting a comment neither
 *   saves the booking nor closes the dialog;
 * - a booking the user may not change (assignmentLock) opens read-only with
 *   the reason, and its comments stay usable;
 * - a booking at another site (opened from My Work) still names its person.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssignmentModal } from '../AssignmentModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { updateStaffAssignment, deleteStaffAssignment } from '@/api/endpoints/projects';
import { createComment, getComments, getMentionableUsers } from '@/api/endpoints/kanban';
import { makePhase, makeProject, makeSubphase, makeUser } from '@/test/factories';
import type { AssignmentApproval, StaffAssignment } from '@/types';
import { pickerTrigger } from '@/test/searchableSelect';

vi.mock('@/api/endpoints/projects', () => ({
  createStaffAssignment: vi.fn(),
  updateStaffAssignment: vi.fn(),
  deleteStaffAssignment: vi.fn(),
  createEquipmentAssignment: vi.fn(),
  updateEquipmentAssignment: vi.fn(),
  deleteEquipmentAssignment: vi.fn(),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/api/endpoints/kanban', () => ({
  getComments: vi.fn(),
  getMentionableUsers: vi.fn(),
  createComment: vi.fn(),
  deleteComment: vi.fn(),
}));

const ME = 4;

function booking(over: Partial<StaffAssignment> = {}): StaffAssignment {
  return {
    id: 11,
    staff_id: ME,
    staff_name: 'Bob Brown',
    allocation: 50,
    start_date: '2026-01-05',
    end_date: '2026-02-27',
    linked: true,
    approval_status: 'approved',
    approval: null,
    ...over,
  };
}

function request(requester: number, action = 'assignments.self_update'): AssignmentApproval {
  return { request_id: 5, action, requester_id: requester, requested: {}, previous: null, created_at: null, can_decide: false };
}

function seed(phaseRows: StaffAssignment[] = [booking()], siteId = 1) {
  const sub = makeSubphase({ id: 20, staffAssignments: [booking({ id: 21 })] });
  const project = makeProject({
    id: 1,
    site_id: siteId,
    pm_id: 42,
    staffAssignments: [booking({ id: 1, linked: false })],
    phases: [makePhase({ id: 3, children: [sub], staffAssignments: phaseRows })],
  });
  useAppStore.setState({
    projects: [project],
    currentSite: { id: 1, name: 'Basel' } as never,
    staff: [
      { id: ME, name: 'Bob Brown', site_id: siteId, active: true, max_capacity: 100 },
      { id: 7, name: 'Alice Anderson', site_id: siteId, active: true, max_capacity: 100 },
    ] as never,
    currentUser: makeUser({ id: ME, role: 'user' }),
  });
}

function openEdit(row: StaffAssignment, context: { phaseId?: number; subphaseId?: number } = { phaseId: 3 }) {
  useUIStore.getState().setEditingStaffAssignment({
    ...row,
    project_id: 1,
    phase_id: context.phaseId ?? null,
    subphase_id: context.subphaseId ?? null,
    approval: undefined,
    approval_status: undefined,
  });
  useUIStore.getState().openModal('staffAssignment', { projectId: 1, ...context });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

const thread = () => screen.queryByRole('region', { name: 'Comments' });

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.getState().closeModal();
  vi.mocked(getComments).mockResolvedValue([]);
  vi.mocked(getMentionableUsers).mockResolvedValue([]);
  vi.mocked(createComment).mockResolvedValue({} as never);
});

describe('AssignmentModal comments', () => {
  it("shows the phase's thread when editing a phase booking", async () => {
    seed();
    openEdit(booking());
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(thread()).toBeInTheDocument();
    expect(getComments).toHaveBeenCalledWith('phase', 3);
    expect(getMentionableUsers).toHaveBeenCalledWith(1);
  });

  it("shows the subphase's thread for a subphase booking", async () => {
    seed();
    openEdit(booking({ id: 21 }), { phaseId: 3, subphaseId: 20 });
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(getComments).toHaveBeenCalledWith('subphase', 20);
  });

  it("shows the project's thread for a project-level booking", async () => {
    seed();
    openEdit(booking({ id: 1, linked: false }), {});
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(getComments).toHaveBeenCalledWith('project', 1);
  });

  it('shows no thread when creating a booking', async () => {
    seed();
    useUIStore.setState({ editingStaffAssignment: null });
    useUIStore.getState().openModal('staffAssignment', { projectId: 1, phaseId: 3 });
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(thread()).not.toBeInTheDocument();
    expect(getComments).not.toHaveBeenCalled();
  });

  it('shows no thread for an equipment booking', async () => {
    seed();
    useUIStore.getState().setEditingEquipmentAssignment({
      id: 5,
      project_id: 1,
      equipment_id: 2,
      start_date: '2026-01-05',
      end_date: '2026-01-09',
    } as never);
    useUIStore.getState().openModal('equipmentAssignment', { projectId: 1 });
    render(<AssignmentModal mode="equipment" />);
    await settle();
    expect(thread()).not.toBeInTheDocument();
  });

  it('posting a comment neither submits the booking form nor closes the dialog', async () => {
    seed();
    openEdit(booking());
    render(<AssignmentModal mode="staff" />);
    await settle();
    const form = document.querySelector('form')!;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submitted);
    // The thread is not inside the form.
    expect(form.contains(thread())).toBe(false);

    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Check the dates', selectionStart: 15 } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    });
    expect(createComment).toHaveBeenCalledWith('phase', 3, 'Check the dates', []);
    expect(submitted).not.toHaveBeenCalled();
    expect(updateStaffAssignment).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeModal).toBe('staffAssignment');
  });
});

describe('AssignmentModal lock', () => {
  const allocation = () => screen.getByRole('slider', { name: 'Allocation' });
  const follow = () => screen.getByRole('switch', { name: 'Follow the phase dates' });

  it('opens my approved booking editable, without a lock notice', async () => {
    seed();
    openEdit(booking());
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(allocation()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
    expect(screen.queryByText('You cannot change this booking')).not.toBeInTheDocument();
  });

  it('holds a booking carrying my open change request read-only, comments usable', async () => {
    seed([booking({ approval: request(ME) })]);
    openEdit(booking());
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(screen.getByText('Your change request on this booking is open')).toBeInTheDocument();
    expect(allocation()).toBeDisabled();
    expect(follow()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Assignment' })).toBeDisabled();
    expect(screen.getByLabelText('Comment')).toBeEnabled();

    // Enter in the form is refused too.
    fireEvent.submit(document.querySelector('form')!);
    await settle();
    expect(updateStaffAssignment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Assignment' }));
    await settle();
    expect(deleteStaffAssignment).not.toHaveBeenCalled();
  });

  it("holds someone else's pending join read-only, even for the project manager", async () => {
    seed([booking({ id: 12, staff_id: 7, staff_name: 'Alice Anderson', approval_status: 'pending', approval: request(7, 'assignments.self_create') })]);
    useAppStore.setState({ currentUser: makeUser({ id: 42, role: 'user' }) });
    openEdit(booking({ id: 12, staff_id: 7, staff_name: 'Alice Anderson' }));
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(screen.getByText('This booking awaits approval')).toBeInTheDocument();
    expect(allocation()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it("holds someone else's booking read-only for a user who may not change it", async () => {
    seed([booking({ id: 12, staff_id: 7, staff_name: 'Alice Anderson' })]);
    openEdit(booking({ id: 12, staff_id: 7, staff_name: 'Alice Anderson' }));
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(screen.getByText('You cannot change this booking')).toBeInTheDocument();
    expect(allocation()).toBeDisabled();
    expect(follow()).toBeDisabled();
    // My own denied notice is not shown for someone else's booking.
    expect(screen.queryByText('You cannot change your own booking on this project.')).not.toBeInTheDocument();
  });

  it('disables the dates of a locked booking with its own dates', async () => {
    seed([booking({ linked: false, start_date: '2026-01-12', end_date: '2026-01-16', approval: request(ME) })]);
    openEdit(booking({ linked: false, start_date: '2026-01-12', end_date: '2026-01-16' }));
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(screen.getByLabelText('Start Date *')).toBeDisabled();
    expect(screen.getByLabelText('End Date *')).toBeDisabled();
  });
});

describe('AssignmentModal at another site', () => {
  it('still names the person of a booking at a site other than the current one', async () => {
    seed([booking()], 2);
    useAppStore.setState({ currentUser: makeUser({ id: 9, role: 'superuser' }) });
    openEdit(booking());
    render(<AssignmentModal mode="staff" />);
    await settle();
    expect(pickerTrigger(/^Staff Member/)).toHaveAccessibleName('Staff Member * Bob Brown');
    await waitFor(() => expect(getMentionableUsers).toHaveBeenCalledWith(2));
  });
});
