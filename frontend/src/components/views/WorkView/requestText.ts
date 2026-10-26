/**
 * The words My Work shows for an approval request, mirroring the server's
 * titles (app/services/approvals.py `_request_title`, `describe_change`,
 * `CLOSE_REASON_DETAILS`): to a decider, "Bob wants to join Design of
 * Bioprocess at 40%"; to the requester, "Join Design of Bioprocess at 40%".
 */

import { formatShortDateRange } from '@/utils/date';
import type { ApprovalRequest, ApprovalRequestStatus, BookingValues } from '@/types';

const CREATE = 'assignments.self_create';
const REMOVE = 'assignments.self_remove';

/** Why a request expired on its own (the server's close reasons). */
const CLOSE_REASONS: Record<string, string> = {
  target_deleted: 'the card or project it was about was deleted',
  requester_inactive: "the requester's account is no longer active",
  permission_lost: 'the requester may no longer book themself there',
  overtaken: 'the booking was changed since the request was made',
  duplicate: 'the requester is already booked there',
};

const OUTCOMES: Record<ApprovalRequestStatus, string> = {
  pending: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
  superseded: 'Replaced by a newer request',
  expired: 'Expired',
};

/** "Design of Bioprocess" — or the project alone for a project-level booking. */
export function requestTarget(request: ApprovalRequest): string {
  const project = request.project_name ?? 'a project';
  if (request.level === 'project' || !request.target_name) return project;
  return `${request.target_name} of ${project}`;
}

function dates(values: BookingValues | null): string | null {
  if (!values?.start_date || !values.end_date) return null;
  return formatShortDateRange(values.start_date, values.end_date);
}

function joinTerms(requested: BookingValues | null): string {
  const parts: string[] = [];
  if (requested?.allocation != null) parts.push(`at ${requested.allocation}%`);
  const range = dates(requested);
  return [parts.join(''), range].filter(Boolean).join(', ');
}

function changeTerms(request: ApprovalRequest): string {
  const before = request.previous ?? {};
  const after = request.requested ?? {};
  const parts: string[] = [];
  if (before.allocation !== after.allocation) {
    parts.push(`allocation ${before.allocation ?? '?'}% → ${after.allocation ?? '?'}%`);
  }
  const from = dates(before);
  const to = dates(after);
  if (from !== to) parts.push(`dates ${from ?? '?'} → ${to ?? '?'}`);
  return parts.join(', ');
}

/** What the request asks for, worded for its decider or for its requester. */
export function describeRequest(request: ApprovalRequest, reader: 'decider' | 'requester'): string {
  const target = requestTarget(request);
  const who = request.requester_name || 'Someone';
  if (request.action === CREATE) {
    const terms = joinTerms(request.requested);
    const base = reader === 'decider' ? `${who} wants to join ${target}` : `Join ${target}`;
    return terms ? `${base} ${terms}` : base;
  }
  if (request.action === REMOVE) {
    return reader === 'decider' ? `${who} wants to leave ${target}` : `Leave ${target}`;
  }
  const base =
    reader === 'decider'
      ? `${who} wants to change their booking on ${target}`
      : `Change your booking on ${target}`;
  const terms = changeTerms(request);
  return terms ? `${base}: ${terms}` : base;
}

/** The request's state in words: who decided it, or why it closed. */
export function requestOutcome(request: ApprovalRequest): string {
  const label = OUTCOMES[request.status] ?? request.status;
  if ((request.status === 'approved' || request.status === 'rejected') && request.decided_by_name) {
    return `${label} by ${request.decided_by_name}`;
  }
  if (request.status === 'expired' && request.close_reason && CLOSE_REASONS[request.close_reason]) {
    return `${label}: ${CLOSE_REASONS[request.close_reason]}`;
  }
  return label;
}
