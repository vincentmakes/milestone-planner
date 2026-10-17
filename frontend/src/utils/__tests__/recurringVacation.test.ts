/**
 * getAbsenceOn decides whether a person is unavailable on a given day. It
 * feeds the workload heatmap, the staff list availability, the resource panel
 * and the Gantt markers, so its rules are pinned here: [R:] patterns only
 * block their weekdays, available types (Home Office) never block, untyped
 * absences keep their historical "unavailable" meaning, and an unavailable
 * absence wins when two cover the same day.
 */

import { describe, it, expect } from 'vitest';
import {
  getAbsenceOn,
  isUnavailableOn,
  indexAbsenceTypes,
  absenceTypeName,
  absenceColor,
  absenceColorStyle,
  defaultAbsenceTypeId,
  guessAbsenceTypeId,
  cleanVacationDescription,
} from '../recurringVacation';
import type { AbsenceType, Vacation } from '@/types';

const TYPES: AbsenceType[] = [
  { id: 1, name: 'Holidays', color: '#8b5cf6', counts_as_unavailable: true, sort_order: 0, is_active: true },
  { id: 2, name: 'Home Office', color: '#0ea5e9', counts_as_unavailable: false, sort_order: 1, is_active: true },
  { id: 3, name: 'Illness', color: '#ef4444', counts_as_unavailable: true, sort_order: 2, is_active: true },
  { id: 4, name: 'Sabbatical', color: '#000000', counts_as_unavailable: true, sort_order: 3, is_active: false },
];
const byId = indexAbsenceTypes(TYPES);

const vac = (over: Partial<Vacation>): Vacation => ({
  id: 1,
  staff_id: 7,
  start_date: '2026-03-02',
  end_date: '2026-03-06',
  description: 'Time off',
  ...over,
});

describe('getAbsenceOn', () => {
  it('matches a plain absence on every day of its range only', () => {
    const v = vac({ absence_type_id: 1 });
    expect(getAbsenceOn(7, '2026-03-01', [v], byId)).toBeNull();
    expect(getAbsenceOn(7, '2026-03-02', [v], byId)?.vacation).toBe(v);
    expect(getAbsenceOn(7, '2026-03-06T00:00:00.000Z', [v], byId)?.unavailable).toBe(true);
    expect(getAbsenceOn(7, '2026-03-07', [v], byId)).toBeNull();
  });

  it('ignores other staff members', () => {
    const v = vac({ absence_type_id: 1 });
    expect(getAbsenceOn(8, '2026-03-03', [v], byId)).toBeNull();
    // null = vacations already belong to one person
    expect(getAbsenceOn(null, '2026-03-03', [v], byId)?.vacation).toBe(v);
  });

  it('honours [R:] recurring weekdays inside the range', () => {
    // 2026-03-02 is a Monday; [R:1,3] = Mondays and Wednesdays
    const v = vac({ start_date: '2026-03-01', end_date: '2026-03-31', description: '[R:1,3] Part-time', absence_type_id: 1 });
    expect(getAbsenceOn(7, '2026-03-02', [v], byId)).toMatchObject({ recurring: true, unavailable: true });
    expect(getAbsenceOn(7, '2026-03-03', [v], byId)).toBeNull(); // Tuesday
    expect(getAbsenceOn(7, '2026-03-04', [v], byId)?.vacation).toBe(v); // Wednesday
    expect(getAbsenceOn(7, '2026-04-01', [v], byId)).toBeNull(); // Wednesday, out of range
  });

  it('does not make Home Office unavailable', () => {
    const v = vac({ absence_type_id: 2 });
    const absence = getAbsenceOn(7, '2026-03-03', [v], byId);
    expect(absence).toMatchObject({ unavailable: false, type: { name: 'Home Office' } });
    expect(isUnavailableOn(7, '2026-03-03', [v], byId)).toBe(false);
  });

  it('treats untyped and unknown types as unavailable', () => {
    expect(getAbsenceOn(7, '2026-03-03', [vac({ absence_type_id: null })], byId)).toMatchObject({
      type: null,
      unavailable: true,
    });
    expect(getAbsenceOn(7, '2026-03-03', [vac({ absence_type_id: 99 })], byId)?.unavailable).toBe(true);
    // Without the type list at all, everything is unavailable (pre-types behaviour)
    expect(isUnavailableOn(7, '2026-03-03', [vac({ absence_type_id: 2 })], undefined)).toBe(true);
  });

  it('lets an unavailable absence win over an available one on the same day', () => {
    const home = vac({ id: 1, absence_type_id: 2, start_date: '2026-03-01', end_date: '2026-03-31' });
    const ill = vac({ id: 2, absence_type_id: 3, start_date: '2026-03-03', end_date: '2026-03-03' });
    expect(getAbsenceOn(7, '2026-03-03', [home, ill], byId)?.vacation).toBe(ill);
    expect(getAbsenceOn(7, '2026-03-04', [home, ill], byId)?.vacation).toBe(home);
  });
});

describe('absence type helpers', () => {
  it('labels and colours untyped absences with the defaults', () => {
    expect(absenceTypeName(null)).toBe('Vacation');
    expect(absenceColor(null)).toBeUndefined();
    expect(absenceColorStyle(null)).toEqual({});
    expect(absenceColorStyle(TYPES[1])).toEqual({ '--absence-color': '#0ea5e9' });
  });

  it('defaults to the first active unavailable type', () => {
    expect(defaultAbsenceTypeId(TYPES)).toBe(1);
    expect(defaultAbsenceTypeId([TYPES[1]])).toBe(2);
    expect(defaultAbsenceTypeId([TYPES[3]])).toBeNull(); // inactive only
    expect(defaultAbsenceTypeId([])).toBeNull();
  });

  it('guesses the type of an imported entry', () => {
    expect(guessAbsenceTypeId({ busyStatus: 'WORKINGELSEWHERE', summary: 'Remote' }, TYPES)).toBe(2);
    expect(guessAbsenceTypeId({ categories: ['illness'], summary: 'Out' }, TYPES)).toBe(3);
    expect(guessAbsenceTypeId({ summary: 'Home office Friday' }, TYPES)).toBe(2);
    expect(guessAbsenceTypeId({ summary: 'Sabbatical' }, TYPES)).toBeNull(); // inactive type
    expect(guessAbsenceTypeId({ busyStatus: 'OOF', summary: 'Trip' }, TYPES)).toBeNull();
  });

  it('strips the recurring prefix from descriptions', () => {
    expect(cleanVacationDescription('[R:1,3] Part-time')).toBe('Part-time');
    expect(cleanVacationDescription('Annual leave')).toBe('Annual leave');
    expect(cleanVacationDescription(undefined)).toBe('');
  });
});
