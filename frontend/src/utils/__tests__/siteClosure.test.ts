/**
 * A company event flagged `counts_as_unavailable` closes its sites: staff on
 * one of them are off for the event's dates. The index expands the flagged
 * events per day; the lookup matches a person through any of their sites.
 */

import { describe, it, expect } from 'vitest';
import { buildClosureIndex, getClosureOn, closureSiteIds, EMPTY_CLOSURE_INDEX } from '../siteClosure';
import type { CompanyEvent } from '@/types';

const closure: CompanyEvent = {
  id: 1,
  site_id: 1,
  site_ids: [1, 2],
  date: '2026-03-02',
  end_date: '2026-03-04',
  name: 'Site shutdown',
  color: '#f97316',
  counts_as_unavailable: true,
};
const plainEvent: CompanyEvent = {
  id: 2,
  site_id: 1,
  site_ids: [1],
  date: '2026-03-03',
  name: 'ISO Audit',
  counts_as_unavailable: false,
};

describe('buildClosureIndex', () => {
  it('expands flagged events over their range and ignores plain events', () => {
    const index = buildClosureIndex([closure, plainEvent]);
    expect(Array.from(index.keys()).sort()).toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
    expect(index.get('2026-03-03')).toEqual([closure]);
  });

  it('handles single-day events and ISO timestamps', () => {
    const index = buildClosureIndex([
      { ...closure, id: 3, date: '2026-05-01T00:00:00.000Z', end_date: null },
    ]);
    expect(Array.from(index.keys())).toEqual(['2026-05-01']);
  });

  it('is empty without flagged events', () => {
    expect(buildClosureIndex([plainEvent]).size).toBe(0);
  });
});

describe('getClosureOn', () => {
  const index = buildClosureIndex([closure]);

  it('returns the event when one of the person’s sites is closed', () => {
    expect(getClosureOn(new Set([2, 9]), '2026-03-03', index)).toBe(closure);
  });

  it('returns null for a person on other sites', () => {
    expect(getClosureOn(new Set([3]), '2026-03-03', index)).toBeNull();
  });

  it('returns null outside the dates, with no sites, or with an empty index', () => {
    expect(getClosureOn(new Set([1]), '2026-03-05', index)).toBeNull();
    expect(getClosureOn(new Set(), '2026-03-03', index)).toBeNull();
    expect(getClosureOn(new Set([1]), '2026-03-03', EMPTY_CLOSURE_INDEX)).toBeNull();
  });

  it('accepts a timestamp for the day', () => {
    expect(getClosureOn(new Set([1]), '2026-03-02T08:00:00', index)).toBe(closure);
  });
});

describe('closureSiteIds', () => {
  it('falls back to site_id when a server sends no site_ids', () => {
    expect(closureSiteIds({ ...closure, site_ids: undefined })).toEqual([1]);
    expect(closureSiteIds({ ...closure, site_ids: [] })).toEqual([1]);
    expect(closureSiteIds(closure)).toEqual([1, 2]);
  });
});
