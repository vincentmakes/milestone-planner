/**
 * Client side of the 202 "sent for approval" contract: who the badge says
 * decides, how a filed request is shown locally before the reload, and the
 * reload a dragged own bar needs (its optimistic move cannot stand).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  approverSummary,
  flashSentForApproval,
  markRequestPendingLocally,
  reloadAfterPendingWrite,
} from '../pendingBookings';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { loadAllProjects } from '@/api/endpoints/projects';
import { makeProject, makeSystemRoles, makeRole } from '@/test/factories';
import type { ApprovalPolicy, Phase } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({ loadAllProjects: vi.fn() }));

const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  action: 'assignments.self_create',
  label: 'Book own time',
  pm_approves: true,
  role_ids: [],
  ...over,
});

describe('approverSummary', () => {
  const roles = makeSystemRoles(makeRole({ id: 4, name: 'Team lead' }), makeRole({ id: 5, key: 'hr', name: 'HR' }));

  it('names the project manager, the policy roles and the administrators', () => {
    expect(approverSummary(policy({ role_ids: [4, 5] }), roles, 'Fiona Fischer')).toBe(
      'Awaiting approval by Fiona Fischer (project manager), Team lead, HR or an administrator'
    );
  });

  it('falls back to the administrators without a manager or roles', () => {
    expect(approverSummary(policy(), roles, null)).toBe('Awaiting approval by an administrator');
    expect(approverSummary(policy({ pm_approves: false }), roles, 'Fiona Fischer')).toBe(
      'Awaiting approval by an administrator'
    );
  });

  it('does not name the admin role twice and skips unknown role ids', () => {
    expect(approverSummary(policy({ pm_approves: false, role_ids: [1, 99, 4] }), roles, null)).toBe(
      'Awaiting approval by Team lead or an administrator'
    );
  });

  it('says only "Awaiting approval" while the policy is unknown', () => {
    expect(approverSummary(undefined, roles, 'Fiona Fischer')).toBe('Awaiting approval');
  });
});

describe('markRequestPendingLocally', () => {
  beforeEach(() => {
    const phase = {
      id: 3,
      project_id: 1,
      name: 'Design',
      children: [],
      staffAssignments: [{ id: 9, staff_id: 4, allocation: 40, start_date: '', end_date: '' }],
      equipmentAssignments: [],
    } as unknown as Phase;
    useAppStore.setState({ projects: [makeProject({ phases: [phase] })] });
  });

  it('attaches the open request to the row and leaves its values alone', () => {
    markRequestPendingLocally(1, 9, 'phase', 4, 'assignments.self_update', {
      success: true,
      pending: true,
      request_id: 31,
      id: 9,
    }, { allocation: 60 });
    const row = useAppStore.getState().projects[0].phases[0].staffAssignments[0];
    expect(row.allocation).toBe(40);
    expect(row.approval).toEqual({
      request_id: 31,
      action: 'assignments.self_update',
      requester_id: 4,
      requested: { allocation: 60 },
      previous: { allocation: 40 },
      created_at: null,
      can_decide: false,
    });
  });
});

describe('flashSentForApproval / reloadAfterPendingWrite', () => {
  beforeEach(() => {
    useUIStore.setState({ flashNotice: null });
    vi.mocked(loadAllProjects).mockReset();
  });

  it('flashes the info notice', () => {
    flashSentForApproval();
    expect(useUIStore.getState().flashNotice).toMatchObject({ message: 'Sent for approval', tone: 'info' });
  });

  it('counts several bookings sent for approval at once', () => {
    flashSentForApproval(3);
    expect(useUIStore.getState().flashNotice).toMatchObject({ message: '3 bookings sent for approval', tone: 'info' });
    flashSentForApproval(1);
    expect(useUIStore.getState().flashNotice?.message).toBe('Sent for approval');
  });

  it('reloads the projects, clears the undo history and flashes', async () => {
    const fresh = [makeProject({ id: 7 })];
    vi.mocked(loadAllProjects).mockResolvedValue(fresh);
    useUndoStore.getState().saveState([], 'Move');
    const clear = vi.spyOn(useUndoStore.getState(), 'clear');

    await reloadAfterPendingWrite();

    expect(useAppStore.getState().projects).toBe(fresh);
    expect(clear).toHaveBeenCalled();
    expect(useUIStore.getState().flashNotice?.message).toBe('Sent for approval');
  });

  it('still clears the history and flashes when the reload fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(loadAllProjects).mockRejectedValue(new Error('offline'));
    const clear = vi.spyOn(useUndoStore.getState(), 'clear');
    await reloadAfterPendingWrite();
    expect(clear).toHaveBeenCalled();
    expect(useUIStore.getState().flashNotice?.message).toBe('Sent for approval');
    error.mockRestore();
  });
});
