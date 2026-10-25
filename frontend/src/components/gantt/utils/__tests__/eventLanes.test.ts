/**
 * The strip's lane rule: each event's run takes the lowest lane free over its
 * cells, lane 0 is the bank-holiday line where there is one, and a run with
 * no free lane among MAX_LANES is counted in `overflow` instead of drawn.
 */
import { describe, expect, it } from 'vitest';
import { assignEventLanes, MAX_LANES } from '../eventLanes';
import { generateTimelineCells, type CellEvent, type TimelineCell } from '../timeline';

function ev(id: number, start: string, end = start, extra: Partial<CellEvent> = {}): CellEvent {
  return { id, name: `Event ${id}`, color: null, start, end, isClosure: false, teamIds: [], ...extra };
}

/** Hand-built day cells: `days[i]` lists the events present on cell i */
function cells(days: CellEvent[][], holidays: number[] = []): TimelineCell[] {
  return days.map((events, i) => ({
    dateStr: `2026-03-${String(i + 1).padStart(2, '0')}`,
    isBankHoliday: holidays.includes(i),
    companyEvents: events,
  })) as unknown as TimelineCell[];
}

const lanesOf = (result: ReturnType<typeof assignEventLanes>) =>
  result.runs.map((r) => ({ id: r.event.id, lane: r.lane, from: r.from, to: r.to }));

describe('assignEventLanes', () => {
  it('puts a lone event on lane 0 over its cells', () => {
    const a = ev(1, '2026-03-02', '2026-03-03');
    const result = assignEventLanes(cells([[], [a], [a], []]));
    expect(lanesOf(result)).toEqual([{ id: 1, lane: 0, from: 1, to: 2 }]);
    expect(result.runs[0].event).toBe(a);
    expect(result.overflow.size).toBe(0);
  });

  it('stacks two overlapping events on lanes 0 and 1', () => {
    const a = ev(1, '2026-03-01', '2026-03-02');
    const b = ev(2, '2026-03-02', '2026-03-03');
    expect(lanesOf(assignEventLanes(cells([[a], [a, b], [b]])))).toEqual([
      { id: 1, lane: 0, from: 0, to: 1 },
      { id: 2, lane: 1, from: 1, to: 2 },
    ]);
  });

  it('stacks three on lanes 0, 1 and 2', () => {
    const [a, b, c] = [ev(1, '2026-03-01'), ev(2, '2026-03-01'), ev(3, '2026-03-01')];
    expect(lanesOf(assignEventLanes(cells([[a, b, c]]))).map((r) => r.lane)).toEqual([0, 1, 2]);
  });

  it('counts a fourth overlapping event as overflow on its cells and draws no run for it', () => {
    const [a, b, c] = [ev(1, '2026-03-01', '2026-03-03'), ev(2, '2026-03-01', '2026-03-03'), ev(3, '2026-03-01', '2026-03-03')];
    const d = ev(4, '2026-03-02', '2026-03-03');
    const result = assignEventLanes(cells([[a, b, c], [a, b, c, d], [a, b, c, d], [d]]));
    expect(result.runs.map((r) => r.event.id)).toEqual([1, 2, 3]);
    // d's run is cells 1–3; cell 3 has free lanes but the run is placed whole
    expect([...result.overflow.entries()]).toEqual([[1, 1], [2, 1], [3, 1]]);
    expect(MAX_LANES).toBe(3);
  });

  it('frees a lane once an event ends', () => {
    const a = ev(1, '2026-03-01');
    const b = ev(2, '2026-03-01', '2026-03-02');
    const c = ev(3, '2026-03-02');
    expect(lanesOf(assignEventLanes(cells([[a, b], [b, c]])))).toEqual([
      { id: 1, lane: 0, from: 0, to: 0 },
      { id: 2, lane: 1, from: 0, to: 1 },
      { id: 3, lane: 0, from: 1, to: 1 },
    ]);
  });

  it('gives lane 0 to a closure before a plain event that started earlier (the cell order)', () => {
    const plain = ev(1, '2026-02-20', '2026-03-02');
    const closure = ev(2, '2026-03-01', '2026-03-02', { isClosure: true });
    // generateTimelineCells lists closures first in every cell
    const result = assignEventLanes(cells([[closure, plain], [closure, plain]]));
    expect(lanesOf(result)).toEqual([
      { id: 2, lane: 0, from: 0, to: 1 },
      { id: 1, lane: 1, from: 0, to: 1 },
    ]);
  });

  it('keeps lane 0 for a bank holiday, so three events take lanes 1, 2 and overflow', () => {
    const [a, b, c] = [ev(1, '2026-03-01'), ev(2, '2026-03-01'), ev(3, '2026-03-01')];
    const result = assignEventLanes(cells([[a, b, c]], [0]));
    expect(lanesOf(result)).toEqual([
      { id: 1, lane: 1, from: 0, to: 0 },
      { id: 2, lane: 2, from: 0, to: 0 },
    ]);
    expect(result.overflow.get(0)).toBe(1);
  });

  it('lets a run cross a holiday cell only on a lane above the holiday line', () => {
    const a = ev(1, '2026-03-01', '2026-03-03');
    expect(lanesOf(assignEventLanes(cells([[a], [a], [a]], [1])))).toEqual([{ id: 1, lane: 1, from: 0, to: 2 }]);
  });

  it('keeps one run across a hidden weekend (indices stay contiguous)', () => {
    // Fri 6 – Mon 9 March 2026, weekends hidden: Fri and Mon are neighbouring cells
    const all = generateTimelineCells(new Date(2026, 2, 6), 'month', new Set(), [], new Set(), [
      { id: 7, date: '2026-03-06', end_date: '2026-03-09', name: 'Trade fair' },
    ], false);
    const friday = all.findIndex((c) => c.dateStr === '2026-03-06');
    expect(all[friday + 1].dateStr).toBe('2026-03-09');
    expect(lanesOf(assignEventLanes(all))).toEqual([{ id: 7, lane: 0, from: friday, to: friday + 1 }]);
  });

  it('draws two runs for an event that leaves the cells and comes back, on the same lane when free', () => {
    const a = ev(1, '2026-03-01', '2026-03-04');
    const b = ev(2, '2026-03-03');
    const result = assignEventLanes(cells([[a], [a], [b], [a]]));
    expect(lanesOf(result)).toEqual([
      { id: 1, lane: 0, from: 0, to: 1 },
      { id: 2, lane: 0, from: 2, to: 2 },
      { id: 1, lane: 0, from: 3, to: 3 },
    ]);
  });

  it('starts a run at the first cell for an event that began before the timeline', () => {
    const a = ev(1, '2025-12-20', '2026-03-02');
    expect(lanesOf(assignEventLanes(cells([[a], [a], []])))).toEqual([{ id: 1, lane: 0, from: 0, to: 1 }]);
  });

  it('skips span cells (quarter weeks): they hold no band and end a run', () => {
    const a = ev(1, '2026-03-01', '2026-03-10');
    const days = cells([[a], [a], [a]]);
    days[1] = { ...days[1], dateEnd: new Date(2026, 2, 8), isBankHoliday: true } as TimelineCell;
    expect(lanesOf(assignEventLanes(days))).toEqual([
      { id: 1, lane: 0, from: 0, to: 0 },
      { id: 1, lane: 0, from: 2, to: 2 },
    ]);
  });

  it('returns nothing for cells without events', () => {
    const result = assignEventLanes(cells([[], []], [0]));
    expect(result.runs).toEqual([]);
    expect(result.overflow.size).toBe(0);
  });
});
