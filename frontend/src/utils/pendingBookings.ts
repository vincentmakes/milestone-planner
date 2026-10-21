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
import type { ApprovableKey } from '@/types/permissions';
import type {
  ApprovalPolicy,
  BookingValues,
  PendingBookingResponse,
  Role,
} from '@/types';
import { ADMIN_ROLE_KEY } from '@/types/permissions';

/** The info flash after a write that filed a request instead. */
export function flashSentForApproval(): void {
  useUIStore.getState().showFlash(SENT_FOR_APPROVAL, 'info');
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
