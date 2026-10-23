/**
 * assignmentLock — the one rule behind the Gantt context menu's Edit and the
 * booking dialog's read-only state: my own open request first, then someone
 * else's pending join, then the edit right (managing others' bookings, or my
 * own row with assignments.self_update).
 */
import { describe, it, expect } from 'vitest';
import { ASSIGNMENT_LOCK_MESSAGES, assignmentLock } from '../pendingBookings';
import { makeProject, makeUser } from '@/test/factories';
import type { AssignmentApproval, StaffAssignment } from '@/types';

const ME = 4;
const me = makeUser({ id: ME, role: 'user' });
const editor = makeUser({ id: 9, role: 'superuser' });
const project = makeProject({ id: 1, pm_id: 2 });

function request(requester: number, action = 'assignments.self_update'): AssignmentApproval {
  return { request_id: 5, action, requester_id: requester, requested: {}, previous: null, created_at: null, can_decide: false };
}

function row(over: Partial<StaffAssignment> = {}): StaffAssignment {
  return { id: 1, staff_id: ME, allocation: 40, start_date: '', end_date: '', approval_status: 'approved', approval: null, ...over };
}

describe('assignmentLock', () => {
  it('lets me change my own approved booking, and an editor anyone\'s', () => {
    expect(assignmentLock(row(), me, project)).toBeNull();
    expect(assignmentLock(row({ staff_id: 7 }), editor, project)).toBeNull();
  });

  it('holds a row carrying my own open request, whatever my rights', () => {
    expect(assignmentLock(row({ approval: request(ME) }), me, project)).toBe('request-open');
    // My own pending join carries my request too.
    const myJoin = row({ approval_status: 'pending', approval: request(ME, 'assignments.self_create') });
    expect(assignmentLock(myJoin, me, project)).toBe('request-open');
    expect(assignmentLock(row({ staff_id: 9, approval: request(9) }), editor, project)).toBe('request-open');
  });

  it("locks someone else's pending join for everyone, editors included", () => {
    const join = row({ staff_id: 7, approval_status: 'pending', approval: request(7, 'assignments.self_create') });
    expect(assignmentLock(join, editor, project)).toBe('pending-other');
    expect(assignmentLock(join, me, project)).toBe('pending-other');
  });

  it("keeps an approved row with someone else's change request editable for an editor", () => {
    expect(assignmentLock(row({ staff_id: 7, approval: request(7) }), editor, project)).toBeNull();
  });

  it('says no-right for someone else\'s row, or my own without the own-booking key', () => {
    expect(assignmentLock(row({ staff_id: 7 }), me, project)).toBe('no-right');
    const noSelf = makeUser({ id: ME, role: 'viewer', permissions: ['projects.view'] });
    expect(assignmentLock(row(), noSelf, project)).toBe('no-right');
    expect(assignmentLock(row(), null, project)).toBe('no-right');
  });

  it('lets the project manager change anyone\'s booking on their project', () => {
    const pm = makeUser({ id: 2, role: 'user' });
    expect(assignmentLock(row({ staff_id: 7 }), pm, project)).toBeNull();
  });

  it('has a message for every lock', () => {
    expect(ASSIGNMENT_LOCK_MESSAGES).toEqual({
      'request-open': 'Your change request on this booking is open',
      'pending-other': 'This booking awaits approval',
      'no-right': 'You cannot change this booking',
    });
  });
});
