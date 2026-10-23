/**
 * Own bookings awaiting approval — the client side of the 202 contract.
 *
 * The server decides whether an own booking needs approval: the same write
 * either applies (200/201) or files a request and answers 202
 * (`isPendingResponse`). The client never bypasses it; it only shows what
 * came back:
 * - a create → reload (the pending row arrives dashed) + "Sent for approval";
 * - a change or removal → `markRequestPendingLocally` (the row keeps its
 *   values, the open request is attached) until the reload;
 * - an own bar drag/resize → `reloadAfterPendingWrite`: the optimistic move
 *   cannot stand, so the server state comes back and the undo history (taken
 *   against the moved bar) is cleared.
 */

import { loadAllProjects } from '@/api/endpoints/projects';
import { SENT_FOR_APPROVAL } from '@/api/endpoints/approvals';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { findStaffAssignment, patchStaffAssignmentLocally, type AssignmentLevel } from './localProjectTree';
import { isPendingAssignment } from './kanbanCards';
import { canEditAssignment, type ProjectLike, type UserLike } from './permissions';
import type { ApprovableKey } from '@/types/permissions';
import type {
  ApprovalPolicy,
  BookingValues,
  PendingBookingResponse,
  Role,
  StaffAssignment,
} from '@/types';
import { ADMIN_ROLE_KEY } from '@/types/permissions';

/**
 * Why a booking cannot be changed by this user, or null when it can — the
 * one rule behind the Gantt context menu's Edit and the booking dialog's
 * read-only state (the dialog reached from My Work too):
 * - `'request-open'`: the row carries an open request of mine (my pending
 *   join, change or removal) — only Cancel request is offered;
 * - `'pending-other'`: someone else's pending join — locked for everyone,
 *   deciders approve or reject it;
 * - `'no-right'`: neither managing others' bookings on the project nor my
 *   own row with `assignments.self_update` (allow or approval).
 * An approved row carrying someone else's change request stays editable for
 * whoever may change it (their write expires the request server-side).
 */
export type AssignmentLock = 'request-open' | 'pending-other' | 'no-right';

export function assignmentLock(
  row: Pick<StaffAssignment, 'approval_status' | 'approval'> & { staff_id: number | null | undefined },
  user: UserLike | null | undefined,
  project: ProjectLike | null | undefined
): AssignmentLock | null {
  const request = row.approval ?? null;
  if (request && user && request.requester_id === user.id) return 'request-open';
  if (isPendingAssignment(row)) return 'pending-other';
  if (!canEditAssignment(user, project, row.staff_id)) return 'no-right';
  return null;
}

/** What the booking dialog says when `assignmentLock` holds it read-only. */
export const ASSIGNMENT_LOCK_MESSAGES: Record<AssignmentLock, string> = {
  'request-open': 'Your change request on this booking is open',
  'pending-other': 'This booking awaits approval',
  'no-right': 'You cannot change this booking',
};

/**
 * The info flash after a write that filed a request instead; `count` > 1
 * (a What-If Apply replaying several own bookings) names how many.
 */
export function flashSentForApproval(count = 1): void {
  const message = count > 1 ? `${count} bookings sent for approval` : SENT_FOR_APPROVAL;
  useUIStore.getState().showFlash(message, 'info');
}

/**
 * After an optimistic write answered 202: bring the server state back, drop
 * the undo history (its snapshots straddle the move that did not happen) and
 * tell the user. A failed reload is logged; the history is cleared anyway.
 */
export async function reloadAfterPendingWrite(): Promise<void> {
  try {
    useAppStore.getState().setProjects(await loadAllProjects());
  } catch (err) {
    console.error('[Approvals] reload after a pending write failed:', err);
  } finally {
    useUndoStore.getState().clear();
    flashSentForApproval();
  }
}

/**
 * Show a change or removal that was sent for approval: the row keeps its
 * values (they still count) and carries the open request, so it renders
 * "40% → 60%" / "Removal requested" before the reload confirms it.
 */
export function markRequestPendingLocally(
  projectId: number,
  assignmentId: number,
  level: AssignmentLevel,
  requesterId: number,
  action: ApprovableKey,
  res: PendingBookingResponse,
  requested: BookingValues | null
): void {
  const row = findStaffAssignment(
    useAppStore.getState().projects.find((p) => p.id === projectId),
    level,
    assignmentId
  );
  patchStaffAssignmentLocally(projectId, assignmentId, level, {
    approval: {
      request_id: res.request_id,
      action,
      requester_id: requesterId,
      requested,
      previous: row ? { allocation: row.allocation } : null,
      created_at: null,
      can_decide: false,
    },
  });
}

/**
 * Who decides a request, for the pending badge's tooltip: the project's
 * manager when the policy lets managers approve, the policy's roles, and
 * always the administrators. Without the policy (not loaded yet) the text
 * names nobody.
 */
export function approverSummary(
  policy: ApprovalPolicy | undefined,
  roles: readonly Role[],
  pmName: string | null | undefined
): string {
  if (!policy) return 'Awaiting approval';
  const names: string[] = [];
  if (policy.pm_approves && pmName) names.push(`${pmName} (project manager)`);
  for (const id of policy.role_ids) {
    const role = roles.find((r) => r.id === id);
    if (role && role.key !== ADMIN_ROLE_KEY) names.push(role.name);
  }
  names.push('an administrator');
  const last = names.pop()!;
  return `Awaiting approval by ${names.length > 0 ? `${names.join(', ')} or ` : ''}${last}`;
}
