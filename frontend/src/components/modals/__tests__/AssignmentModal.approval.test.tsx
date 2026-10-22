/**
 * The staff-assignment dialog in self mode when the role's own-booking keys
 * are in approval mode or denied. The server decides (a 202 files a request);
 * the dialog only labels the action, shows a denied notice instead of the
 * submit button, and reflects a request that was filed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AssignmentModal } from '../AssignmentModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import {
  createStaffAssignment,
  deleteStaffAssignment,
  loadAllProjects,
  updateStaffAssignment,
} from '@/api/endpoints/projects';
import { stubConfirm } from '@/test/confirmDialog';
import { makePhase, makeProject, makeUser } from '@/test/factories';
import { USER_DEFAULTS } from '@/test/permissionFixtures';
import type { PermissionKey } from '@/types/permissions';

vi.mock('@/api/endpoints/projects', () => ({
  createStaffAssignment: vi.fn(),
  updateStaffAssignment: vi.fn(),
  deleteStaffAssignment: vi.fn(),
  createEquipmentAssignment: vi.fn(),
  updateEquipmentAssignment: vi.fn(),
  deleteEquipmentAssignment: vi.fn(),
  loadAllProjects: vi.fn(),
}));

const PENDING = { success: true, pending: true as const, request_id: 31, id: 11 };

function seed(mode: 'approval' | 'deny' | 'allow', ...keys: PermissionKey[]) {
  const project = makeProject({
    id: 1,
    pm_id: 42,
    phases: [
      makePhase({
        id: 3,
        staffAssignments: [{ id: 11, staff_id: 4, allocation: 50, start_date: '', end_date: '' }],
      }),
    ],
  });
  useAppStore.setState({
    projects: [project],
    currentSite: { id: 1, name: 'Basel' } as never,
    staff: [{ id: 4, name: 'Bob Brown', site_id: 1, active: true, max_capacity: 80 }] as never,
    currentUser: makeUser({
      id: 4,
      role: 'user',
      permissions: mode === 'allow' ? [...USER_DEFAULTS] : USER_DEFAULTS.filter((k) => !keys.includes(k)),
      approval_required: mode === 'approval' ? keys : [],
    }),
  });
  vi.mocked(loadAllProjects).mockResolvedValue([project]);
}

function openCreate() {
  useUIStore.setState({ editingStaffAssignment: null, flashNotice: null });
  useUIStore.getState().openModal('staffAssignment', { projectId: 1, phaseId: 3 });
}

function openEdit() {
  useUIStore.setState({ flashNotice: null });
  useUIStore.getState().setEditingStaffAssignment({
    id: 11,
    project_id: 1,
    phase_id: 3,
    subphase_id: null,
    staff_id: 4,
    staff_name: 'Bob Brown',
    allocation: 50,
    start_date: '',
    end_date: '',
  });
  useUIStore.getState().openModal('staffAssignment', { projectId: 1, phaseId: 3 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AssignmentModal self booking needing approval', () => {
  it('labels the action "Request to assign me" and flashes "Sent for approval" on a 202', async () => {
    seed('approval', 'assignments.self_create');
    vi.mocked(createStaffAssignment).mockResolvedValue(PENDING);
    openCreate();
    render(<AssignmentModal mode="staff" />);
    fireEvent.click(screen.getByRole('button', { name: 'Request to assign me' }));
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(createStaffAssignment).toHaveBeenCalledWith(expect.objectContaining({ staff_id: 4, phase_id: 3 }));
    expect(loadAllProjects).toHaveBeenCalled();
    expect(useUIStore.getState().flashNotice).toMatchObject({ message: 'Sent for approval', tone: 'info' });
  });

  it('shows a notice instead of the submit button when own bookings are denied', () => {
    seed('deny', 'assignments.self_create');
    openCreate();
    render(<AssignmentModal mode="staff" />);
    expect(screen.getByRole('status')).toHaveTextContent('You cannot book your own time on this project.');
    expect(screen.queryByRole('button', { name: /assign me/i })).not.toBeInTheDocument();
  });

  it('refuses a new own booking to someone not bookable as a resource, keeping their edits', () => {
    seed('allow');
    useAppStore.setState({ currentUser: { ...useAppStore.getState().currentUser!, is_resource: false } });
    openCreate();
    const { unmount } = render(<AssignmentModal mode="staff" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'You are not bookable as a resource, so you cannot book your own time.'
    );
    expect(screen.queryByRole('button', { name: /assign me/i })).not.toBeInTheDocument();
    unmount();

    openEdit();
    render(<AssignmentModal mode="staff" />);
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps the plain label and no flash on a direct booking', async () => {
    seed('allow');
    vi.mocked(createStaffAssignment).mockResolvedValue({ id: 12, staff_id: 4, allocation: 80, start_date: '', end_date: '' });
    openCreate();
    render(<AssignmentModal mode="staff" />);
    fireEvent.click(screen.getByRole('button', { name: 'Assign me' }));
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(useUIStore.getState().flashNotice).toBeNull();
  });

  it('files a change request: the row keeps its value and carries the request', async () => {
    seed('approval', 'assignments.self_update');
    vi.mocked(updateStaffAssignment).mockResolvedValue(PENDING);
    // The reload is what the server holds: the old allocation, the open request.
    vi.mocked(loadAllProjects).mockImplementation(async () => useAppStore.getState().projects);
    openEdit();
    render(<AssignmentModal mode="staff" />);
    fireEvent.change(screen.getByLabelText('Allocation'), { target: { value: '70' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request change' }));
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(updateStaffAssignment).toHaveBeenCalledWith(11, { allocation: 70 }, 'phase');
    const row = useAppStore.getState().projects[0].phases[0].staffAssignments[0];
    expect(row.allocation).toBe(50);
    expect(row.approval).toMatchObject({ request_id: 31, action: 'assignments.self_update', requested: { allocation: 70 } });
    expect(useUIStore.getState().flashNotice?.message).toBe('Sent for approval');
  });

  it('asks before requesting a removal and marks the row on a 202', async () => {
    seed('approval', 'assignments.self_remove');
    const confirm = stubConfirm(true);
    vi.mocked(deleteStaffAssignment).mockResolvedValue(PENDING);
    vi.mocked(loadAllProjects).mockImplementation(async () => useAppStore.getState().projects);
    openEdit();
    render(<AssignmentModal mode="staff" />);
    fireEvent.click(screen.getByRole('button', { name: 'Request removal' }));
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Request the removal of your booking? It will be sent for approval.' })
    );
    const row = useAppStore.getState().projects[0].phases[0].staffAssignments[0];
    expect(row).toMatchObject({ id: 11, approval: expect.objectContaining({ action: 'assignments.self_remove' }) });
    expect(useUIStore.getState().flashNotice?.message).toBe('Sent for approval');
  });

  it('hides the remove button when own removals are denied', () => {
    seed('deny', 'assignments.self_remove');
    openEdit();
    render(<AssignmentModal mode="staff" />);
    expect(screen.queryByRole('button', { name: /remov/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
  });

  it('hides Save when own changes are denied', () => {
    seed('deny', 'assignments.self_update');
    openEdit();
    render(<AssignmentModal mode="staff" />);
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You cannot change your own booking on this project.');
  });
});
