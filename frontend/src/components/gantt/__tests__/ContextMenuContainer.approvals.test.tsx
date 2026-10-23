/**
 * Own bookings and their approval requests in the Gantt context menus:
 * "Assign me" becomes "Request to assign me" in approval mode and disappears
 * without assignments.self_create; a 202 refreshes and says "Sent for
 * approval"; the requester cancels a request from the row, a decider
 * approves or rejects it (reason in a dialog, never a prompt; disabled in
 * What-If); an own removal is hidden without assignments.self_remove and,
 * in approval mode, says it will be sent for approval and marks the row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ContextMenuContainer } from '../ContextMenuContainer';
import { resetAllStores, useAppStore, useUIStore, useWhatIfStore } from '@/stores';
import { createStaffAssignment, deleteStaffAssignment } from '@/api';
import { approvalsApi } from '@/api/endpoints/approvals';
import { ApiError } from '@/api/client';
import { makePhase, makeProject, makeStaff, makeUser } from '@/test/factories';
import { USER_DEFAULTS } from '@/test/permissionFixtures';
import { stubConfirm } from '@/test/confirmDialog';
import type { AssignmentApproval, StaffAssignment, User } from '@/types';
import type { PermissionKey } from '@/types/permissions';

const refreshProjects = vi.fn().mockResolvedValue(undefined);

vi.mock('@/api', () => ({
  deleteProject: vi.fn().mockResolvedValue({}),
  deletePhase: vi.fn().mockResolvedValue({}),
  deleteSubphase: vi.fn().mockResolvedValue({}),
  deleteStaffAssignment: vi.fn().mockResolvedValue({}),
  deleteEquipmentAssignment: vi.fn().mockResolvedValue({}),
  createStaffAssignment: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/api/endpoints/approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/approvals')>()),
  approvalsApi: { approve: vi.fn(), reject: vi.fn(), cancel: vi.fn() },
}));

vi.mock('@/hooks/useDataLoader', () => ({
  useDataLoader: () => ({ refreshProjects }),
}));

const approval = (over: Partial<AssignmentApproval> = {}): AssignmentApproval => ({
  request_id: 31,
  action: 'assignments.self_create',
  requester_id: 4,
  requested: { allocation: 30 },
  previous: null,
  created_at: null,
  can_decide: false,
  ...over,
});

const PENDING = 'pending' as const;

function seed(user: User, phaseStaff: StaffAssignment[] = [{ id: 71, staff_id: 4, allocation: 30, start_date: '', end_date: '' }]) {
  useAppStore.setState({
    currentUser: user,
    projects: [
      makeProject({
        id: 1,
        pm_id: 7,
        phases: [makePhase({ id: 10, name: 'Design', staffAssignments: phaseStaff })],
        staffAssignments: [],
      }),
    ],
    staff: [makeStaff({ id: 4, max_capacity: 80 })],
  });
}

/** A plain user whose own-booking keys are in approval mode (or denied). */
function selfUser(mode: 'approval' | 'deny', ...keys: PermissionKey[]): User {
  return makeUser({
    id: 4,
    role: 'user',
    permissions: USER_DEFAULTS.filter((k) => !keys.includes(k)),
    approval_required: mode === 'approval' ? keys : [],
  });
}

const item = (label: string) => screen.getByRole('menuitem', { name: label });
const openRowMenu = () =>
  useUIStore.getState().showContextMenu('staffAssignment', 71, 0, 0, 1, 10, undefined, { staffId: 4, name: 'Bob Brown' });

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  refreshProjects.mockResolvedValue(undefined);
});

describe('"Assign me" and approval', () => {
  it('reads "Request to assign me" in approval mode and flashes "Sent for approval" on a 202', async () => {
    seed(selfUser('approval', 'assignments.self_create'), []);
    vi.mocked(createStaffAssignment).mockResolvedValueOnce({ success: true, pending: true, request_id: 31, id: 9 });
    useUIStore.getState().showContextMenu('phase', 10, 0, 0, 1);
    render(<ContextMenuContainer />);
    fireEvent.click(item('Request to assign me'));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
    expect(useUIStore.getState().flashNotice).toMatchObject({ message: 'Sent for approval', tone: 'info' });
  });

  it('is hidden when the role holds no assignments.self_create', () => {
    seed(selfUser('deny', 'assignments.self_create'), []);
    useUIStore.getState().showContextMenu('phase', 10, 0, 0, 1);
    render(<ContextMenuContainer />);
    expect(screen.queryByRole('menuitem', { name: /assign me/i })).not.toBeInTheDocument();
  });

  it('reports a failed self-assignment in the flash notice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seed(makeUser({ id: 4, role: 'user' }), []);
    vi.mocked(createStaffAssignment).mockRejectedValueOnce(new Error('Already assigned'));
    useUIStore.getState().showContextMenu('phase', 10, 0, 0, 1);
    render(<ContextMenuContainer />);
    fireEvent.click(item('Assign me'));
    await waitFor(() =>
      expect(useUIStore.getState().flashNotice).toMatchObject({ message: 'Could not assign you: Already assigned', tone: 'error' })
    );
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it('shows "Assignment requested" while my booking awaits approval', () => {
    seed(selfUser('approval', 'assignments.self_create'), [
      { id: 71, staff_id: 4, allocation: 30, start_date: '', end_date: '', approval_status: PENDING, approval: approval() },
    ]);
    useUIStore.getState().showContextMenu('phase', 10, 0, 0, 1);
    render(<ContextMenuContainer />);
    expect(item('Assignment requested')).toBeDisabled();
  });

  it('stays "Assignment requested" when one of my several rows awaits approval', () => {
    seed(selfUser('approval', 'assignments.self_create'), [
      { id: 70, staff_id: 4, allocation: 30, start_date: '2026-01-05', end_date: '2026-01-09', linked: false },
      { id: 71, staff_id: 4, allocation: 30, start_date: '', end_date: '', approval_status: PENDING, approval: approval() },
    ]);
    useUIStore.getState().showContextMenu('phase', 10, 0, 0, 1);
    render(<ContextMenuContainer />);
    expect(item('Assignment requested')).toBeDisabled();
  });

  it('reads "Request to assign me again" in approval mode once booked', () => {
    seed(selfUser('approval', 'assignments.self_create'));
    useUIStore.getState().showContextMenu('phase', 10, 0, 0, 1);
    render(<ContextMenuContainer />);
    expect(item('Request to assign me again')).toBeEnabled();
  });
});

describe('requester actions on a pending row', () => {
  beforeEach(() => {
    seed(selfUser('approval', 'assignments.self_create'), [
      { id: 71, staff_id: 4, allocation: 30, start_date: '', end_date: '', approval_status: PENDING, approval: approval() },
    ]);
  });

  it('cancels the request and refreshes', async () => {
    vi.mocked(approvalsApi.cancel).mockResolvedValueOnce({ success: true, id: 31, status: 'cancelled' });
    openRowMenu();
    render(<ContextMenuContainer />);
    expect(screen.queryByRole('menuitem', { name: 'Approve request' })).not.toBeInTheDocument();
    fireEvent.click(item('Cancel request'));
    await waitFor(() => expect(approvalsApi.cancel).toHaveBeenCalledWith(31));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
  });

  it('reports a failed cancel in the flash notice and still refreshes on a 409', async () => {
    vi.mocked(approvalsApi.cancel).mockRejectedValueOnce(new ApiError('Request already approved', 409));
    openRowMenu();
    render(<ContextMenuContainer />);
    fireEvent.click(item('Cancel request'));
    await waitFor(() =>
      expect(useUIStore.getState().flashNotice).toMatchObject({ message: 'Request already approved', tone: 'error' })
    );
    expect(refreshProjects).toHaveBeenCalled();
  });
});

describe('an open change request on an approved row', () => {
  const changeRequest = () => [
    {
      id: 71,
      staff_id: 4,
      allocation: 30,
      start_date: '',
      end_date: '',
      approval_status: 'approved' as const,
      approval: approval({ action: 'assignments.self_update', previous: { allocation: 30 }, requested: { allocation: 60 } }),
    },
  ];

  it('offers its requester only Cancel request, like the Kanban card', () => {
    seed(selfUser('approval', 'assignments.self_update'), changeRequest());
    openRowMenu();
    render(<ContextMenuContainer />);
    expect(item('Cancel request')).toBeEnabled();
    expect(item('Edit Assignment')).toBeDisabled();
    expect(item('Delete Assignment')).toBeDisabled();
  });

  it('leaves an editor their controls (an editor write expires the request)', () => {
    seed(makeUser({ id: 7, role: 'superuser' }), changeRequest());
    openRowMenu();
    render(<ContextMenuContainer />);
    expect(item('Edit Assignment')).toBeEnabled();
    expect(item('Delete Assignment')).toBeEnabled();
    expect(screen.queryByRole('menuitem', { name: 'Cancel request' })).not.toBeInTheDocument();
  });
});

describe('a pending create', () => {
  it('is locked for its requester too: only Cancel request', () => {
    seed(selfUser('approval', 'assignments.self_create'), [
      { id: 71, staff_id: 4, allocation: 30, start_date: '', end_date: '', approval_status: PENDING, approval: approval() },
    ]);
    openRowMenu();
    render(<ContextMenuContainer />);
    expect(item('Cancel request')).toBeEnabled();
    expect(item('Edit Assignment')).toBeDisabled();
    expect(item('Delete Assignment')).toBeDisabled();
  });

  it('is locked for an editor who may not decide it', () => {
    seed(makeUser({ id: 7, role: 'superuser' }), [
      { id: 71, staff_id: 4, allocation: 30, start_date: '', end_date: '', approval_status: PENDING, approval: approval() },
    ]);
    openRowMenu();
    render(<ContextMenuContainer />);
    expect(item('Edit Assignment')).toBeDisabled();
    expect(item('Delete Assignment')).toBeDisabled();
  });
});

describe('decider actions', () => {
  const pendingRow = () => [
    {
      id: 71,
      staff_id: 4,
      allocation: 30,
      start_date: '',
      end_date: '',
      approval_status: PENDING,
      approval: approval({ can_decide: true }),
    },
  ];

  it('approves from the row and refreshes', async () => {
    seed(makeUser({ id: 7, role: 'user' }), pendingRow());
    vi.mocked(approvalsApi.approve).mockResolvedValueOnce({ success: true, id: 31, status: 'approved' });
    openRowMenu();
    render(<ContextMenuContainer />);
    // A pending booking is not the decider's to edit or delete directly.
    expect(item('Edit Assignment')).toBeDisabled();
    expect(item('Delete Assignment')).toBeDisabled();
    fireEvent.click(item('Approve request'));
    await waitFor(() => expect(approvalsApi.approve).toHaveBeenCalledWith(31));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
  });

  it('reports a failed approval in the flash notice', async () => {
    seed(makeUser({ id: 7, role: 'user' }), pendingRow());
    vi.mocked(approvalsApi.approve).mockRejectedValueOnce(new Error('offline'));
    openRowMenu();
    render(<ContextMenuContainer />);
    fireEvent.click(item('Approve request'));
    await waitFor(() => expect(useUIStore.getState().flashNotice).toMatchObject({ message: 'offline', tone: 'error' }));
    expect(refreshProjects).not.toHaveBeenCalled();
  });

  it('rejects with a reason in a dialog', async () => {
    seed(makeUser({ id: 7, role: 'user' }), pendingRow());
    vi.mocked(approvalsApi.reject).mockResolvedValueOnce({ success: true, id: 31, status: 'rejected' });
    openRowMenu();
    render(<ContextMenuContainer />);
    fireEvent.click(item('Reject request…'));
    expect(useUIStore.getState().contextMenu.visible).toBe(false);
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Fully booked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(approvalsApi.reject).toHaveBeenCalledWith(31, 'Fully booked'));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Reject request' })).not.toBeInTheDocument());
  });

  it('disables the decisions in What-If mode', () => {
    seed(makeUser({ id: 7, role: 'user' }), pendingRow());
    useWhatIfStore.setState({ whatIfMode: true });
    openRowMenu();
    render(<ContextMenuContainer />);
    expect(item('Approve request')).toBeDisabled();
    expect(item('Reject request…')).toBeDisabled();
  });

  it('offers no decision without can_decide', () => {
    seed(makeUser({ id: 7, role: 'user' }), [
      { id: 71, staff_id: 4, allocation: 30, start_date: '', end_date: '', approval_status: PENDING, approval: approval() },
    ]);
    openRowMenu();
    render(<ContextMenuContainer />);
    expect(screen.queryByRole('menuitem', { name: 'Approve request' })).not.toBeInTheDocument();
  });
});

describe('own removal', () => {
  it('is hidden when the role holds no assignments.self_remove', () => {
    seed(selfUser('deny', 'assignments.self_remove'));
    openRowMenu();
    render(<ContextMenuContainer />);
    expect(item('Edit Assignment')).not.toBeDisabled();
    expect(screen.queryByRole('menuitem', { name: 'Delete Assignment' })).not.toBeInTheDocument();
  });

  it('says the removal will be sent for approval and marks the row on a 202', async () => {
    seed(selfUser('approval', 'assignments.self_remove'));
    const confirm = stubConfirm(true);
    vi.mocked(deleteStaffAssignment).mockResolvedValueOnce({ success: true, pending: true, request_id: 32, id: 71 });
    openRowMenu();
    render(<ContextMenuContainer />);
    fireEvent.click(item('Delete Assignment'));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Request to remove Bob Brown from this assignment? The removal will be sent for approval.' })
    );
    await waitFor(() => expect(deleteStaffAssignment).toHaveBeenCalledWith(71, 'phase'));
    await waitFor(() => expect(useUIStore.getState().flashNotice?.message).toBe('Sent for approval'));
    const row = useAppStore.getState().projects[0].phases[0].staffAssignments[0];
    expect(row).toMatchObject({ id: 71, approval: expect.objectContaining({ request_id: 32, action: 'assignments.self_remove' }) });
    expect(refreshProjects).toHaveBeenCalled();
  });

  it('cannot edit my own booking without assignments.self_update', () => {
    seed(selfUser('deny', 'assignments.self_update'));
    openRowMenu();
    render(<ContextMenuContainer />);
    expect(item('Edit Assignment')).toBeDisabled();
  });
});
