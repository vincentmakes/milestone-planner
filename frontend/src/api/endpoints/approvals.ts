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

/** The History tab's page size (`limit`); a full page means there may be more. */
export const HISTORY_PAGE_SIZE = 50;

/**
 * One page of the approval history: `scope=decided` (the requests I decided
 * for someone else) or `scope=all` with `closed=true` (every closed request at
 * my sites, `approvals.view_all`). Ordered by when the request closed, newest
 * first; `before_id` = the id of the last row held continues after it.
 */
export interface HistoryParams {
  scope: 'decided' | 'all';
  closed?: boolean;
  status?: ApprovalRequestStatus;
  project_id?: number;
  requester_id?: number;
  decided_by?: number;
  before_id?: number;
  limit: number;
}

function historyUrl(params: HistoryParams): string {
  const query = new URLSearchParams({ scope: params.scope });
  if (params.closed) query.set('closed', 'true');
  if (params.status) query.set('status', params.status);
  const ids = ['project_id', 'requester_id', 'decided_by', 'before_id'] as const;
  for (const key of ids) {
    const value = params[key];
    if (value != null) query.set(key, String(value));
  }
  query.set('limit', String(params.limit));
  return `/api/approval-requests?${query.toString()}`;
}

export const approvalsApi = {
  /** The caller's own requests, newest first (optionally one status). */
  getMine: (status?: ApprovalRequestStatus) => apiGet<ApprovalRequest[]>(listUrl('mine', status)),

  /** The pending requests the caller may decide, newest first. */
  getToDecide: () => apiGet<ApprovalRequest[]>(listUrl('to_decide')),

  /** One page of the history (closed requests), see `HistoryParams`. */
  listHistory: (params: HistoryParams) => apiGet<ApprovalRequest[]>(historyUrl(params)),

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
