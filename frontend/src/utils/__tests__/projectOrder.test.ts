/**
 * The Gantt and the Kanban board must show projects in the same order, so both
 * call orderSiteProjects. These pin the rule it encodes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { orderSiteProjects, setProjectOrder, STORAGE_KEYS } from '../storage';

interface TestProject {
  id: number;
  name: string;
  site_id: number;
  archived: boolean;
  confirmed: boolean;
}

const p = (id: number, name: string, over: Partial<TestProject> = {}): TestProject => ({
  id,
  name,
  site_id: 1,
  archived: false,
  confirmed: false,
  ...over,
});

describe('orderSiteProjects', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns nothing when no site is selected', () => {
    expect(orderSiteProjects([p(1, 'A')], undefined)).toEqual([]);
  });

  it('filters to the site', () => {
    const result = orderSiteProjects([p(1, 'A'), p(2, 'B', { site_id: 2 })], 1);
    expect(result.map((x) => x.id)).toEqual([1]);
  });

  it('drops archived projects', () => {
    const result = orderSiteProjects([p(1, 'A'), p(2, 'B', { archived: true })], 1);
    expect(result.map((x) => x.id)).toEqual([1]);
  });

  it('falls back to confirmed-first, then name', () => {
    const result = orderSiteProjects(
      [p(1, 'Zebra', { confirmed: true }), p(2, 'Alpha'), p(3, 'Beta')],
      1
    );
    expect(result.map((x) => x.name)).toEqual(['Zebra', 'Alpha', 'Beta']);
  });

  it('respects a stored custom order', () => {
    setProjectOrder(1, [3, 1, 2]);
    const result = orderSiteProjects([p(1, 'A'), p(2, 'B'), p(3, 'C')], 1);
    expect(result.map((x) => x.id)).toEqual([3, 1, 2]);
  });

  it('appends projects missing from the stored order', () => {
    setProjectOrder(1, [2]);
    const result = orderSiteProjects([p(1, 'A'), p(2, 'B'), p(3, 'C')], 1);
    expect(result[0].id).toBe(2);
    expect(result.slice(1).map((x) => x.id).sort()).toEqual([1, 3]);
  });

  it('reads the order for the requested site only', () => {
    setProjectOrder(2, [3, 1]);
    const result = orderSiteProjects([p(1, 'B'), p(3, 'A')], 1);
    // Site 1 has no custom order, so the name fallback applies.
    expect(result.map((x) => x.name)).toEqual(['A', 'B']);
  });

  it('stores order under a per-site key', () => {
    setProjectOrder(1, [2, 1]);
    expect(localStorage.getItem(`${STORAGE_KEYS.PROJECT_ORDER_PREFIX}1`)).toBeTruthy();
  });
});
