import { describe, it, expect } from 'vitest';
import {
  buildEquipmentOverlapMap,
  buildEquipmentTodayStatusMap,
  findOverlapSegments,
} from '../equipmentOverlap';
import type { EquipmentAssignment, EquipmentBlock } from '@/types';
import { makePhase, makeProject, makeSubphase } from '@/test/factories';

function booking(overrides: Partial<EquipmentAssignment> = {}): EquipmentAssignment {
  return { id: 1, equipment_id: 7, start_date: '2026-03-01', end_date: '2026-03-10', ...overrides };
}

function block(overrides: Partial<EquipmentBlock> = {}): EquipmentBlock {
  return {
    id: 1,
    equipment_id: 7,
    start_date: '2026-03-05',
    end_date: '2026-03-06',
    reason: 'maintenance',
    description: '',
    ...overrides,
  };
}

describe('findOverlapSegments', () => {
  it('returns nothing for a single or disjoint ranges', () => {
    expect(findOverlapSegments([])).toEqual([]);
    expect(findOverlapSegments([{ start: '2026-01-01', end: '2026-01-31' }])).toEqual([]);
    expect(
      findOverlapSegments([
        { start: '2026-01-01', end: '2026-01-10' },
        { start: '2026-01-11', end: '2026-01-20' },
      ])
    ).toEqual([]);
  });

  it('returns the intersection of two overlapping ranges, ignoring the time part', () => {
    expect(
      findOverlapSegments([
        { start: '2026-01-01T00:00:00.000Z', end: '2026-01-10T00:00:00.000Z' },
        { start: '2026-01-08', end: '2026-01-20' },
      ])
    ).toEqual([{ start: '2026-01-08', end: '2026-01-10' }]);
  });

  it('counts a single shared day as an overlap', () => {
    expect(
      findOverlapSegments([
        { start: '2026-01-01', end: '2026-01-10' },
        { start: '2026-01-10', end: '2026-01-15' },
      ])
    ).toEqual([{ start: '2026-01-10', end: '2026-01-10' }]);
  });

  it('merges touching segments across a month boundary', () => {
    // A∩B = Jan 25–31, B∩C = Feb 1–5: touching, so one segment.
    expect(
      findOverlapSegments([
        { start: '2026-01-20', end: '2026-01-31' },
        { start: '2026-01-25', end: '2026-02-05' },
        { start: '2026-02-01', end: '2026-02-10' },
      ])
    ).toEqual([{ start: '2026-01-25', end: '2026-02-05' }]);
  });

  it('keeps separated segments apart and sorts them', () => {
    expect(
      findOverlapSegments([
        { start: '2026-05-01', end: '2026-05-05' },
        { start: '2026-05-04', end: '2026-05-06' },
        { start: '2026-01-01', end: '2026-01-03' },
        { start: '2026-01-02', end: '2026-01-09' },
      ])
    ).toEqual([
      { start: '2026-01-02', end: '2026-01-03' },
      { start: '2026-05-04', end: '2026-05-05' },
    ]);
  });

  it('does not shrink a merged segment when a later one ends earlier', () => {
    expect(
      findOverlapSegments([
        { start: '2026-01-01', end: '2026-01-31' },
        { start: '2026-01-01', end: '2026-01-31' },
        { start: '2026-01-10', end: '2026-01-12' },
      ])
    ).toEqual([{ start: '2026-01-01', end: '2026-01-31' }]);
  });
});

describe('buildEquipmentOverlapMap', () => {
  it('detects a conflict between a project booking and a block', () => {
    const project = makeProject({ equipmentAssignments: [booking()] });
    const map = buildEquipmentOverlapMap([project], [block()]);
    expect(map.get(7)).toEqual({
      hasOverlap: true,
      segments: [{ start: '2026-03-05', end: '2026-03-06' }],
    });
  });

  it('reports equipment with a single reservation as conflict-free', () => {
    const project = makeProject({ equipmentAssignments: [booking({ equipment_id: 3 })] });
    const map = buildEquipmentOverlapMap([project], []);
    expect(map.get(3)).toEqual({ hasOverlap: false, segments: [] });
    expect(map.has(7)).toBe(false);
  });

  it('falls back to the phase and subphase dates for undated bookings, at any depth', () => {
    const grandchild = makeSubphase({
      id: 3,
      start_date: '2026-04-01',
      end_date: '2026-04-30',
      equipmentAssignments: [booking({ id: 3, start_date: '', end_date: '' })],
    });
    const child = makeSubphase({ id: 2, children: [grandchild] });
    const phase = makePhase({
      start_date: '2026-04-20',
      end_date: '2026-05-10',
      equipmentAssignments: [booking({ id: 2, start_date: '', end_date: '' })],
      children: [child],
    });
    const map = buildEquipmentOverlapMap([makeProject({ phases: [phase] })], []);
    expect(map.get(7)?.segments).toEqual([{ start: '2026-04-20', end: '2026-04-30' }]);
  });

  it('ignores archived projects', () => {
    const archived = makeProject({ archived: true, equipmentAssignments: [booking()] });
    const map = buildEquipmentOverlapMap([archived], [block()]);
    expect(map.get(7)).toEqual({ hasOverlap: false, segments: [] });
  });
});

describe('buildEquipmentTodayStatusMap', () => {
  const today = new Date(2026, 2, 5, 12, 0, 0); // 2026-03-05 local

  it('marks equipment booked today as booked and omits idle equipment', () => {
    const project = makeProject({
      equipmentAssignments: [
        booking(),
        booking({ id: 2, equipment_id: 8, start_date: '2026-06-01', end_date: '2026-06-02' }),
      ],
    });
    const status = buildEquipmentTodayStatusMap([project], [], today);
    expect(status.get(7)).toBe('booked');
    expect(status.has(8)).toBe(false);
  });

  it('lets a block win over a booking', () => {
    const project = makeProject({ equipmentAssignments: [booking()] });
    const status = buildEquipmentTodayStatusMap([project], [block()], today);
    expect(status.get(7)).toBe('blocked');
  });

  it('walks phase and nested subphase bookings with date fallbacks', () => {
    const sub = makeSubphase({
      start_date: '2026-03-01',
      end_date: '2026-03-31',
      equipmentAssignments: [booking({ equipment_id: 9, start_date: '', end_date: '' })],
      children: [
        makeSubphase({
          id: 5,
          equipmentAssignments: [
            booking({ equipment_id: 10, start_date: '2026-03-05', end_date: '2026-03-05' }),
          ],
        }),
      ],
    });
    const phase = makePhase({
      start_date: '2026-03-01',
      end_date: '2026-03-31',
      equipmentAssignments: [booking({ equipment_id: 11, start_date: '', end_date: '' })],
      children: [sub],
    });
    const status = buildEquipmentTodayStatusMap([makeProject({ phases: [phase] })], [], today);
    expect(Object.fromEntries(status)).toEqual({ 9: 'booked', 10: 'booked', 11: 'booked' });
  });

  it('skips archived projects', () => {
    const project = makeProject({ archived: true, equipmentAssignments: [booking()] });
    expect(buildEquipmentTodayStatusMap([project], [], today).size).toBe(0);
  });

  it('defaults the reference date to now', () => {
    const now = new Date();
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`;
    const status = buildEquipmentTodayStatusMap([], [block({ start_date: iso, end_date: iso })]);
    expect(status.get(7)).toBe('blocked');
  });
});
