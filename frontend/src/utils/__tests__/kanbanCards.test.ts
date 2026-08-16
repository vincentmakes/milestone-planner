/**
 * Leaf-card derivation: a card is a leaf work item, a parent phase is a lane.
 */

import { describe, it, expect } from 'vitest';
import { collectProjectCards, groupCards, cardsForColumn, cardKey } from '../kanbanCards';
import type { Phase, Project, StaffAssignment, Subphase } from '@/types';

function sub(id: number, name: string, over: Partial<Subphase> = {}): Subphase {
  return {
    id,
    project_id: 1,
    parent_phase_id: null,
    parent_subphase_id: null,
    name,
    start_date: '2026-01-01',
    end_date: '2026-01-31',
    color: '#000',
    order_index: 0,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies: [],
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
    ...over,
  };
}

function phase(id: number, name: string, over: Partial<Phase> = {}): Phase {
  return {
    id,
    project_id: 1,
    name,
    start_date: '2026-01-01',
    end_date: '2026-01-31',
    color: '#000',
    order_index: 0,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies: [],
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
    ...over,
  };
}

function assignment(id: number, staffId: number, name: string): StaffAssignment {
  return {
    id,
    staff_id: staffId,
    staff_name: name,
    allocation: 100,
    start_date: '2026-01-01',
    end_date: '2026-01-31',
  };
}

function project(phases: Phase[]): Project {
  return {
    id: 1,
    name: 'Bioprocess Scale-Up',
    site_id: 1,
    confirmed: true,
    archived: false,
    phases,
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Project;
}

describe('collectProjectCards', () => {
  it('treats a phase with no children as a card in its own lane', () => {
    const cards = collectProjectCards(project([phase(1, 'Pilot run')]));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      entityType: 'phase',
      entityId: 1,
      name: 'Pilot run',
      swimlanePhaseId: null,
      depth: 0,
      path: 'Pilot run',
    });
  });

  it('treats a phase with children as a lane, not a card', () => {
    const cards = collectProjectCards(
      project([phase(1, 'Design', { children: [sub(10, 'DoE setup'), sub(11, 'Reactor spec')] })])
    );
    expect(cards.map((c) => c.name)).toEqual(['DoE setup', 'Reactor spec']);
    expect(cards.every((c) => c.entityType === 'subphase')).toBe(true);
    expect(cards.every((c) => c.swimlanePhaseId === 1)).toBe(true);
    expect(cards.every((c) => c.swimlanePhaseName === 'Design')).toBe(true);
  });

  it('descends through a subphase with children without emitting it as a card', () => {
    const cards = collectProjectCards(
      project([
        phase(1, 'Design', {
          children: [sub(10, 'DoE', { children: [sub(20, 'Screening'), sub(21, 'Optimisation')] })],
        }),
      ])
    );
    expect(cards.map((c) => c.name)).toEqual(['Screening', 'Optimisation']);
    // The intermediate subphase contributes to the breadcrumb only.
    expect(cards[0].path).toBe('Design / DoE / Screening');
    expect(cards[0].swimlanePhaseId).toBe(1);
    expect(cards[0].depth).toBe(2);
  });

  it('emits milestones as cards', () => {
    const cards = collectProjectCards(
      project([phase(1, 'Gate review', { is_milestone: true })])
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].isMilestone).toBe(true);
  });

  it('carries status, completion and assignees onto the card', () => {
    const cards = collectProjectCards(
      project([
        phase(1, 'Design', {
          children: [
            sub(10, 'DoE setup', {
              status: 'in_progress',
              completion: 40,
              staffAssignments: [assignment(1, 7, 'Alice B.'), assignment(2, 8, 'Bob C.')],
            }),
          ],
        }),
      ])
    );
    expect(cards[0]).toMatchObject({ status: 'in_progress', completion: 40 });
    expect(cards[0].assigneeIds).toEqual([7, 8]);
  });

  it('defaults a missing status to todo', () => {
    const legacy = sub(10, 'Legacy');
    delete (legacy as Partial<Subphase>).status;
    const cards = collectProjectCards(project([phase(1, 'Design', { children: [legacy] })]));
    expect(cards[0].status).toBe('todo');
  });

  it('produces stable, unique keys across entity types', () => {
    const cards = collectProjectCards(
      project([phase(1, 'Leaf phase'), phase(2, 'Parent', { children: [sub(1, 'Sub')] })])
    );
    expect(cards.map((c) => c.key)).toEqual([cardKey('phase', 1), cardKey('subphase', 1)]);
    expect(new Set(cards.map((c) => c.key)).size).toBe(2);
  });

  it('returns no cards for a project with no phases', () => {
    expect(collectProjectCards(project([]))).toEqual([]);
  });
});

describe('groupCards', () => {
  const p = project([
    phase(1, 'Design', {
      order_index: 0,
      children: [
        sub(10, 'DoE setup', { staffAssignments: [assignment(1, 7, 'Alice B.')] }),
        sub(11, 'Reactor spec'),
      ],
    }),
    phase(2, 'Pilot run', { order_index: 1 }),
  ]);
  const cards = collectProjectCards(p);

  it('groups everything into one lane when grouping is none', () => {
    const lanes = groupCards(cards, 'none');
    expect(lanes).toHaveLength(1);
    expect(lanes[0].cards).toHaveLength(3);
  });

  it('groups by parent phase, keeping project phase order', () => {
    const lanes = groupCards(cards, 'phase', { project: p });
    expect(lanes.map((l) => l.label)).toEqual(['Design', 'Pilot run']);
    expect(lanes[0].cards.map((c) => c.name)).toEqual(['DoE setup', 'Reactor spec']);
    // The leaf phase is a card inside its own lane.
    expect(lanes[1].cards.map((c) => c.name)).toEqual(['Pilot run']);
  });

  it('groups by assignee with Unassigned pinned last', () => {
    const lanes = groupCards(cards, 'assignee');
    expect(lanes.map((l) => l.label)).toEqual(['Alice B.', 'Unassigned']);
    expect(lanes[1].cards).toHaveLength(2);
  });

  it('places a multi-assignee card in every assignee lane', () => {
    const multi = collectProjectCards(
      project([
        phase(1, 'Design', {
          children: [
            sub(10, 'Shared', {
              staffAssignments: [assignment(1, 7, 'Alice B.'), assignment(2, 8, 'Bob C.')],
            }),
          ],
        }),
      ])
    );
    const lanes = groupCards(multi, 'assignee');
    expect(lanes.map((l) => l.label)).toEqual(['Alice B.', 'Bob C.']);
    expect(lanes[0].cards[0].key).toBe(lanes[1].cards[0].key);
  });

  it('groups by custom column in declared option order, (none) last', () => {
    const values = new Map([[cardKey('subphase', 10), 'High']]);
    const lanes = groupCards(cards, 'customColumn', {
      customOptions: ['Low', 'High'],
      customValues: values,
    });
    expect(lanes.map((l) => l.label)).toEqual(['Low', 'High', '(none)']);
    expect(lanes[1].cards.map((c) => c.name)).toEqual(['DoE setup']);
    expect(lanes[2].cards).toHaveLength(2);
  });
});

describe('cardsForColumn', () => {
  it('filters by status and sorts by order then date then name', () => {
    const cards = collectProjectCards(
      project([
        phase(1, 'Design', {
          children: [
            sub(10, 'B', { status: 'todo', order_index: 1 }),
            sub(11, 'A', { status: 'todo', order_index: 0 }),
            sub(12, 'C', { status: 'done', order_index: 2 }),
          ],
        }),
      ])
    );
    expect(cardsForColumn(cards, 'todo').map((c) => c.name)).toEqual(['A', 'B']);
    expect(cardsForColumn(cards, 'done').map((c) => c.name)).toEqual(['C']);
    expect(cardsForColumn(cards, 'blocked')).toEqual([]);
  });
});
