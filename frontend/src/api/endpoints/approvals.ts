/**
 * Approval requests API: own bookings awaiting a decision.
 *
 * Requests are filed by the self-booking routes themselves: when the
 * caller's `assignments.self_*` key is in approval mode they answer 202 with
 * a `PendingBookingResponse` instead of the row (`isPendingResponse` tells
 * the two apart — a successful call does not expose its HTTP status). This
 * module lists and decides them; the server checks who may (`can_decide` on a
 * row or a request mirrors it). What-If exempt (see ../client.ts): a decision
 * is never part of the sandbox.
 */

import { apiGet, apiPost } from '../client';
import type {
  ApprovalDecisionResult,
  ApprovalRequest,
  ApprovalRequestStatus,
  PendingBookingResponse,
} from '@/types';

/** The flash shown after a write that filed a request instead. */
export const SENT_FOR_APPROVAL = 'Sent for approval';

/** Whether a write's response is the 202 "sent for approval" body. */
export function isPendingResponse(res: unknown): res is PendingBookingResponse {
  if (!res || typeof res !== 'object') return false;
  const body = res as Record<string, unknown>;
  return body.pending === true && typeof body.request_id === 'number';
}

function decisionBody(note?: string): { note?: string } {
  const trimmed = note?.trim();
  return trimmed ? { note: trimmed } : {};
}

function listUrl(scope: 'mine' | 'to_decide', status?: ApprovalRequestStatus): string {
  const params = new URLSearchParams({ scope });
  if (status) params.set('status', status);
  return `/api/approval-requests?${params.toString()}`;
}

export const approvalsApi = {
  /** The caller's own requests, newest first (optionally one status). */
  getMine: (status?: ApprovalRequestStatus) => apiGet<ApprovalRequest[]>(listUrl('mine', status)),

  /** The pending requests the caller may decide, newest first. */
  getToDecide: () => apiGet<ApprovalRequest[]>(listUrl('to_decide')),

  /** One request (the requester, an approver, or `approvals.view_all`). */
  get: (id: number) => apiGet<ApprovalRequest>(`/api/approval-requests/${id}`),

  /** Approve (an eligible approver); 409 when no longer pending or no longer applicable. */
  approve: (id: number, note?: string) =>
    apiPost<ApprovalDecisionResult>(`/api/approval-requests/${id}/approve`, decisionBody(note)),

  /** Reject with an optional reason for the requester. */
  reject: (id: number, note?: string) =>
    apiPost<ApprovalDecisionResult>(`/api/approval-requests/${id}/reject`, decisionBody(note)),

  /** Withdraw one's own request. */
  cancel: (id: number) => apiPost<ApprovalDecisionResult>(`/api/approval-requests/${id}/cancel`, {}),
};
