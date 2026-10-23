/**
 * The sentences My Work shows for an approval request: what the requester
 * asks for (to a decider) or asked for (to the requester), and its outcome.
 */
import { describe, it, expect } from 'vitest';
import { describeRequest, requestOutcome, requestTarget } from '../requestText';
import { makeApprovalRequest } from '@/test/factories';
import { formatShortDateRange } from '@/utils/date';

describe('requestTarget', () => {
  it('names the card and its project, or the project alone at project level', () => {
    expect(requestTarget(makeApprovalRequest())).toBe('Feasibility of Bioprocess Scale-Up');
    expect(requestTarget(makeApprovalRequest({ level: 'project', target_name: 'Bioprocess Scale-Up' }))).toBe('Bioprocess Scale-Up');
    expect(requestTarget(makeApprovalRequest({ target_name: null }))).toBe('Bioprocess Scale-Up');
    expect(requestTarget(makeApprovalRequest({ target_name: null, project_name: null }))).toBe('a project');
  });
});

describe('describeRequest', () => {
  it('words a join, with the dates of a project-level booking', () => {
    expect(describeRequest(makeApprovalRequest(), 'decider')).toBe('Bob Brown wants to join Feasibility of Bioprocess Scale-Up at 40%');
    expect(describeRequest(makeApprovalRequest(), 'requester')).toBe('Join Feasibility of Bioprocess Scale-Up at 40%');
    const dated = makeApprovalRequest({
      level: 'project',
      requested: { allocation: 50, start_date: '2026-11-02', end_date: '2026-11-20' },
    });
    expect(describeRequest(dated, 'requester')).toBe(
      `Join Bioprocess Scale-Up at 50%, ${formatShortDateRange('2026-11-02', '2026-11-20')}`
    );
  });

  it('words a change of allocation and of dates', () => {
    const change = makeApprovalRequest({
      action: 'assignments.self_update',
      previous: { allocation: 40 },
      requested: { allocation: 60 },
    });
    expect(describeRequest(change, 'decider')).toBe('Bob Brown wants to change their booking on Feasibility of Bioprocess Scale-Up: allocation 40% → 60%');
    expect(describeRequest(change, 'requester')).toBe('Change your booking on Feasibility of Bioprocess Scale-Up: allocation 40% → 60%');
    const dates = makeApprovalRequest({
      action: 'assignments.self_update',
      level: 'project',
      previous: { allocation: 40, start_date: '2026-11-02', end_date: '2026-11-06' },
      requested: { allocation: 40, start_date: '2026-11-09', end_date: '2026-11-13' },
    });
    expect(describeRequest(dates, 'requester')).toBe(
      `Change your booking on Bioprocess Scale-Up: dates ${formatShortDateRange('2026-11-02', '2026-11-06')} → ${formatShortDateRange('2026-11-09', '2026-11-13')}`
    );
    const same = makeApprovalRequest({ action: 'assignments.self_update', previous: { allocation: 40 }, requested: { allocation: 40 } });
    expect(describeRequest(same, 'requester')).toBe('Change your booking on Feasibility of Bioprocess Scale-Up');
  });

  it('words a removal, and a requester without a name', () => {
    const leave = makeApprovalRequest({ action: 'assignments.self_remove', requester_name: null, requested: null });
    expect(describeRequest(leave, 'decider')).toBe('Someone wants to leave Feasibility of Bioprocess Scale-Up');
    expect(describeRequest(leave, 'requester')).toBe('Leave Feasibility of Bioprocess Scale-Up');
  });

  it('words a join without an allocation', () => {
    expect(describeRequest(makeApprovalRequest({ requested: null }), 'requester')).toBe('Join Feasibility of Bioprocess Scale-Up');
  });
});

describe('requestOutcome', () => {
  it('says who decided, and why a request closed on its own', () => {
    expect(requestOutcome(makeApprovalRequest())).toBe('Awaiting approval');
    expect(requestOutcome(makeApprovalRequest({ status: 'approved', decided_by_name: 'Alice' }))).toBe('Approved by Alice');
    expect(requestOutcome(makeApprovalRequest({ status: 'rejected', decided_by_name: null }))).toBe('Rejected');
    expect(requestOutcome(makeApprovalRequest({ status: 'cancelled' }))).toBe('Withdrawn');
    expect(requestOutcome(makeApprovalRequest({ status: 'superseded' }))).toBe('Replaced by a newer request');
    expect(requestOutcome(makeApprovalRequest({ status: 'expired', close_reason: 'overtaken' }))).toBe('Expired: the booking was changed since the request was made');
    expect(requestOutcome(makeApprovalRequest({ status: 'expired', close_reason: 'something_new' }))).toBe('Expired');
    expect(requestOutcome(makeApprovalRequest({ status: 'expired' }))).toBe('Expired');
  });
});
