/**
 * Recurring-absence encoding (`[R:0,2,4]` prefix in the description) and its
 * helpers. Absence-type lookups are in recurringVacation.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  createRecurringPattern,
  expandRecurringVacations,
  getRecurringDates,
  getRecurringDaysDisplay,
  guessAbsenceTypeId,
  isDateOnRecurringVacation,
  isRecurringVacation,
  parseRecurringPattern,
} from '../recurringVacation';
import { makeVacation } from '@/test/factories';
import type { AbsenceType } from '@/types';

describe('recurring pattern encoding', () => {
  it('parses sorted weekdays and the clean description', () => {
    expect(parseRecurringPattern('[R:4,1] Part-time')).toEqual({
      daysOfWeek: [1, 4],
      cleanDescription: 'Part-time',
    });
    expect(parseRecurringPattern('[R:5]')).toEqual({ daysOfWeek: [5], cleanDescription: 'Recurring absence' });
    expect(parseRecurringPattern('Holidays')).toBeNull();
    expect(parseRecurringPattern(undefined)).toBeNull();
  });

  it('round-trips through createRecurringPattern', () => {
    const encoded = createRecurringPattern([3, 1], 'Course');
    expect(encoded).toBe('[R:1,3] Course');
    expect(parseRecurringPattern(encoded)?.daysOfWeek).toEqual([1, 3]);
    expect(createRecurringPattern([], 'Plain')).toBe('Plain');
    expect(createRecurringPattern([2], '')).toBe('[R:2]');
  });

  it('detects recurring vacations', () => {
    expect(isRecurringVacation(makeVacation({ description: '[R:1] Gym' }))).toBe(true);
    expect(isRecurringVacation(makeVacation({ description: 'Holidays' }))).toBe(false);
    expect(isRecurringVacation(makeVacation({ description: undefined as never }))).toBe(false);
  });

  it('describes the weekdays for display', () => {
    expect(getRecurringDaysDisplay([])).toBe('');
    expect(getRecurringDaysDisplay([1])).toBe('Every Monday');
    expect(getRecurringDaysDisplay([1, 3])).toBe('Every Monday & Wednesday');
    expect(getRecurringDaysDisplay([1, 3, 5])).toBe('Every Mon, Wed, Fri');
  });
});

describe('recurring dates', () => {
  // Mon 2026-03-02 .. Sun 2026-03-15, every Monday and Friday.
  const vacation = makeVacation({
    start_date: '2026-03-02T00:00:00.000Z',
    end_date: '2026-03-15',
    description: '[R:1,5] Part-time',
  });
  const pattern = parseRecurringPattern(vacation.description)!;

  it('matches only pattern weekdays inside the range', () => {
    expect(isDateOnRecurringVacation('2026-03-06', vacation, pattern)).toBe(true); // Fri
    expect(isDateOnRecurringVacation('2026-03-04', vacation, pattern)).toBe(false); // Wed
    expect(isDateOnRecurringVacation('2026-03-16', vacation, pattern)).toBe(false); // Mon, after
    expect(isDateOnRecurringVacation('2026-02-27', vacation, pattern)).toBe(false); // Fri, before
  });

  it('lists the matching dates within the visible window', () => {
    expect(getRecurringDates(vacation, pattern, '2026-01-01', '2026-12-31')).toEqual([
      '2026-03-02',
      '2026-03-06',
      '2026-03-09',
      '2026-03-13',
    ]);
    expect(getRecurringDates(vacation, pattern, '2026-03-07', '2026-03-10')).toEqual(['2026-03-09']);
  });

  it('flags recurring vacations and passes plain ones through', () => {
    const plain = makeVacation({ id: 2, description: 'Holidays' });
    const [recurring, passthrough] = expandRecurringVacations([vacation, plain], '2026-01-01', '2026-12-31');
    expect(recurring).toMatchObject({ isRecurring: true, recurringDays: [1, 5], description: 'Part-time' });
    expect(passthrough).toMatchObject({ id: 2, isRecurring: false, description: 'Holidays' });
  });
});

describe('guessAbsenceTypeId', () => {
  const type = (id: number, name: string, overrides: Partial<AbsenceType> = {}): AbsenceType => ({
    id,
    name,
    color: '#000',
    counts_as_unavailable: true,
    sort_order: id,
    is_active: true,
    ...overrides,
  });
  const types = [type(1, 'Vacation'), type(2, 'Home Office', { counts_as_unavailable: false }), type(3, 'Sick')];

  it('returns null without active types', () => {
    expect(guessAbsenceTypeId({ summary: 'Sick' }, [type(3, 'Sick', { is_active: false })])).toBeNull();
  });

  it('maps a working-elsewhere status to the home-office type', () => {
    expect(guessAbsenceTypeId({ busyStatus: 'workingElsewhere' }, types)).toBe(2);
    expect(guessAbsenceTypeId({ busyStatus: 'WORKINGELSEWHERE' }, [type(1, 'Vacation')])).toBeNull();
  });

  it('matches a category exactly, then the summary by substring', () => {
    expect(guessAbsenceTypeId({ categories: ['  ', ' sick '] }, types)).toBe(3);
    expect(guessAbsenceTypeId({ categories: ['Other'], summary: 'Summer vacation' }, types)).toBe(1);
    expect(guessAbsenceTypeId({ summary: 'Conference' }, types)).toBeNull();
    expect(guessAbsenceTypeId({}, types)).toBeNull();
  });
});
