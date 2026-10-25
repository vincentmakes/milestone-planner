/**
 * Event lanes — where each company event's colour band sits in the timeline
 * strip (day zoom).
 *
 * The strip has `MAX_LANES` thin lanes stacked from the top. Lane 0 belongs to
 * the bank-holiday line on every cell that has one, so events there start at
 * lane 1. Each event draws one band per contiguous stretch of cells it covers
 * (a run); cell *indices* are what count, so hidden weekends never split a
 * run, but an event that leaves the cells and comes back gets a second run.
 *
 * Runs are placed greedily, left to right: at each cell, the events that
 * start a run there are taken in the cell's own `companyEvents` order
 * (closures first, see `timeline.ts`), each on the lowest lane free over every
 * cell of its run. A run that finds no free lane is not drawn; it adds 1 to
 * `overflow` on each of its cells (the strip's "+N"). The input order is
 * total, so the result is deterministic.
 */

import type { CellEvent, TimelineCell } from './timeline';

/** Lanes in the strip, the bank-holiday lane included */
export const MAX_LANES = 3;

/** One band: `event` drawn on `lane` from cell `from` to cell `to` (indices, inclusive) */
export interface EventRun {
  event: CellEvent;
  lane: number;
  from: number;
  to: number;
}

/**
 * Lay the events of day cells out on lanes.
 *
 * `cells` must be day cells (week / month zoom); a span cell (one carrying
 * `dateEnd`, a quarter week) is skipped — it holds no band and ends any run
 * across it. Returns the drawn runs, ordered by `from` and then by the cell's
 * event order, and `overflow`: cell index → number of events not drawn there
 * (absent = 0).
 */
export function assignEventLanes(cells: readonly TimelineCell[]): {
  runs: EventRun[];
  overflow: Map<number, number>;
} {
  const runs: EventRun[] = [];
  const overflow = new Map<number, number>();

  const dayCell = (cell: TimelineCell) => cell.dateEnd === undefined;
  const ids = cells.map((cell) => new Set(dayCell(cell) ? cell.companyEvents.map((e) => e.id) : []));
  const taken = cells.map((cell) => {
    const lanes = new Array<boolean>(MAX_LANES).fill(false);
    if (cell.isBankHoliday && dayCell(cell)) lanes[0] = true;
    return lanes;
  });
  /** Event id → the last cell index of the run already handled for it */
  const handledThrough = new Map<number, number>();

  cells.forEach((cell, from) => {
    if (!dayCell(cell)) return;
    for (const event of cell.companyEvents) {
      if ((handledThrough.get(event.id) ?? -1) >= from) continue;
      let to = from;
      while (to + 1 < cells.length && ids[to + 1].has(event.id)) to++;
      handledThrough.set(event.id, to);

      const lane = freeLane(taken, from, to);
      if (lane === null) {
        for (let i = from; i <= to; i++) overflow.set(i, (overflow.get(i) ?? 0) + 1);
        continue;
      }
      for (let i = from; i <= to; i++) taken[i][lane] = true;
      runs.push({ event, lane, from, to });
    }
  });

  return { runs, overflow };
}

/** The lowest lane free on every cell from `from` to `to`, or null */
function freeLane(taken: boolean[][], from: number, to: number): number | null {
  for (let lane = 0; lane < MAX_LANES; lane++) {
    let free = true;
    for (let i = from; i <= to && free; i++) free = !taken[i][lane];
    if (free) return lane;
  }
  return null;
}
