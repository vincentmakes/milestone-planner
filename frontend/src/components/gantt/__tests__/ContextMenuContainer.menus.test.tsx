/**
 * The right-click menus of the Gantt tree: what each entry opens, which
 * entries a role may use, the What-If block on "create" entries, the
 * confirm-then-delete flows (remote delete + local mirror + refresh), and
 * the staff / equipment assignment menus.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ContextMenuContainer } from '../ContextMenuContainer';
import { resetAllStores, useAppStore, useUIStore, useWhatIfStore } from '@/stores';
import {
  createStaffAssignment,
  deleteEquipmentAssignment,
  deleteProject,
  deletePhase,
  deleteStaffAssignment,
  deleteSubphase,
} from '@/api';
import { makePhase, makeProject, makeStaff, makeSubphase, makeUser } from '@/test/factories';
import { stubConfirm } from '@/test/confirmDialog';

const refreshProjects = vi.fn();

vi.mock('@/api', () => ({
  deleteProject: vi.fn().mockResolvedValue({}),
  deletePhase: vi.fn().mockResolvedValue({}),
  deleteSubphase: vi.fn().mockResolvedValue({}),
  deleteStaffAssignment: vi.fn().mockResolvedValue({}),
  deleteEquipmentAssignment: vi.fn().mockResolvedValue({}),
  createStaffAssignment: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/hooks/useDataLoader', () => ({
  useDataLoader: () => ({ refreshProjects }),
}));

const subphase = makeSubphase({ id: 20, name: 'Screening', parent_phase_id: 10 });
const phase = makePhase({
  id: 10,
  name: 'Design',
  children: [subphase],
  staffAssignments: [{ id: 71, staff_id: 4, allocation: 30, start_date: '', end_date: '' }],
  equipmentAssignments: [{ id: 72, equipment_id: 1, start_date: '', end_date: '' }],
});
const project = makeProject({
  id: 1,
  name: 'Bioprocess Scale-Up',
  pm_id: 7,
  start_date: '',
  end_date: '',
  phases: [phase],
  staffAssignments: [{ id: 50, staff_id: 4, allocation: 40, start_date: '2026-01-05', end_date: '2026-01-30' }],
  equipmentAssignments: [{ id: 60, equipment_id: 1, start_date: '2026-01-05', end_date: '2026-01-09' }],
});

function seed(user = makeUser({ id: 1, role: 'admin' })) {
  useAppStore.setState({
    currentUser: user,
    projects: [structuredClone(project)],
    staff: [makeStaff({ id: 5, max_capacity: 60 })],
  });
}

const item = (label: string) => screen.getByRole('menuitem', { name: label });

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  seed();
});

describe('project menu', () => {
  it('opens the editors for an admin', () => {
    useUIStore.getState().showContextMenu('project', 1, 30, 40);
    render(<ContextMenuContainer />);

    fireEvent.click(item('Edit Project'));
    expect(useUIStore.getState().activeModal).toBe('project');
    expect(useUIStore.getState().editingProject?.id).toBe(1);
    expect(useUIStore.getState().contextMenu.visible).toBe(false);
  });

  it.each([
    ['Add Phase', 'phase', { projectId: 1 }],
    ['Assign Staff', 'staffAssignment', { projectId: 1 }],
    ['Assign Equipment', 'equipmentAssignment', { projectId: 1 }],
  ])('"%s" opens the %s dialog', (label, modal, context) => {
    useUIStore.getState().showContextMenu('project', 1, 0, 0);
    render(<ContextMenuContainer />);
    fireEvent.click(item(label));
    expect(useUIStore.getState().activeModal).toBe(modal);
    expect(useUIStore.getState().modalContext).toMatchObject(context);
  });

  it('deletes the project after confirmation', async () => {
    const confirm = stubConfirm(true);
    useUIStore.getState().showContextMenu('project', 1, 0, 0);
    render(<ContextMenuContainer />);
    fireEvent.click(item('Delete Project'));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Delete project "Bioprocess Scale-Up"? This cannot be undone.', destructive: true }));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
    expect(deleteProject).toHaveBeenCalledWith(1);
    expect(useAppStore.getState().projects).toEqual([]);
  });

  it('keeps the project when the deletion is cancelled', async () => {
    const confirm = stubConfirm(false);
    useUIStore.getState().showContextMenu('project', 1, 0, 0);
    render(<ContextMenuContainer />);
    fireEvent.click(item('Delete Project'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(deleteProject).not.toHaveBeenCalled();
    expect(refreshProjects).not.toHaveBeenCalled();
    expect(useAppStore.getState().projects).toHaveLength(1);
  });

  it('lets the project manager edit but not delete', () => {
    seed(makeUser({ id: 7, role: 'user' }));
    useUIStore.getState().showContextMenu('project', 1, 0, 0);
    render(<ContextMenuContainer />);
    expect(item('Edit Project')).not.toBeDisabled();
    expect(item('Delete Project')).toBeDisabled();
    // editors get the dialog, not "Assign me"
    expect(screen.queryByRole('button', { name: 'Assign me' })).not.toBeInTheDocument();
  });

  it('blocks the create entries in What-If mode', () => {
    useWhatIfStore.setState({ whatIfMode: true });
    useUIStore.getState().showContextMenu('project', 1, 0, 0);
    render(<ContextMenuContainer />);
    for (const label of ['Add Phase', 'Assign Staff', 'Assign Equipment']) {
      expect(item(label)).toBeDisabled();
      expect(item(label).title).toMatch(/Adding items/);
    }
    expect(item('Edit Project')).not.toBeDisabled();
  });

  it('lets a plain user assign themselves, with today as dates on an undated project', async () => {
    seed(makeUser({ id: 5, role: 'user', max_capacity: 100 }));
    useUIStore.getState().showContextMenu('project', 1, 0, 0);
    render(<ContextMenuContainer />);
    expect(item('Edit Project')).toBeDisabled();
    fireEvent.click(item('Assign me'));
    await waitFor(() => expect(refreshProjects).toHaveBeenCalled());
    const body = vi.mocked(createStaffAssignment).mock.calls[0][0];
    // the staff row's capacity wins over the user record
    expect(body).toMatchObject({ staff_id: 5, allocation: 60, project_id: 1, phase_id: undefined });
    expect(body.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.start_date).toBe(body.end_date);
  });

  it('logs a failed self-assignment and reports it in the flash notice', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(createStaffAssignment).mockRejectedValueOnce(new Error('409'));
    seed(makeUser({ id: 5, role: 'user' }));
    useUIStore.getState().showContextMenu('phase', 10, 0, 0, 1);
    render(<ContextMenuContainer />);
    fireEvent.click(item('Assign me'));
    await waitFor(() => expect(err).toHaveBeenCalledWith('Failed to self-assign:', expect.any(Error)));
    expect(useUIStore.getState().flashNotice?.message).toBe('Could not assign you: 409');
    expect(refreshProjects).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('hides "Assign me" from a user who is not bookable as a resource', () => {
    seed(makeUser({ id: 5, role: 'user', is_resource: false }));
    useUIStore.getState().showContextMenu('project', 1, 0, 0);
    render(<ContextMenuContainer />);
    expect(item('Edit Project')).toBeDisabled();
    expect(screen.queryByRole('menuitem', { name: /assign me/i })).not.toBeInTheDocument();
  });

  it('shows "Assigned to me" once booked', () => {
    seed(makeUser({ id: 4, role: 'user' }));
    useUIStore.getState().showContextMenu('phase', 10, 0, 0, 1);
    render(<ContextMenuContainer />);
    expect(item('Assigned to me')).toBeDisabled();
  });
});

describe('phase and subphase menus', () => {
  it('phase entries open the right dialogs', () => {
    useUIStore.getState().showContextMenu('phase', 10, 0, 0, 1);
    const { rerender } = render(<ContextMenuContainer />);
    fireEvent.click(item('Edit Phase'));
    expect(useUIStore.getState()).toMatchObject({ activeModal: 'phase', modalContext: { projectId: 1 } });
    expect(useUIStore.getState().editingPhase?.id).toBe(10);

    const open = (label: string) => {
      useUIStore.getState().showContextMenu('phase', 10, 0, 0, 1);
      rerender(<ContextMenuContainer />);
      fireEvent.click(item(label));
    };
    open('Add Subphase');
    expect(useUIStore.getState()).toMatchObject({ activeModal: 'subphase', modalContext: { phaseId: 10, projectId: 1 } });
    open('Assign Staff');
    expect(useUIStore.getState()).toMatchObject({ activeModal: 'staffAssignment', modalContext: { phaseId: 10, projectId: 1 } });
    open('Assign Equipment');
    expect(useUIStore.getState().activeModal).toBe('equipmentAssignment');
  });

  it('deletes a phase and removes it locally', async () => {
    const confirm = stubConfirm(true);
    useUIStore.getState().showContextMenu('phase', 10, 0, 0, 1);
    render(<ContextMenuContainer />);
    fireEvent.click(item('Delete Phase'));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Delete phase "Design"? This cannot be undone.', destructive: true }));
    await waitFor(() => expect(deletePhase).toHaveBeenCalledWith(10));
    expect(useAppStore.getState().projects[0].phases).toEqual([]);
  });

  it('subphase entries open the right dialogs and delete', async () => {
    useUIStore.getState().showContextMenu('subphase', 20, 0, 0, 1, 10);
    const { rerender } = render(<ContextMenuContainer />);
    fireEvent.click(item('Edit Subphase'));
    expect(useUIStore.getState().editingSubphase?.id).toBe(20);

    const open = (label: string) => {
      useUIStore.getState().showContextMenu('subphase', 20, 0, 0, 1, 10);
      rerender(<ContextMenuContainer />);
      fireEvent.click(item(label));
    };
    open('Add Child Subphase');
    expect(useUIStore.getState().modalContext).toEqual({ phaseId: 10, projectId: 1, subphaseId: 20 });
    open('Assign Staff');
    expect(useUIStore.getState().modalContext).toMatchObject({ subphaseId: 20, phaseId: 10, projectId: 1 });
    open('Assign Equipment');
    expect(useUIStore.getState().activeModal).toBe('equipmentAssignment');

    const confirm = stubConfirm(true);
    open('Delete Subphase');
    expect(confirm).toHaveBeenCalledWith({
      title: 'Delete subphase',
      message: 'Delete subphase "Screening"? This cannot be undone.',
      destructive: true,
    });
    await waitFor(() => expect(deleteSubphase).toHaveBeenCalledWith(20));
    expect(useAppStore.getState().projects[0].phases[0].children).toEqual([]);
  });
});

describe('assignment menus', () => {
  it('edits a staff booking with its data', () => {
    useUIStore.getState().showContextMenu('staffAssignment', 50, 0, 0, 1, undefined, undefined, {
      staffId: 4,
      name: 'Bob Brown',
      allocation: 40,
      startDate: '2026-01-05',
      endDate: '2026-01-30',
    });
    render(<ContextMenuContainer />);
    fireEvent.click(item('Edit Assignment'));
    expect(useUIStore.getState().activeModal).toBe('staffAssignment');
    expect(useUIStore.getState().editingStaffAssignment).toEqual({
      id: 50,
      project_id: 1,
      phase_id: null,
      subphase_id: null,
      staff_id: 4,
      staff_name: 'Bob Brown',
      allocation: 40,
      start_date: '2026-01-05',
      end_date: '2026-01-30',
    });
  });

  it('deletes a phase-level staff booking through the phase route', async () => {
    const confirm = stubConfirm(true);
    useUIStore.getState().showContextMenu('staffAssignment', 71, 0, 0, 1, 10, undefined, { staffId: 4, name: 'Bob Brown' });
    render(<ContextMenuContainer />);
    fireEvent.click(item('Delete Assignment'));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Remove Bob Brown from this assignment?', destructive: true }));
    await waitFor(() => expect(deleteStaffAssignment).toHaveBeenCalledWith(71, 'phase'));
    expect(useAppStore.getState().projects[0].phases[0].staffAssignments).toEqual([]);
  });

  it('lets people change only their own booking on a project they do not manage', () => {
    seed(makeUser({ id: 4, role: 'user' }));
    useUIStore.getState().showContextMenu('staffAssignment', 50, 0, 0, 1, undefined, undefined, { staffId: 4 });
    const { rerender } = render(<ContextMenuContainer />);
    expect(item('Edit Assignment')).not.toBeDisabled();

    useUIStore.getState().showContextMenu('staffAssignment', 51, 0, 0, 1, undefined, undefined, { staffId: 9 });
    rerender(<ContextMenuContainer />);
    expect(item('Edit Assignment')).toBeDisabled();
    expect(item('Delete Assignment')).toBeDisabled();
  });

  it('edits and deletes an equipment booking', async () => {
    useUIStore.getState().showContextMenu('equipmentAssignment', 60, 0, 0, 1, undefined, undefined, {
      equipmentId: 1,
      name: 'Bioreactor 50L',
      startDate: '2026-01-05',
      endDate: '2026-01-09',
    });
    const { rerender } = render(<ContextMenuContainer />);
    fireEvent.click(item('Edit Assignment'));
    expect(useUIStore.getState().editingEquipmentAssignment).toMatchObject({
      id: 60,
      equipment_id: 1,
      equipment_name: 'Bioreactor 50L',
    });

    const confirm = stubConfirm(true);
    useUIStore.getState().showContextMenu('equipmentAssignment', 60, 0, 0, 1);
    rerender(<ContextMenuContainer />);
    fireEvent.click(item('Delete Assignment'));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Remove Equipment Assignment from this assignment?', destructive: true }));
    await waitFor(() => expect(deleteEquipmentAssignment).toHaveBeenCalledWith(60));
    expect(useAppStore.getState().projects[0].equipmentAssignments).toEqual([]);
  });

  it('gates the equipment entries on equipment_bookings.manage, independently of project editing', () => {
    seed(makeUser({ id: 30, role: 'booker', permissions: ['projects.view', 'equipment_bookings.manage'] }));
    useUIStore.getState().showContextMenu('project', 1, 30, 40);
    const { rerender, unmount } = render(<ContextMenuContainer />);
    expect(item('Assign Equipment')).not.toHaveAttribute('aria-disabled', 'true');
    expect(item('Assign Equipment')).toBeEnabled();
    expect(item('Edit Project')).toBeDisabled();
    useUIStore.getState().showContextMenu('equipmentAssignment', 60, 0, 0, 1);
    rerender(<ContextMenuContainer />);
    expect(item('Edit Assignment')).toBeEnabled();
    expect(item('Delete Assignment')).toBeEnabled();
    unmount();

    seed(makeUser({ id: 31, role: 'editor', permissions: ['projects.view', 'projects.edit_any'] }));
    useUIStore.getState().showContextMenu('project', 1, 30, 40);
    const second = render(<ContextMenuContainer />);
    expect(item('Assign Equipment')).toBeDisabled();
    expect(item('Edit Project')).toBeEnabled();
    useUIStore.getState().showContextMenu('equipmentAssignment', 60, 0, 0, 1);
    second.rerender(<ContextMenuContainer />);
    expect(item('Edit Assignment')).toBeDisabled();
    expect(item('Delete Assignment')).toBeDisabled();
  });

  it('renders nothing while hidden', () => {
    const { container } = render(<ContextMenuContainer />);
    expect(container).toBeEmptyDOMElement();
  });
});
