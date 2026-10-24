/**
 * The row-fluid resize rule (pure): a widget's width change is absorbed by
 * its right column — the items sharing its rows at the smallest `x` right of
 * it — down to two columns each; the grid's edge when there is none; heights,
 * widgets to the left and widgets further right untouched; and the `maxW`
 * each widget is given for it.
 */
import { describe, it, expect } from 'vitest';
import type { Layout, LayoutItem } from 'react-grid-layout';
import { fluidMaxW, fluidResize, MIN_COLS, rightColumn } from '../gridLayouts';

const item = (i: string, x: number, y: number, w: number, h: number): LayoutItem => ({ i, x, y, w, h });

/** `i → [x, y, w, h]` of a layout, for compact expectations. */
const boxes = (layout: Layout) => Object.fromEntries(layout.map((l) => [l.i, [l.x, l.y, l.w, l.h]]));

// The Overview on lg: four KPIs (3 columns each), then two charts per row.
const overview: Layout = [
  item('k1', 0, 0, 3, 2),
  item('k2', 3, 0, 3, 2),
  item('k3', 6, 0, 3, 2),
  item('k4', 9, 0, 3, 2),
  item('c1', 0, 2, 6, 5),
  item('c2', 6, 2, 6, 5),
  item('c3', 0, 7, 6, 5),
  item('c4', 6, 7, 6, 5),
];

describe('fluidResize', () => {
  it('narrows the right neighbour by what the widget grows', () => {
    const out = fluidResize(overview, 'c1', 8, 12);
    expect(boxes(out).c1).toEqual([0, 2, 8, 5]);
    expect(boxes(out).c2).toEqual([8, 2, 4, 5]);
    // The row below and the KPIs above are untouched
    expect(boxes(out).c3).toEqual([0, 7, 6, 5]);
    expect(boxes(out).k3).toEqual([6, 0, 3, 2]);
  });

  it('widens the right neighbour into what the widget gives up', () => {
    const out = fluidResize(overview, 'c1', 3, 12);
    expect(boxes(out).c1).toEqual([0, 2, 3, 5]);
    expect(boxes(out).c2).toEqual([3, 2, 9, 5]);
  });

  it('moves a stacked column together (two KPIs beside a tall chart)', () => {
    const layout: Layout = [item('chart', 0, 0, 6, 4), item('a', 6, 0, 6, 2), item('b', 6, 2, 4, 2), item('far', 10, 2, 2, 2)];
    const grown = fluidResize(layout, 'chart', 7, 12);
    expect(boxes(grown)).toEqual({ chart: [0, 0, 7, 4], a: [7, 0, 5, 2], b: [7, 2, 3, 2], far: [10, 2, 2, 2] });
    // The narrowest item of the column decides: b (4 columns) gives 2 at most
    const capped = fluidResize(layout, 'chart', 12, 12);
    expect(boxes(capped)).toEqual({ chart: [0, 0, 8, 4], a: [8, 0, 4, 2], b: [8, 2, 2, 2], far: [10, 2, 2, 2] });
    const shrunk = fluidResize(layout, 'chart', 4, 12);
    expect(boxes(shrunk)).toEqual({ chart: [0, 0, 4, 4], a: [4, 0, 8, 2], b: [4, 2, 6, 2], far: [10, 2, 2, 2] });
  });

  it('is capped by the grid’s edge without a right neighbour, and leaves the freed space empty', () => {
    expect(boxes(fluidResize(overview, 'c2', 9, 12)).c2).toEqual([6, 2, 6, 5]);
    const shrunk = fluidResize(overview, 'c2', 4, 12);
    expect(boxes(shrunk).c2).toEqual([6, 2, 4, 5]);
    expect(boxes(shrunk).c1).toEqual([0, 2, 6, 5]);
    // A widget alone in its row grows to the edge, not past it
    const alone: Layout = [item('a', 2, 0, 4, 2)];
    expect(boxes(fluidResize(alone, 'a', 20, 12)).a).toEqual([2, 0, 10, 2]);
  });

  it('keeps every widget at two columns at least, on both sides', () => {
    // Growing a KPI: its neighbour stops at 2 columns, the next one is untouched
    const grown = fluidResize(overview, 'k1', 6, 12);
    expect(boxes(grown).k1).toEqual([0, 0, 4, 2]);
    expect(boxes(grown).k2).toEqual([4, 0, 2, 2]);
    expect(boxes(grown).k3).toEqual([6, 0, 3, 2]);
    expect(boxes(grown).k4).toEqual([9, 0, 3, 2]);
    // Shrinking: the widget itself stops at 2 columns
    const shrunk = fluidResize(overview, 'k1', 1, 12);
    expect(boxes(shrunk).k1).toEqual([0, 0, MIN_COLS, 2]);
    expect(boxes(shrunk).k2).toEqual([2, 0, 4, 2]);
    // A neighbour already at 2 columns gives nothing
    const tight: Layout = [item('a', 0, 0, 10, 2), item('b', 10, 0, 2, 2)];
    expect(fluidResize(tight, 'a', 11, 12)).toEqual(tight);
    // A widget stored narrower than 2 columns keeps its width, never less
    const narrow: Layout = [item('a', 0, 0, 1, 2), item('b', 1, 0, 11, 2)];
    expect(boxes(fluidResize(narrow, 'a', 0, 12)).a).toEqual([0, 0, 1, 2]);
    expect(boxes(fluidResize(narrow, 'a', 3, 12))).toEqual({ a: [0, 0, 3, 2], b: [3, 0, 9, 2] });
  });

  it('counts a partial vertical overlap as sharing the row, and an adjacent row not', () => {
    const layout: Layout = [item('a', 0, 0, 6, 4), item('b', 6, 3, 6, 4), item('c', 6, 7, 6, 2)];
    const out = fluidResize(layout, 'a', 8, 12);
    expect(boxes(out).b).toEqual([8, 3, 4, 4]);
    // c starts where a's rows end: not in its band
    expect(boxes(out).c).toEqual([6, 7, 6, 2]);
  });

  it('leaves the items further right and the widgets to the left untouched', () => {
    // k3 (3 columns) gives one, down to 2; k1 left of it and k4 right of k3 stay
    const out = fluidResize(overview, 'k2', 5, 12);
    expect(boxes(out)).toMatchObject({ k1: [0, 0, 3, 2], k2: [3, 0, 4, 2], k3: [7, 0, 2, 2], k4: [9, 0, 3, 2] });
  });

  it('passes heights through and keeps the order', () => {
    const out = fluidResize(overview, 'c1', 8, 12);
    expect(out.map((l) => l.i)).toEqual(overview.map((l) => l.i));
    expect(out.map((l) => [l.y, l.h])).toEqual(overview.map((l) => [l.y, l.h]));
    // Unchanged items are the same objects; the input is not mutated
    expect(out[0]).toBe(overview[0]);
    expect(boxes(overview).c1).toEqual([0, 2, 6, 5]);
  });

  it('changes nothing for the same width, or an unknown widget', () => {
    const same = fluidResize(overview, 'c1', 6, 12);
    expect(same).toEqual(overview);
    expect(same).not.toBe(overview);
    expect(fluidResize(same, 'c1', 6, 12)).toEqual(overview);
    expect(fluidResize(overview, 'nope', 9, 12)).toEqual(overview);
  });

  it('follows the same rule on phones (4 columns): two widgets trade width, down to 2', () => {
    const sm: Layout = [item('a', 0, 0, 2, 2), item('b', 2, 0, 2, 2), item('c', 0, 2, 4, 5)];
    // b is already at 2 columns: a cannot grow
    expect(fluidResize(sm, 'a', 3, 4)).toEqual(sm);
    const wide: Layout = [item('a', 0, 0, 1, 2), item('b', 1, 0, 3, 2)];
    expect(boxes(fluidResize(wide, 'a', 4, 4))).toEqual({ a: [0, 0, 2, 2], b: [2, 0, 2, 2] });
    // A full-width widget is capped by the edge
    expect(boxes(fluidResize(sm, 'c', 6, 4)).c).toEqual([0, 2, 4, 5]);
  });
});

describe('rightColumn', () => {
  it('is the band’s items at the smallest x right of the widget', () => {
    const layout: Layout = [item('chart', 0, 0, 6, 4), item('a', 6, 0, 6, 2), item('b', 6, 2, 4, 2), item('far', 10, 2, 2, 2)];
    expect(rightColumn(layout, layout[0]).map((l) => l.i)).toEqual(['a', 'b']);
    expect(rightColumn(layout, layout[3])).toEqual([]);
    // Left of the widget does not count
    expect(rightColumn(overview, overview[3])).toEqual([]);
  });
});

describe('fluidMaxW', () => {
  it('is the columns to the edge without a right column, at least the width', () => {
    expect(fluidMaxW(overview, overview[3], 12)).toBe(3);
    expect(fluidMaxW(overview, overview[5], 12)).toBe(6);
    expect(fluidMaxW([item('a', 10, 0, 4, 2)], item('a', 10, 0, 4, 2), 12)).toBe(4);
  });

  it('is the column’s right edge − x − 2 with one, the narrowest item deciding', () => {
    // c1 beside c2 (6..12): 12 − 0 − 2
    expect(fluidMaxW(overview, overview[4], 12)).toBe(10);
    // k1 beside k2 (3..6): 6 − 0 − 2
    expect(fluidMaxW(overview, overview[0], 12)).toBe(4);
    // A stacked column whose narrowest item ends at 10: 10 − 0 − 2
    const layout: Layout = [item('chart', 0, 0, 6, 4), item('a', 6, 0, 6, 2), item('b', 6, 2, 4, 2)];
    expect(fluidMaxW(layout, layout[0], 12)).toBe(8);
    // A neighbour already at 2 columns (or less) leaves only the current width
    const tight: Layout = [item('a', 0, 0, 10, 2), item('b', 10, 0, 1, 2)];
    expect(fluidMaxW(tight, tight[0], 12)).toBe(10);
  });

  it('agrees with what fluidResize lets the widget grow to', () => {
    for (const entry of overview) {
      const max = fluidMaxW(overview, entry, 12);
      const out = fluidResize(overview, entry.i, 12, 12);
      expect(out.find((l) => l.i === entry.i)!.w).toBe(max);
    }
  });
});
