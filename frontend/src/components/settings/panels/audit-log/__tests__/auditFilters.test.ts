import { describe, expect, it } from 'vitest';
import { auditLogQuery, EMPTY_AUDIT_FILTERS, hasActiveFilters } from '../auditFilters';

describe('auditLogQuery', () => {
  it('sends nothing for the empty filters, and the paging when given', () => {
    expect(auditLogQuery(EMPTY_AUDIT_FILTERS)).toEqual({});
    expect(auditLogQuery(EMPTY_AUDIT_FILTERS, { page: 2, pageSize: 25 })).toEqual({ page: 2, page_size: 25 });
  });

  it('sends every set filter, trimmed', () => {
    expect(
      auditLogQuery({
        q: '  ada ',
        category: 'auth',
        outcome: 'failure',
        action: 'auth.login.failed',
        actorUserId: 7,
        ip: ' 203.0.113.7 ',
        since: '2026-11-01',
        until: '2026-11-03',
      })
    ).toEqual({
      q: 'ada',
      category: 'auth',
      outcome: 'failure',
      action: 'auth.login.failed',
      actor_user_id: 7,
      ip: '203.0.113.7',
      since: '2026-11-01',
      until: '2026-11-03',
    });
  });

  it('drops blank text and keeps actor 0', () => {
    expect(auditLogQuery({ ...EMPTY_AUDIT_FILTERS, q: '   ', ip: ' ', actorUserId: 0 })).toEqual({ actor_user_id: 0 });
  });
});

describe('hasActiveFilters', () => {
  it('is true once one filter narrows the log', () => {
    expect(hasActiveFilters(EMPTY_AUDIT_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_AUDIT_FILTERS, q: '  ' })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_AUDIT_FILTERS, outcome: 'success' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_AUDIT_FILTERS, until: '2026-11-03' })).toBe(true);
  });
});
