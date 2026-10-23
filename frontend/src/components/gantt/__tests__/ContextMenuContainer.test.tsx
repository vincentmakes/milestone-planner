/**
 * The subphase context menu resolves its target at any depth.
 *
 * SubphaseRow opens the menu with the top-level phase id even for nested
 * rows, so a lookup limited to the phase's direct children left a depth-2
 * subphase without a target: "Assign me" was disabled and "Edit Subphase"
 * did nothing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ContextMenuContainer } from '../ContextMenuContainer';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { createStaffAssignment, deletePhase, deleteSubphase } from '@/api';
import { recoverFromPersistFailure } from '@/utils/persistFailure';
import type { Phase, Project, Subphase } from '@/types';
import { stubConfirm } from '@/test/confirmDialog';
import { makeUser } from '@/test/factories';

vi.mock('@/api', () => ({
  deleteProject: vi.fn(),
  deletePhase: vi.fn(),
  deleteSubphase: vi.fn(),
  deleteStaffAssignment: vi.fn(),
  deleteEquipmentAssignment: vi.fn(),
  createStaffAssignment: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/utils/persistFailure', () => ({
  recoverFromPersistFailure: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/useDataLoader', () => ({
  useDataLoader: () => ({ refreshProjects: vi.fn() }),
}));

function makeSubphase(overrides: Partial<Subphase>): Subphase {
  return {
    id: 0,
    project_id: 1,
    parent_phase_id: null,
    parent_subphase_id: null,
    name: 'Subphase',
    start_date: '2026-09-01',
    end_date: '2026-09-30',
    color: '#3b82f6',
    order_index: 0,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies: [],
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
    ...overrides,
  };
}

const nested = makeSubphase({
  id: 30,
  parent_subphase_id: 20,
  name: 'Calibration',
  start_date: '2026-09-10',
  end_date: '2026-09-15',
});
const child = makeSubphase({ id: 20, parent_phase_id: 10, name: 'Setup', children: [nested] });

const phase = {
  id: 10,
  project_id: 1,
  name: 'Design',
  start_date: '2026-09-01',
  end_date: '2026-09-30',
  color: '#3b82f6',
  order_index: 0,
  completion: null,
  status: 'todo',
  is_milestone: false,
  dependencies: [],
  children: [child],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Phase;

const project = {
  id: 1,
  name: 'Bioprocess Scale-Up',
  pm_id: 99,
  phases: [phase],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

const plainUser = makeUser({ id: 7, role: 'user', max_capacity: 80 });

beforeEach(() => {
  vi.mocked(createStaffAssignment).mockClear();
  useAppStore.setState({ projects: [project], staff: [], currentUser: plainUser });
  // Nested rows pass the top-level phase id, exactly as SubphaseRow does.
  useUIStore.getState().showContextMenu('subphase', nested.id, 10, 10, project.id, phase.id);
});

describe('ContextMenuContainer subphase target', () => {
  it('enables "Assign me" on a depth-2 subphase for a plain user', () => {
    render(<ContextMenuContainer />);

    expect(screen.getByRole('menuitem', { name: /assign me/i })).toBeEnabled();
  });

  it('books the nested subphase as a linked booking (no dates: it follows the subphase)', async () => {
    render(<ContextMenuContainer />);

    fireEvent.click(screen.getByRole('menuitem', { name: /assign me/i }));

    await waitFor(() => expect(createStaffAssignment).toHaveBeenCalledTimes(1));
    expect(createStaffAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        staff_id: 7,
        allocation: 80,
        project_id: 1,
        subphase_id: 30,
      })
    );
    const body = vi.mocked(createStaffAssignment).mock.calls[0][0];
    expect(body).not.toHaveProperty('start_date');
    expect(body).not.toHaveProperty('end_date');
  });

  it('offers "Assign me again" once the user is booked on the nested subphase', () => {
    const booked = makeSubphase({
      ...nested,
      staffAssignments: [{ id: 5, staff_id: 7 } as unknown as Subphase['staffAssignments'][number]],
    });
    const bookedProject = {
      ...project,
      phases: [{ ...phase, children: [{ ...child, children: [booked] }] }],
    } as unknown as Project;
    useAppStore.setState({ projects: [bookedProject] });

    render(<ContextMenuContainer />);

    expect(screen.getByRole('menuitem', { name: 'Assign me again' })).toBeEnabled();
  });
});

/**
 * A failed delete follows the persist-failure protocol (reload + clear undo)
 * and tells the user, instead of being an unhandled rejection with the tree
 * left as it was (F2-17).
 */
describe('ContextMenuContainer deletes', () => {
  const admin = makeUser({ id: 1, role: 'admin', max_capacity: 100 });

  it.each([
    ['phase', 'Delete Phase', 10, deletePhase],
    ['subphase', 'Delete Subphase', 20, deleteSubphase],
  ] as const)('recovers when deleting a %s fails', async (kind, label, id, deleteFn) => {
    const error = new Error('Server unavailable');
    vi.mocked(deleteFn).mockRejectedValueOnce(error);
    vi.mocked(recoverFromPersistFailure).mockClear();
    stubConfirm(true);
    useAppStore.setState({ currentUser: admin });
    useUIStore.getState().showContextMenu(kind, id, 10, 10, project.id, phase.id);

    render(<ContextMenuContainer />);
    fireEvent.click(screen.getByRole('menuitem', { name: label }));

    await waitFor(() => expect(recoverFromPersistFailure).toHaveBeenCalledWith(`Delete ${kind}`, error));
    await waitFor(() => expect(useUIStore.getState().flashNotice?.message).toContain('Server unavailable'));
    expect(useUIStore.getState().flashNotice?.tone).toBe('error');
    // Nothing was removed locally
    expect(useAppStore.getState().projects[0].phases[0].children[0].id).toBe(20);

  });
});

