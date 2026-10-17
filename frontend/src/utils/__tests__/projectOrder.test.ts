/**
 * The Gantt and the Kanban board must show projects in the same order, so both
 * call orderSiteProjects. These pin the rule it encodes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { moveProjectInOrder, orderSiteProjects, setProjectOrder, STORAGE_KEYS } from '../storage';

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

  it('orders projects missing from the stored order by the default rule, whatever order they arrive in', () => {
    setProjectOrder(1, [2]);
    const projects = [p(5, 'Delta'), p(4, 'Charlie', { confirmed: true }), p(2, 'B'), p(3, 'Alpha')];
    const expected = [2, 4, 3, 5];
    expect(orderSiteProjects(projects, 1).map((x) => x.id)).toEqual(expected);
    expect(orderSiteProjects([...projects].reverse(), 1).map((x) => x.id)).toEqual(expected);
  });

  it('breaks name ties by id so the fallback order is stable', () => {
    const result = orderSiteProjects([p(9, 'Same'), p(3, 'Same')], 1);
    expect(result.map((x) => x.id)).toEqual([3, 9]);
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

describe('moveProjectInOrder', () => {
  const ids = [1, 2, 3, 4];

  it('moves a project up, before the target', () => {
    expect(moveProjectInOrder(ids, 4, 2, 'before')).toEqual([1, 4, 2, 3]);
  });

  it('moves a project down, before the target, without overshooting', () => {
    expect(moveProjectInOrder(ids, 1, 3, 'before')).toEqual([2, 1, 3, 4]);
  });

  it('moves a project down, after the target', () => {
    expect(moveProjectInOrder(ids, 1, 3, 'after')).toEqual([2, 3, 1, 4]);
  });

  it('can drop below the last row', () => {
    expect(moveProjectInOrder(ids, 2, 4, 'after')).toEqual([1, 3, 4, 2]);
  });

  it('leaves the order unchanged when dropped next to itself', () => {
    expect(moveProjectInOrder(ids, 1, 2, 'before')).toEqual(ids);
    expect(moveProjectInOrder(ids, 2, 2, 'after')).toEqual(ids);
  });

  it('leaves the order unchanged for an unknown target', () => {
    expect(moveProjectInOrder(ids, 1, 99, 'before')).toEqual(ids);
  });
});
