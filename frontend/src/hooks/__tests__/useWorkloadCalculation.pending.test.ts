/**
 * A booking awaiting approval books no capacity: the Staff heatmap skips it.
 * A pending change of an approved booking still counts at its current value
 * (the row's allocation is the old one until someone decides).
 */
import { describe, it, expect } from 'vitest';
import { calculateWorkloadCells } from '../useWorkloadCalculation';
import type { TimelineCell } from '@/components/gantt/utils';

const cell = (dateStr: string) => ({ dateStr }) as TimelineCell;
const base = { start_date: '2026-03-01', end_date: '2026-03-31', projectName: 'P' };

describe('calculateWorkloadCells with pending bookings', () => {
  it('leaves a pending booking out of the total and the tooltip list', () => {
    const [w] = calculateWorkloadCells(
      [
        { ...base, id: 1, allocation: 40 },
        { ...base, id: 2, allocation: 60, approval_status: 'pending' as const },
      ],
      [],
      [cell('2026-03-03')]
    );
    expect(w).toMatchObject({ total: 40, available: 60, state: 'partial' });
    expect(w.assignments.map((a) => a.id)).toEqual([1]);
  });

  it('counts an approved booking with a pending change at its current allocation', () => {
    const [w] = calculateWorkloadCells(
      [{ ...base, id: 1, allocation: 40, approval_status: 'approved' as const }],
      [],
      [cell('2026-03-03')]
    );
    expect(w.total).toBe(40);
  });

  it('shows an empty cell when the only booking is pending', () => {
    const [w] = calculateWorkloadCells(
      [{ ...base, id: 2, allocation: 60, approval_status: 'pending' as const }],
      [],
      [cell('2026-03-03')]
    );
    expect(w).toMatchObject({ total: 0, state: 'empty' });
  });
});
