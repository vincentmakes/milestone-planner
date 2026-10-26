/**
 * collectMyAssignments: one row per approved booking of the user at every
 * level (project, phase, subphases at any depth), pending rows and archived
 * projects left out, card rows at their effective days, the upcoming cut-off
 * at today (inclusive), sorted by start, project name, id.
 */
import { describe, it, expect } from 'vitest';
import { collectMyAssignments } from '../myAssignments';
import { makePhase, makeProject, makeSubphase } from '@/test/factories';
import type { StaffAssignment } from '@/types';

const ME = 4;

function row(overrides: Partial<StaffAssignment>): StaffAssignment {
  return {
    id: 1,
    staff_id: ME,
    staff_name: 'Bob Brown',
    allocation: 50,
    start_date: '2026-03-02',
    end_date: '2026-03-06',
    approval_status: 'approved',
    approval: null,
    ...overrides,
  };
}

const deepChild = makeSubphase({
  id: 30,
  name: 'Calibration',
  start_date: '2026-02-02',
  end_date: '2026-02-06',
  staffAssignments: [row({ id: 300, linked: true, start_date: '2026-02-02', end_date: '2026-02-06' })],
});
const subphase = makeSubphase({
  id: 20,
  name: 'Literature review',
  start_date: '2026-01-05',
  end_date: '2026-01-30',
  children: [deepChild],
  staffAssignments: [
    // Unlinked: its own days inside the card
    row({ id: 200, linked: false, start_date: '2026-01-12T00:00:00.000Z', end_date: '2026-01-16' }),
    // Someone else's
    row({ id: 201, staff_id: 7 }),
  ],
});
const phase = makePhase({
  id: 10,
  name: 'Feasibility',
  start_date: '2026-01-05',
  end_date: '2026-02-27',
  children: [subphase],
  staffAssignments: [
    // Linked, built locally without dates of its own: the card's days
    row({ id: 100, linked: undefined, start_date: '', end_date: '' }),
    // My pending join: a request, not a booking
    row({ id: 101, approval_status: 'pending' }),
  ],
});
const project = makeProject({
  id: 1,
  name: 'Bioprocess Scale-Up',
  phases: [phase],
  staffAssignments: [row({ id: 1, linked: false, start_date: '2026-03-02', end_date: '2026-03-06' })],
});
const archived = makeProject({
  id: 2,
  name: 'Old trial',
  archived: true,
  staffAssignments: [row({ id: 2, start_date: '2026-01-01', end_date: '2026-12-31' })],
});

describe('collectMyAssignments', () => {
  it('collects my approved bookings at every level, sorted by start', () => {
    const rows = collectMyAssignments([project, archived], ME, '2026-01-01');
    expect(rows.map((r) => r.key)).toEqual(['phase:100', 'subphase:200', 'subphase:300', 'project:1']);
  });

  it('fills the row ids from where it was found and reads effective dates', () => {
    const rows = collectMyAssignments([project], ME, '2026-01-01');
    const byKey = new Map(rows.map((r) => [r.key, r]));

    const onPhase = byKey.get('phase:100')!;
    expect(onPhase).toMatchObject({ level: 'phase', start: '2026-01-05', end: '2026-02-27', linked: true });
    expect(onPhase.card).toBe(phase);
    expect(onPhase.assignment).toMatchObject({ project_id: 1, phase_id: 10, subphase_id: null });

    const segment = byKey.get('subphase:200')!;
    expect(segment).toMatchObject({ level: 'subphase', start: '2026-01-12', end: '2026-01-16', linked: false });
    expect(segment.assignment).toMatchObject({ project_id: 1, phase_id: 10, subphase_id: 20 });

    const deep = byKey.get('subphase:300')!;
    expect(deep.card).toBe(deepChild);
    expect(deep.assignment).toMatchObject({ phase_id: 10, subphase_id: 30 });

    const whole = byKey.get('project:1')!;
    expect(whole).toMatchObject({ level: 'project', card: null, linked: false, start: '2026-03-02' });
    expect(whole.assignment).toMatchObject({ project_id: 1, phase_id: null, subphase_id: null });
  });

  it('leaves out pending rows, other people and archived projects', () => {
    const keys = collectMyAssignments([project, archived], ME, '2026-01-01').map((r) => r.key);
    expect(keys).not.toContain('phase:101');
    expect(keys).not.toContain('subphase:201');
    expect(keys).not.toContain('project:2');
    expect(collectMyAssignments([project], 99, '2026-01-01')).toEqual([]);
  });

  it('marks as upcoming what ends today or later', () => {
    const rows = collectMyAssignments([project], ME, '2026-02-06');
    const upcoming = Object.fromEntries(rows.map((r) => [r.key, r.upcoming]));
    expect(upcoming).toEqual({
      'phase:100': true,
      'subphase:200': false,
      // Ends on the day: still current
      'subphase:300': true,
      'project:1': true,
    });
  });

  it('breaks start ties by project name, then by row id', () => {
    const a = makeProject({
      id: 5,
      name: 'Alpha',
      staffAssignments: [row({ id: 9 }), row({ id: 3 })],
    });
    const z = makeProject({ id: 6, name: 'Zeta', staffAssignments: [row({ id: 1 })] });
    const rows = collectMyAssignments([z, a], ME, '2026-01-01');
    expect(rows.map((r) => `${r.project.name}:${r.assignment.id}`)).toEqual(['Alpha:3', 'Alpha:9', 'Zeta:1']);
  });

  it('tolerates projects and cards without assignment lists', () => {
    const bare = { ...makeProject({ id: 7 }), staffAssignments: undefined, phases: undefined } as never;
    expect(collectMyAssignments([bare], ME, '2026-01-01')).toEqual([]);
  });
});
