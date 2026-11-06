/**
 * The History pickers' options: people from the users, the staff and the
 * rows held (deciders are often not bookable); projects from the loaded ones
 * and the rows; inactive people left out; a name once seen stays.
 */
import { describe, it, expect } from 'vitest';
import { historyPeople, historyProjects } from '../historyOptions';
import { makeApprovalRequest, makeProject, makeUser } from '@/test/factories';
import type { Staff } from '@/types';

const staff = (id: number, name: string, active = true): Staff => ({ id, name, site_id: 1, active });

describe('historyPeople', () => {
  it('merges active users, active staff and the rows, sorted by name', () => {
    const seen = new Map<number, string>();
    const options = historyPeople(
      seen,
      [makeUser({ id: 1, name: 'Zoe Admin' }), makeUser({ id: 2, name: 'Gone User', active: false })],
      [staff(3, 'Bob Brown'), staff(1, 'Zoe as staff'), staff(5, 'Left Staff', false)],
      [
        makeApprovalRequest({ requester_id: 7, requester_name: 'Alice Smith', decided_by: 9, decided_by_name: 'Mia PM' }),
        makeApprovalRequest({ requester_id: 8, requester_name: null, decided_by: null, decided_by_name: null }),
      ]
    );
    expect(options).toEqual([
      { id: 7, label: 'Alice Smith' },
      { id: 3, label: 'Bob Brown' },
      { id: 9, label: 'Mia PM' },
      { id: 1, label: 'Zoe Admin' },
    ]);
  });

  it('names a user without a display name from their first and last name', () => {
    const options = historyPeople(new Map(), [makeUser({ id: 4, name: '', first_name: 'Ada', last_name: 'Lovelace' })], [], []);
    expect(options).toEqual([{ id: 4, label: 'Ada Lovelace' }]);
  });

  it('keeps a person seen before once the rows no longer show them', () => {
    const seen = new Map<number, string>();
    historyPeople(seen, [], [], [makeApprovalRequest({ requester_id: 7, requester_name: 'Alice Smith' })]);
    expect(historyPeople(seen, [], [], [])).toEqual([{ id: 7, label: 'Alice Smith' }]);
  });
});

describe('historyProjects', () => {
  it('lists the loaded projects and the rows projects, sorted by name', () => {
    const seen = new Map<number, string>();
    const options = historyProjects(
      seen,
      [makeProject({ id: 2, name: 'Trial' })],
      [
        makeApprovalRequest({ project_id: 5, project_name: 'Berlin Pilot' }),
        makeApprovalRequest({ project_id: 6, project_name: null }),
        makeApprovalRequest({ project_id: 2, project_name: 'Trial (row)' }),
      ]
    );
    expect(options).toEqual([
      { id: 5, label: 'Berlin Pilot' },
      { id: 2, label: 'Trial' },
    ]);
  });
});
