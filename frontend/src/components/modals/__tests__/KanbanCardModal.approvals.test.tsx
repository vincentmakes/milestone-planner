/**
 * Bookings awaiting approval in the Kanban card dialog: the pending badge,
 * the current and the requested allocation, Cancel request for the
 * requester, inline Approve / Reject for a decider (disabled in What-If),
 * and the self-booking actions (Join, allocation, leave) when the server
 * answers 202 or the role denies them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { KanbanCardModal } from '../KanbanCardModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { assignCard, unassignCard } from '@/api/endpoints/kanban';
import { loadAllProjects, updateStaffAssignment } from '@/api/endpoints/projects';
import { approvalsApi } from '@/api/endpoints/approvals';
import { makePhase, makeProject, makeUser } from '@/test/factories';
import { USER_DEFAULTS } from '@/test/permissionFixtures';
import { stubConfirm } from '@/test/confirmDialog';
import type { AssignmentApproval, Project, StaffAssignment, User } from '@/types';
import type { PermissionKey } from '@/types/permissions';

vi.mock('@/api/endpoints/kanban', () => ({
  getComments: vi.fn().mockResolvedValue([]),
  getMentionableUsers: vi.fn().mockResolvedValue([]),
  createComment: vi.fn(),
  deleteComment: vi.fn(),
  assignCard: vi.fn(),
  unassignCard: vi.fn(),
  moveCard: vi.fn(),
}));

vi.mock('@/api/endpoints/projects', () => ({
  loadAllProjects: vi.fn(),
  updateStaffAssignment: vi.fn(),
}));

vi.mock('@/api/endpoints/approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/approvals')>()),
  approvalsApi: { approve: vi.fn(), reject: vi.fn(), cancel: vi.fn() },
}));

vi.mock('@/api/endpoints/roles', () => ({
  rolesApi: { getAll: vi.fn(() => new Promise(() => {})), getApprovalPolicies: vi.fn(() => new Promise(() => {})) },
}));

const PENDING = { success: true, pending: true as const, request_id: 31, id: 1 };

const approval = (over: Partial<AssignmentApproval> = {}): AssignmentApproval => ({
  request_id: 31,
  action: 'assignments.self_create',
  requester_id: 4,
  requested: { allocation: 60 },
  previous: null,
  created_at: null,
  can_decide: false,
  ...over,
});

function bob(over: Partial<StaffAssignment> = {}): StaffAssignment {
  return { id: 1, staff_id: 4, staff_name: 'Bob Brown', allocation: 40, start_date: '', end_date: '', ...over };
}

function seed(user: User, rows: StaffAssignment[] = [bob()]): Project {
  const project = makeProject({
    id: 1,
    pm_id: 42,
    phases: [makePhase({ id: 10, name: 'DoE setup', staffAssignments: rows })],
  });
  useAppStore.setState({
    projects: [project],
    staff: [
      { id: 4, name: 'Bob Brown', site_id: 1, active: true },
      { id: 5, name: 'Carol Chen', site_id: 1, active: true },
    ] as never,
    currentUser: user,
    approvalPolicies: [],
    roles: [],
  });
  useUIStore.setState({ flashNotice: null });
  useUIStore.getState().openKanbanCardModal('phase', 10, 1);
  vi.mocked(loadAllProjects).mockImplementation(async () => useAppStore.getState().projects);
  return project;
}

function selfUser(id: number, mode: 'approval' | 'deny', ...keys: PermissionKey[]): User {
  return makeUser({
    id,
    role: 'user',
    permissions: USER_DEFAULTS.filter((k) => !keys.includes(k)),
    approval_required: mode === 'approval' ? keys : [],
  });
}

const bobRow = () => screen.getByText('Bob Brown').closest('li') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  useWhatIfStore.setState({ whatIfMode: false });
});

describe('KanbanCardModal pending rows', () => {
  it('shows a pending booking with its badge and no editing controls for others', () => {
    seed(makeUser({ id: 5, role: 'user' }), [bob({ approval_status: 'pending', approval: approval() })]);
    render(<KanbanCardModal />);
    expect(within(bobRow()).getByText('Pending approval')).toBeInTheDocument();
    expect(within(bobRow()).getByText('40%')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
  });

  it('shows the current and the requested allocation of a pending change', () => {
    seed(makeUser({ id: 5, role: 'user' }), [
      bob({ approval: approval({ action: 'assignments.self_update', previous: { allocation: 40 } }) }),
    ]);
    render(<KanbanCardModal />);
    expect(within(bobRow()).getByText('40%')).toBeInTheDocument();
    expect(within(bobRow()).getByText('requested 60%')).toBeInTheDocument();
    expect(within(bobRow()).getByText('Change pending')).toBeInTheDocument();
  });

  it('gives the requester Cancel request instead of the remove button', async () => {
    seed(makeUser({ id: 4, role: 'user' }), [bob({ approval_status: 'pending', approval: approval() })]);
    vi.mocked(approvalsApi.cancel).mockResolvedValue({ success: true, id: 31, status: 'cancelled' });
    render(<KanbanCardModal />);
    expect(screen.queryByLabelText('Remove Bob Brown')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Allocation for Bob Brown')).not.toBeInTheDocument();
    fireEvent.click(within(bobRow()).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(approvalsApi.cancel).toHaveBeenCalledWith(31));
    await waitFor(() => expect(loadAllProjects).toHaveBeenCalled());
  });

  it('shows a failed cancel in the dialog', async () => {
    seed(makeUser({ id: 4, role: 'user' }), [bob({ approval_status: 'pending', approval: approval() })]);
    vi.mocked(approvalsApi.cancel).mockRejectedValue(new Error('Request already approved'));
    render(<KanbanCardModal />);
    fireEvent.click(within(bobRow()).getByRole('button', { name: 'Cancel request' }));
    expect(await screen.findByText('Request already approved')).toBeInTheDocument();
  });

  it('lets a decider approve and reject inline', async () => {
    seed(makeUser({ id: 42, role: 'user' }), [bob({ approval_status: 'pending', approval: approval({ can_decide: true }) })]);
    vi.mocked(approvalsApi.approve).mockResolvedValue({ success: true, id: 31, status: 'approved' });
    vi.mocked(approvalsApi.reject).mockResolvedValue({ success: true, id: 31, status: 'rejected' });
    render(<KanbanCardModal />);
    // The pending booking itself is not the decider's to edit or remove.
    expect(screen.queryByLabelText('Remove Bob Brown')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve Bob Brown' }));
    await waitFor(() => expect(approvalsApi.approve).toHaveBeenCalledWith(31));
    await waitFor(() => expect(loadAllProjects).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Reject Bob Brown' }));
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'No capacity' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(approvalsApi.reject).toHaveBeenCalledWith(31, 'No capacity'));
  });

  it('shows a failed decision in the dialog', async () => {
    seed(makeUser({ id: 42, role: 'user' }), [bob({ approval_status: 'pending', approval: approval({ can_decide: true }) })]);
    vi.mocked(approvalsApi.approve).mockRejectedValue(new Error('offline'));
    render(<KanbanCardModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve Bob Brown' }));
    expect(await screen.findByText('offline')).toBeInTheDocument();
  });

  it('shows a failed reload after a decision in the dialog', async () => {
    seed(makeUser({ id: 42, role: 'user' }), [bob({ approval_status: 'pending', approval: approval({ can_decide: true }) })]);
    vi.mocked(approvalsApi.approve).mockResolvedValue({ success: true, id: 31, status: 'approved' });
    vi.mocked(loadAllProjects).mockRejectedValue(new Error('Reload failed'));
    render(<KanbanCardModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve Bob Brown' }));
    expect(await screen.findByText('Reload failed')).toBeInTheDocument();
  });

  it('disables the decisions in What-If mode', () => {
    seed(makeUser({ id: 42, role: 'user' }), [bob({ approval_status: 'pending', approval: approval({ can_decide: true }) })]);
    useWhatIfStore.setState({ whatIfMode: true });
    render(<KanbanCardModal />);
    expect(screen.getByRole('button', { name: 'Approve Bob Brown' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject Bob Brown' })).toBeDisabled();
  });

  it('lets an editor still change an approved row whose change is pending', () => {
    seed(makeUser({ id: 42, role: 'user' }), [bob({ approval: approval({ action: 'assignments.self_update' }) })]);
    render(<KanbanCardModal />);
    expect(screen.getByLabelText('Allocation for Bob Brown')).toBeInTheDocument();
  });
});

describe('KanbanCardModal self bookings and approval', () => {
  it('reads "Request to join" in approval mode and flashes "Sent for approval" on a 202', async () => {
    seed(selfUser(5, 'approval', 'assignments.self_create'));
    vi.mocked(assignCard).mockResolvedValue({ ...PENDING, id: 2 });
    render(<KanbanCardModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Request to join' }));
    await waitFor(() => expect(assignCard).toHaveBeenCalledWith('phase', 10, 5));
    await waitFor(() => expect(useUIStore.getState().flashNotice).toMatchObject({ message: 'Sent for approval', tone: 'info' }));
    expect(loadAllProjects).toHaveBeenCalled();
  });

  it('hides Join without assignments.self_create', () => {
    seed(selfUser(5, 'deny', 'assignments.self_create'));
    render(<KanbanCardModal />);
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument();
  });

  it('does not offer Join to someone whose join awaits approval', () => {
    seed(makeUser({ id: 4, role: 'user' }), [bob({ approval_status: 'pending', approval: approval() })]);
    render(<KanbanCardModal />);
    expect(screen.queryByRole('button', { name: 'Join this card' })).not.toBeInTheDocument();
  });

  it('files an allocation change: the slider keeps the old value and the request shows', async () => {
    seed(selfUser(4, 'approval', 'assignments.self_update'));
    vi.mocked(updateStaffAssignment).mockResolvedValue(PENDING);
    render(<KanbanCardModal />);
    const slider = screen.getByLabelText('Allocation for Bob Brown') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '60' } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(updateStaffAssignment).toHaveBeenCalledWith(1, { allocation: 60 }, 'phase'));
    await waitFor(() => expect(useUIStore.getState().flashNotice?.message).toBe('Sent for approval'));
    const row = useAppStore.getState().projects[0].phases[0].staffAssignments[0];
    expect(row.allocation).toBe(40);
    expect(row.approval).toMatchObject({ action: 'assignments.self_update', requested: { allocation: 60 } });
    expect(await within(bobRow()).findByText('requested 60%')).toBeInTheDocument();
  });

  it('shows the allocation read-only without assignments.self_update', () => {
    seed(selfUser(4, 'deny', 'assignments.self_update'));
    render(<KanbanCardModal />);
    expect(screen.queryByLabelText('Allocation for Bob Brown')).not.toBeInTheDocument();
    expect(within(bobRow()).getByText('40%')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Bob Brown')).toBeInTheDocument();
  });

  it('asks before requesting to leave and marks the row on a 202', async () => {
    seed(selfUser(4, 'approval', 'assignments.self_remove'));
    const confirm = stubConfirm(true);
    vi.mocked(unassignCard).mockResolvedValue(PENDING);
    render(<KanbanCardModal />);
    fireEvent.click(screen.getByLabelText('Remove Bob Brown'));
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Ask to leave this card? Your removal will be sent for approval.' })
      )
    );
    await waitFor(() => expect(useUIStore.getState().flashNotice?.message).toBe('Sent for approval'));
    const row = useAppStore.getState().projects[0].phases[0].staffAssignments[0];
    expect(row).toMatchObject({ id: 1, approval: expect.objectContaining({ action: 'assignments.self_remove' }) });
  });

  it('hides the remove button on my row without assignments.self_remove', () => {
    seed(selfUser(4, 'deny', 'assignments.self_remove'));
    render(<KanbanCardModal />);
    expect(screen.queryByLabelText('Remove Bob Brown')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Allocation for Bob Brown')).toBeInTheDocument();
  });
});
