import { describe, expect, it } from 'vitest';
import {
  categoryTone,
  describeDetails,
  fieldLabel,
  formatAuditValue,
  formatWhen,
  hasNoDetails,
  isLongValue,
  isMasked,
  outcomeTone,
  targetText,
} from '../auditDetails';
import { formatDateTime } from '@/utils/date';

describe('formatAuditValue', () => {
  it('reads empty, booleans, numbers, lists and text', () => {
    expect(formatAuditValue(null)).toBe('—');
    expect(formatAuditValue(undefined)).toBe('—');
    expect(formatAuditValue('')).toBe('—');
    expect(formatAuditValue(true)).toBe('Yes');
    expect(formatAuditValue(false)).toBe('No');
    expect(formatAuditValue(42)).toBe('42');
    expect(formatAuditValue('superuser')).toBe('superuser');
    expect(formatAuditValue([1, 2, 3])).toBe('1, 2, 3');
    expect(formatAuditValue([])).toBe('—');
    expect(formatAuditValue({ a: 1 })).toBe('{"a":1}');
  });

  it('reads a long value, a masked one and a timestamp', () => {
    expect(formatAuditValue({ changed: true, length: 250 })).toBe('changed (250 characters)');
    expect(formatAuditValue('***')).toBe('Secret value');
    const iso = '2026-11-03T08:00:00.000Z';
    expect(formatAuditValue(iso)).toBe(formatDateTime(iso));
  });

  it('reads a timestamp without a zone as UTC, and leaves text that only starts like one', () => {
    expect(formatAuditValue('2026-11-03T08:00:00')).toBe(formatDateTime('2026-11-03T08:00:00Z'));
    expect(formatAuditValue('2026-11-03T08:00:00.123456')).toBe(formatDateTime('2026-11-03T08:00:00.123456Z'));
    expect(formatAuditValue('2026-11-03T08:00+02:00')).toBe(formatDateTime('2026-11-03T08:00+02:00'));
    expect(formatAuditValue('2026-11-03T08:00 kick-off')).toBe('2026-11-03T08:00 kick-off');
  });

  it('tells a masked and a long value apart', () => {
    expect(isMasked('***')).toBe(true);
    expect(isMasked('**')).toBe(false);
    expect(isLongValue({ changed: true, length: 3 })).toBe(true);
    expect(isLongValue({ changed: false, length: 3 })).toBe(false);
    expect(isLongValue({ changed: true })).toBe(false);
    expect(isLongValue(null)).toBe(false);
  });
});

describe('formatWhen', () => {
  it('reads a timestamp in local time and keeps a malformed one', () => {
    const iso = '2026-11-03T08:00:00.000Z';
    expect(formatWhen(iso)).toBe(formatDateTime(iso));
    expect(formatWhen('not a date')).toBe('not a date');
  });
});

describe('fieldLabel', () => {
  it('maps known fields, humanises the rest and keeps a dotted key', () => {
    expect(fieldLabel('site_ids')).toBe('Sites');
    expect(fieldLabel('retry_after')).toBe('Retry after (seconds)');
    expect(fieldLabel('first_name')).toBe('First name');
    expect(fieldLabel('projects.view')).toBe('projects.view');
  });
});

describe('targetText', () => {
  it('reads "{Type} · {label}", falling back to the id, then the type alone', () => {
    expect(targetText({ target_type: 'user', target_id: '9', target_label: 'Bob' })).toBe('User · Bob');
    expect(targetText({ target_type: 'staff_assignment', target_id: '12', target_label: null })).toBe(
      'Booking · #12'
    );
    expect(targetText({ target_type: 'bank_holiday', target_id: null, target_label: null })).toBe('Bank holiday');
    expect(targetText({ target_type: null, target_id: null, target_label: null })).toBe('—');
  });
});

describe('describeDetails', () => {
  it('splits the contract keys', () => {
    const described = describeDetails({
      reason: 'bad_password',
      changes: { role: { old: 'user', new: 'admin' }, odd: 'flat' },
      items: [{ name: 'A' }, 'not an object'],
      context: { rows: 3 },
    });
    expect(described.reason).toBe('bad_password');
    expect(described.changes).toEqual([['role', { old: 'user', new: 'admin' }]]);
    expect(described.items).toEqual([{ name: 'A' }]);
    expect(described.context).toEqual([
      ['odd', 'flat'],
      ['rows', 3],
    ]);
    expect(hasNoDetails(described)).toBe(false);
  });

  it('finds nothing in null or a bare reason', () => {
    expect(hasNoDetails(describeDetails(null))).toBe(true);
    const reasonOnly = describeDetails({ reason: 'throttled' });
    expect(reasonOnly.reason).toBe('throttled');
    expect(hasNoDetails(reasonOnly)).toBe(true);
    expect(describeDetails({ reason: '' }).reason).toBeNull();
  });
});

describe('tones', () => {
  it('colours the categories and outcomes', () => {
    expect(['auth', 'admin', 'access', 'change', 'x'].map(categoryTone)).toEqual([
      'info',
      'warning',
      'accent',
      'neutral',
      'neutral',
    ]);
    expect(['success', 'failure', 'x'].map(outcomeTone)).toEqual(['success', 'error', 'neutral']);
  });
});
