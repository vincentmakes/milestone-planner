/**
 * calculateRowPositions walks the same flat row list both panes render:
 * section headers take SECTION_ROW_TOTAL_HEIGHT (36 + 1) under
 * `section-<key>`, projects of a collapsed section get no position.
 */
import { describe, it, expect } from 'vitest';
import { calculateRowPositions, SECTION_ROW_TOTAL_HEIGHT } from '../rowPositions';
import { buildGanttRows, flatGanttRows } from '../projectSections';
import type { GanttSection } from '../projectSections';
import { allocationRange, cardStaffItems, relinkWouldOverlap, staffGroupKey, staffRowCount } from '../staffGroups';
import type { Project, StaffAssignment } from '@/types';

function project(id: number, phaseIds: number[] = []): Project {
  return {
    id,
    name: `P${id}`,
    phases: phaseIds.map((pid) => ({ id: pid, children: [], staffAssignments: [], equipmentAssignments: [] })),
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Project;
}

const p1 = project(1, [10, 11]);
const p2 = project(2, [20]);
const p3 = project(3, [30]);
const expanded = new Set([1, 2, 3]);
const none = new Set<number>();

function section(key: GanttSection['key'], projects: Project[]): GanttSection {
  return { key, option: null, label: key, projects };
}

describe('calculateRowPositions', () => {
  it('is unchanged for a flat project list', () => {
    const { positions, totalHeight } = calculateRowPositions(flatGanttRows([p1, p2]), expanded, none, none);
    expect(positions.get('project-1')).toEqual({ top: 0, height: 45 });
    expect(positions.get('phase-10')).toEqual({ top: 45, height: 32 });
    expect(positions.get('phase-11')).toEqual({ top: 78, height: 32 });
    expect(positions.get('project-2')).toEqual({ top: 111, height: 45 });
    expect(positions.get('phase-20')).toEqual({ top: 156, height: 32 });
    expect(totalHeight).toBe(189);
  });

  it('offsets every row below a section header by 37 px', () => {
    expect(SECTION_ROW_TOTAL_HEIGHT).toBe(37);
    const rows = buildGanttRows([section('field-5', [p1]), section('none', [p2])], []);
    const { positions, totalHeight } = calculateRowPositions(rows, expanded, none, none);
    expect(positions.get('section-field-5')).toEqual({ top: 0, height: 37 });
    expect(positions.get('project-1')).toEqual({ top: 37, height: 45 });
    expect(positions.get('phase-11')).toEqual({ top: 37 + 45 + 33, height: 32 });
    expect(positions.get('section-none')).toEqual({ top: 148, height: 37 });
    expect(positions.get('project-2')).toEqual({ top: 185, height: 45 });
    expect(positions.get('phase-20')).toEqual({ top: 230, height: 32 });
    expect(totalHeight).toBe(189 + 2 * 37);
  });

  it('gives the projects of a collapsed section no position', () => {
    const rows = buildGanttRows([section('field-5', [p1, p3]), section('none', [p2])], ['field-5']);
    const { positions, totalHeight } = calculateRowPositions(rows, expanded, none, none);
    expect(positions.has('project-1')).toBe(false);
    expect(positions.has('phase-10')).toBe(false);
    expect(positions.has('project-3')).toBe(false);
    expect(positions.get('section-field-5')).toEqual({ top: 0, height: 37 });
    expect(positions.get('section-none')).toEqual({ top: 37, height: 37 });
    expect(positions.get('project-2')).toEqual({ top: 74, height: 45 });
    expect(totalHeight).toBe(74 + 45 + 33);
  });

  it('places the phantom row after its source, below the section offset', () => {
    const rows = buildGanttRows([section('field-5', [p1])], []);
    const { positions, phantomRowTop, totalHeight } = calculateRowPositions(rows, expanded, none, none, {
      projectId: 1,
      sourceId: 10,
      type: 'phase',
    });
    expect(phantomRowTop).toBe(37 + 45 + 33);
    expect(positions.get('phantom')).toEqual({ top: 115, height: 32 });
    expect(positions.get('phase-11')).toEqual({ top: 148, height: 32 });
    expect(totalHeight).toBe(37 + 45 + 3 * 33);
  });
});

// ---------------------------------------------------------------------------
// Per-person booking groups (1.17.0)
// ---------------------------------------------------------------------------

function booking(id: number, staffId: number, allocation = 50): StaffAssignment {
  return { id, staff_id: staffId, staff_name: `S${staffId}`, allocation, start_date: '', end_date: '' } as StaffAssignment;
}

// Bob (4) holds two segments, Cleo (5) one; rows interleaved as the API sends them
const bookings = [booking(1, 4, 20), booking(2, 5), booking(3, 4, 60)];
const card = (id: number) => ({ id, start_date: '2026-11-02', end_date: '2026-12-18' });
const segment = (id: number, staffId: number, start: string, end: string, extra: Partial<StaffAssignment> = {}) =>
  ({ ...booking(id, staffId), start_date: start, end_date: end, linked: false, ...extra }) as StaffAssignment;

describe('staff groups', () => {
  it('keys a group by level, card and person', () => {
    expect(staffGroupKey('phase', 10, 4)).toBe('phase:10:4');
    expect(staffGroupKey('subphase', 21, 5)).toBe('subphase:21:5');
  });

  it('groups a person with 2+ bookings and keeps singles, in order of first row', () => {
    const items = cardStaffItems(bookings, 'phase', card(10), new Set());
    expect(items).toEqual([
      { kind: 'group', key: 'phase:10:4', staffId: 4, rows: [bookings[0], bookings[2]], collapsed: false },
      { kind: 'single', assignment: bookings[1] },
    ]);
    expect(cardStaffItems(bookings, 'phase', card(10), new Set(['phase:10:4']))[0]).toMatchObject({ collapsed: true });
    // another card's key does not collapse this one
    expect(cardStaffItems(bookings, 'phase', card(11), new Set(['phase:10:4']))[0]).toMatchObject({ collapsed: false });
    expect(cardStaffItems(undefined, 'phase', card(10), new Set())).toEqual([]);
  });

  it("orders a person's rows by effective start, then id; the group keeps its place", () => {
    // Dana (6): a December segment first in API order, then a November one, then
    // a linked row (starts with the card, 2 Nov) and a second November-start
    // segment with a lower id than the linked row.
    const dec = segment(30, 6, '2026-12-01', '2026-12-10');
    const nov = segment(31, 6, '2026-11-16T00:00:00.000Z', '2026-11-20');
    const linked = { ...booking(33, 6), linked: true, start_date: '2026-11-02', end_date: '2026-12-18' } as StaffAssignment;
    const early = segment(32, 6, '2026-11-02', '2026-11-04');
    const cleo = booking(29, 5);
    const items = cardStaffItems([cleo, dec, nov, linked, early], 'phase', card(10), new Set());
    expect(items[0]).toEqual({ kind: 'single', assignment: cleo });
    expect(items[1]).toMatchObject({ kind: 'group', staffId: 6 });
    // 2 Nov (id 32), 2 Nov (id 33, linked: the card's start), 16 Nov, 1 Dec
    expect(items[1].kind === 'group' && items[1].rows.map((r) => r.id)).toEqual([32, 33, 31, 30]);
    // the card's own row list is left as it was
    expect([dec, nov].map((r) => r.id)).toEqual([30, 31]);
    // a group's place among the items is its first row in API order
    const later = cardStaffItems([dec, cleo, nov], 'phase', card(10), new Set());
    expect(later.map((i) => i.kind)).toEqual(['group', 'single']);
    expect(later[0].kind === 'group' && later[0].rows.map((r) => r.id)).toEqual([31, 30]);
    expect(staffRowCount([dec, cleo, nov], 'phase', card(10), new Set())).toBe(4);
  });

  it('counts a group as its overview row plus its bookings while expanded', () => {
    expect(staffRowCount(bookings, 'phase', card(10), new Set())).toBe(4); // group + 2 + Cleo
    expect(staffRowCount(bookings, 'phase', card(10), new Set(['phase:10:4']))).toBe(2); // group + Cleo
    // one booking per person: one row each, as before
    expect(staffRowCount([booking(1, 4), booking(2, 5)], 'subphase', card(3), new Set())).toBe(2);
    expect(staffRowCount([], 'phase', card(10), new Set())).toBe(0);
    expect(staffRowCount(undefined, 'phase', card(10), new Set())).toBe(0);
  });

  it('tells when relinking a segment would overlap another booking of the person', () => {
    const c = card(10);
    const own = segment(40, 4, '2026-11-02', '2026-11-06');
    // a lone segment, or a linked row (unlinking is never blocked): free
    expect(relinkWouldOverlap(own, [own], c)).toBe(false);
    expect(relinkWouldOverlap(own, undefined, c)).toBe(false);
    const linkedRow = { ...booking(41, 4), linked: true } as StaffAssignment;
    expect(relinkWouldOverlap(linkedRow, [linkedRow, own], c)).toBe(false);
    // a linked sibling always overlaps the card
    expect(relinkWouldOverlap(own, [own, linkedRow], c)).toBe(true);
    // an unlinked sibling inside the card overlaps it
    const other = segment(42, 4, '2026-12-01T00:00:00.000Z', '2026-12-05');
    expect(relinkWouldOverlap(own, [own, other], c)).toBe(true);
    // ...one outside the card (not fitted yet) does not; neither does a pending one,
    // nor another person's row
    const outside = segment(43, 4, '2027-01-04', '2027-01-08');
    expect(relinkWouldOverlap(own, [own, outside], c)).toBe(false);
    const pending = segment(44, 4, '2026-12-01', '2026-12-05', { approval_status: 'pending' });
    expect(relinkWouldOverlap(own, [own, pending], c)).toBe(false);
    expect(relinkWouldOverlap(own, [own, segment(45, 5, '2026-11-02', '2026-11-06')], c)).toBe(false);
  });

  it('shows one allocation or the range', () => {
    expect(allocationRange([booking(1, 4, 40), booking(2, 4, 40)])).toBe('40%');
    expect(allocationRange([booking(1, 4, 60), booking(2, 4, 20), booking(3, 4, 30)])).toBe('20–60%');
  });
});

describe('calculateRowPositions with booking groups', () => {
  function withBookings(): Project {
    return {
      id: 1,
      name: 'P1',
      phases: [
        {
          id: 10,
          children: [
            {
              id: 21,
              children: [],
              staffAssignments: [booking(7, 4), booking(8, 4), booking(9, 4)],
              equipmentAssignments: [],
            },
            { id: 22, children: [], staffAssignments: [], equipmentAssignments: [] },
          ],
          staffAssignments: bookings,
          equipmentAssignments: [],
        },
        { id: 11, children: [], staffAssignments: [booking(5, 6)], equipmentAssignments: [] },
        { id: 12, children: [], staffAssignments: [], equipmentAssignments: [] },
      ],
      staffAssignments: [],
      equipmentAssignments: [],
    } as unknown as Project;
  }
  const rows = () => flatGanttRows([withBookings()]);
  const phases = new Set([10, 11]);
  const subphases = new Set([21]);

  it('counts groups expanded by default, singles one row each', () => {
    const { positions, totalHeight } = calculateRowPositions(rows(), new Set([1]), phases, subphases);
    expect(positions.get('phase-10')).toEqual({ top: 45, height: 32 });
    expect(positions.get('subphase-21')).toEqual({ top: 78, height: 32 });
    // subphase 21: group + 3 bookings
    expect(positions.get('subphase-22')).toEqual({ top: 78 + 33 * 5, height: 32 });
    // phase 10's block: group + 2 + Cleo = 4 rows after subphase 22
    expect(positions.get('phase-11')).toEqual({ top: 78 + 33 * 6 + 33 * 4, height: 32 });
    // phase 11 holds one booking: one row, as before
    expect(positions.get('phase-12')).toEqual({ top: 78 + 33 * 12, height: 32 });
    expect(totalHeight).toBe(78 + 33 * 13);
  });

  it('shifts the following rows up when a group collapses', () => {
    const collapsed = new Set(['subphase:21:4', 'phase:10:4']);
    const { positions, totalHeight } = calculateRowPositions(
      rows(), new Set([1]), phases, subphases, null, true, undefined, undefined, collapsed
    );
    // subphase 21: the group row only
    expect(positions.get('subphase-22')).toEqual({ top: 78 + 33 * 2, height: 32 });
    // phase 10's block: group + Cleo
    expect(positions.get('phase-11')).toEqual({ top: 78 + 33 * 3 + 33 * 2, height: 32 });
    expect(totalHeight).toBe(78 + 33 * 8);
  });

  it('counts no booking row while assignments are hidden', () => {
    const { positions } = calculateRowPositions(rows(), new Set([1]), phases, subphases, null, false);
    expect(positions.get('subphase-22')).toEqual({ top: 111, height: 32 });
    expect(positions.get('phase-12')).toEqual({ top: 177, height: 32 });
  });
});
