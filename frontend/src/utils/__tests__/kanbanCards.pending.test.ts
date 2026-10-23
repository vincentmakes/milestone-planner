/**
 * Pending bookings (an own booking awaiting approval) on the derived cards.
 *
 * A pending create is a real row with `approval_status: 'pending'`; a pending
 * change or removal leaves the row approved and carries the open request in
 * `approval`. Only approved rows are assignees (card_access.py: a pending
 * assignee may not move the card, and gets no due reminders).
 */

import { describe, it, expect } from 'vitest';
import {
  assigneeIdsOf,
  collectProjectCards,
  isPendingAssignment,
  isRemovalRequested,
  pendingAssigneeIdsOf,
  requestedAllocation,
} from '../kanbanCards';
import type { AssignmentApproval, Phase, Project, StaffAssignment } from '@/types';

function approval(over: Partial<AssignmentApproval> = {}): AssignmentApproval {
  return {
    request_id: 31,
    action: 'assignments.self_create',
    requester_id: 4,
    requested: { allocation: 60 },
    previous: null,
    created_at: '2026-10-20T08:00:00.000Z',
    can_decide: false,
    ...over,
  };
}

function row(id: number, staffId: number, over: Partial<StaffAssignment> = {}): StaffAssignment {
  return {
    id,
    staff_id: staffId,
    staff_name: `Staff ${staffId}`,
    allocation: 40,
    start_date: '2026-01-01',
    end_date: '2026-01-31',
    ...over,
  };
}

const pendingCreate = row(2, 4, { approval_status: 'pending', approval: approval() });
const pendingChange = row(3, 5, {
  approval_status: 'approved',
  approval: approval({ action: 'assignments.self_update', requester_id: 5, requested: { allocation: 60 }, previous: { allocation: 40 } }),
});
const pendingRemoval = row(4, 6, {
  approval_status: 'approved',
  approval: approval({ action: 'assignments.self_remove', requester_id: 6, requested: null, previous: { allocation: 40 } }),
});
const approved = row(1, 7);

describe('isPendingAssignment', () => {
  it('is true only for a pending create', () => {
    expect(isPendingAssignment(pendingCreate)).toBe(true);
    expect(isPendingAssignment(pendingChange)).toBe(false);
    expect(isPendingAssignment(pendingRemoval)).toBe(false);
    expect(isPendingAssignment(approved)).toBe(false);
    // Older servers send no status at all: approved.
    expect(isPendingAssignment(row(9, 9, { approval_status: undefined }))).toBe(false);
  });
});

describe('requestedAllocation', () => {
  it('is the requested value of an open change that differs from the row', () => {
    expect(requestedAllocation(pendingChange)).toBe(60);
  });

  it('is null without a change request or when the allocation is unchanged', () => {
    expect(requestedAllocation(approved)).toBeNull();
    expect(requestedAllocation(pendingCreate)).toBeNull();
    expect(requestedAllocation(pendingRemoval)).toBeNull();
    expect(
      requestedAllocation(
        row(5, 5, { approval: approval({ action: 'assignments.self_update', requested: { start_date: '2026-02-01' } }) })
      )
    ).toBeNull();
    expect(
      requestedAllocation(
        row(5, 5, { approval: approval({ action: 'assignments.self_update', requested: { allocation: 40 } }) })
      )
    ).toBeNull();
  });
});

describe('isRemovalRequested', () => {
  it('is true only for an open removal request', () => {
    expect(isRemovalRequested(pendingRemoval)).toBe(true);
    expect(isRemovalRequested(pendingChange)).toBe(false);
    expect(isRemovalRequested(pendingCreate)).toBe(false);
    expect(isRemovalRequested(approved)).toBe(false);
  });
});

describe('assignee ids', () => {
  const rows = [approved, pendingCreate, pendingChange, pendingRemoval, row(8, 7)];

  it('assigneeIdsOf counts approved rows only, once each', () => {
    // A pending change or removal keeps the person assigned until decided.
    expect(assigneeIdsOf(rows)).toEqual([7, 5, 6]);
  });

  it('pendingAssigneeIdsOf lists the people awaiting approval', () => {
    expect(pendingAssigneeIdsOf(rows)).toEqual([4]);
  });

  it('a person with an approved and a pending row is an assignee, not pending', () => {
    const both = [row(1, 4), pendingCreate];
    expect(assigneeIdsOf(both)).toEqual([4]);
    expect(pendingAssigneeIdsOf(both)).toEqual([]);
  });
});

describe('collectProjectCards', () => {
  it('fills pendingAssigneeIds next to the approved assigneeIds', () => {
    const leaf: Phase = {
      id: 1,
      project_id: 1,
      name: 'Design',
      start_date: '2026-01-01',
      end_date: '2026-01-31',
      color: '#000',
      order_index: 0,
      completion: null,
      status: 'todo',
      is_milestone: false,
      dependencies: [],
      children: [],
      staffAssignments: [approved, pendingCreate],
      equipmentAssignments: [],
    };
    const project = { id: 1, name: 'P', phases: [leaf], staffAssignments: [], equipmentAssignments: [] } as unknown as Project;
    const [card] = collectProjectCards(project);
    expect(card.assigneeIds).toEqual([7]);
    expect(card.pendingAssigneeIds).toEqual([4]);
    // The card still lists every row, so the modal can show the pending one.
    expect(card.assignments).toHaveLength(2);
  });
});
