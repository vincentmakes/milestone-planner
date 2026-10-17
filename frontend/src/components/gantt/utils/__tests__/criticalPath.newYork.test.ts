/**
 * Critical path dates are calendar days, also west of UTC and across a DST
 * switch (US clocks spring forward on 2026-03-08, fall back on 2026-11-01).
 *
 * Dates are parsed as LOCAL midnights (parseLocalDate), so a span that
 * crosses a DST switch is 23h/25h off whole days; the day numbers must be
 * rounded, never floored/ceiled. TZ is pinned before anything date-related is
 * imported (see utils/__tests__/date.newYork.test.ts).
 */
declare const process: { env: Record<string, string | undefined> };
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { describe, it, expect, afterAll } from 'vitest';
import { calculateCriticalPath } from '../criticalPath';
import type { Dependency, Phase, Project } from '@/types';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function phase(id: number, start: string, end: string, dependencies: Dependency[] = []): Phase {
  return {
    id,
    project_id: 1,
    name: `Phase ${id}`,
    start_date: start,
    end_date: end,
    order_index: id,
    completion: null,
    status: 'todo',
    is_milestone: false,
    dependencies,
    children: [],
    staffAssignments: [],
    equipmentAssignments: [],
  } as unknown as Phase;
}

const project = (phases: Phase[]): Project => ({ id: 1, name: 'P', site_id: 1, phases }) as unknown as Project;
const fs = (id: number, lag = 0): Dependency => ({ id, type: 'FS', lag });

describe('calculateCriticalPath in America/New_York', () => {
  it('is really running west of UTC', () => {
    expect(new Date(2026, 2, 2).getTimezoneOffset()).toBeGreaterThan(0);
  });

  it('keeps the item that ends on the project end critical across spring-forward', () => {
    // A(Mar 2-6) -> B(Mar 10-13), B starts on its own date (3 days of lag
    // slack before it). B ends the project, so it has zero float; A has slack.
    // Flooring the day number lost the DST hour and gave B one day of float.
    const result = calculateCriticalPath(
      project([phase(1, '2026-03-02', '2026-03-06'), phase(2, '2026-03-10', '2026-03-13', [fs(1)])])
    );

    expect(result.hasDependencies).toBe(true);
    expect(result.criticalItems).toEqual(new Set(['phase-2']));
  });

  it('keeps a back-to-back chain critical across fall-back', () => {
    // A(Oct 26-30) -> B(Oct 31-Nov 6): no slack anywhere on the chain.
    const result = calculateCriticalPath(
      project([phase(1, '2026-10-26', '2026-10-30'), phase(2, '2026-10-31', '2026-11-06', [fs(1)])])
    );

    expect(result.criticalItems).toEqual(new Set(['phase-1', 'phase-2']));
  });

  it('treats the backend midnight form like the date-only form', () => {
    const dateOnly = calculateCriticalPath(
      project([
        phase(1, '2026-03-02', '2026-03-06'),
        phase(3, '2026-03-02', '2026-03-03'),
        phase(2, '2026-03-07', '2026-03-13', [fs(1), fs(3)]),
      ])
    );
    const midnightZ = calculateCriticalPath(
      project([
        phase(1, '2026-03-02T00:00:00.000Z', '2026-03-06T00:00:00.000Z'),
        phase(3, '2026-03-02', '2026-03-03T00:00:00.000Z'),
        phase(2, '2026-03-07T00:00:00.000Z', '2026-03-13', [fs(1), fs(3)]),
      ])
    );

    expect(dateOnly.criticalItems).toEqual(new Set(['phase-1', 'phase-2']));
    expect(midnightZ.criticalItems).toEqual(dateOnly.criticalItems);
  });
});
