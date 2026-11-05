/**
 * The preview's sample project: every built-in and custom field has a value
 * (real option ids), the first two tags, a 90-day span from today, one phase
 * at 42 % and two staff bookings.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SAMPLE_DAYS, SAMPLE_NUMBER, SAMPLE_TEXT, sampleFieldValue, sampleProject } from '../projectFieldsPreview';
import { makeProjectField, makeProjectFieldOption, makeTag } from '@/test/factories';

const a = makeProjectFieldOption({ id: 11, name: 'A' });
const b = makeProjectFieldOption({ id: 12, name: 'B' });
const c = makeProjectFieldOption({ id: 13, name: 'C' });

afterEach(() => {
  vi.useRealTimers();
});

describe('sampleFieldValue', () => {
  it('gives each type a value its control shows', () => {
    expect(sampleFieldValue(makeProjectField({ field_type: 'select', options: [a, b] }))).toBe(11);
    expect(sampleFieldValue(makeProjectField({ field_type: 'select', options: [] }))).toBeNull();
    expect(sampleFieldValue(makeProjectField({ field_type: 'multiselect', options: [a, b, c] }))).toEqual([11, 12]);
    expect(sampleFieldValue(makeProjectField({ field_type: 'number' }))).toBe(SAMPLE_NUMBER);
    expect(sampleFieldValue(makeProjectField({ field_type: 'toggle' }))).toBe(true);
    expect(sampleFieldValue(makeProjectField({ field_type: 'text' }))).toBe(SAMPLE_TEXT);
  });
});

describe('sampleProject', () => {
  it('fills every field, takes the first two tags and spans 90 days from the given day', () => {
    const fields = [
      makeProjectField({ id: 1, field_type: 'select', options: [a] }),
      makeProjectField({ id: 2, field_type: 'text' }),
    ];
    const tags = [makeTag({ id: 5, name: 'Pilot' }), makeTag({ id: 6, name: 'Urgent' }), makeTag({ id: 7 })];
    const project = sampleProject(fields, tags, '2026-03-01');

    expect(project).toMatchObject({
      name: 'Sample project',
      customer: 'Example Ltd',
      pm_name: 'A. Manager',
      sales_pm: 'S. Contact',
      volume: 12.5,
      confirmed: true,
      start_date: '2026-03-01',
      end_date: '2026-05-29',
      field_values: { 1: 11, 2: 'Sample text' },
    });
    expect(SAMPLE_DAYS).toBe(90);
    expect(project.tags?.map((t) => t.id)).toEqual([5, 6]);
    expect(project.phases.map((p) => p.completion)).toEqual([42]);
    expect(project.staffAssignments.map((s) => [s.staff_name, s.allocation])).toEqual([
      ['A. Researcher', 60],
      ['B. Analyst', 40],
    ]);
  });

  it('starts today by default', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 31, 12));
    expect(sampleProject([], []).start_date).toBe('2026-10-31');
  });
});
