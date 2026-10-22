/**
 * The click rules of the range picker (booking.com style): the first click
 * sets the start, the next the end; the end never precedes the start, and a
 * start moved past the end drags the end along, keeping the duration.
 */
import { describe, it, expect } from 'vitest';
import { applyRangeClick, collapseOptionalEnd, initialMonth, previewRange } from '../dateRangeLogic';

describe('applyRangeClick — start active', () => {
  it('sets the start and hands over to the end when the click is not after the end', () => {
    expect(applyRangeClick({ start: '2026-03-10', end: '2026-03-20', active: 'start' }, '2026-03-05')).toEqual({
      start: '2026-03-05',
      end: '2026-03-20',
      active: 'end',
      done: false,
    });
  });

  it('accepts a start on the end day (a one-day range)', () => {
    expect(applyRangeClick({ start: '2026-03-10', end: '2026-03-20', active: 'start' }, '2026-03-20')).toEqual({
      start: '2026-03-20',
      end: '2026-03-20',
      active: 'end',
      done: false,
    });
  });

  it('shifts the end by the same number of days when the start passes the end', () => {
    // 10 → 13 Mar is 3 days; a start on 25 Mar moves the end to 28 Mar
    expect(applyRangeClick({ start: '2026-03-10', end: '2026-03-13', active: 'start' }, '2026-03-25')).toEqual({
      start: '2026-03-25',
      end: '2026-03-28',
      active: 'end',
      done: false,
    });
  });

  it('keeps the duration across the 29 Mar 2026 DST switch and month ends', () => {
    // 27 → 31 Mar (4 days, the clocks go forward on the 29th) moved to 30 Apr → 4 May
    expect(applyRangeClick({ start: '2026-03-27', end: '2026-03-31', active: 'start' }, '2026-04-30')).toMatchObject({
      start: '2026-04-30',
      end: '2026-05-04',
    });
    // 28 Jan → 1 Feb (4 days) moved to 26 Feb → 2 Mar (no 29 Feb in 2026)
    expect(applyRangeClick({ start: '2026-01-28', end: '2026-02-01', active: 'start' }, '2026-02-26')).toMatchObject({
      start: '2026-02-26',
      end: '2026-03-02',
    });
  });

  it('sets only the start when there is no end yet', () => {
    expect(applyRangeClick({ start: '', end: '', active: 'start' }, '2026-03-10')).toEqual({
      start: '2026-03-10',
      end: '',
      active: 'end',
      done: false,
    });
  });
});

describe('applyRangeClick — end active', () => {
  it('sets the end and is done when the click is on or after the start', () => {
    expect(applyRangeClick({ start: '2026-03-10', end: '2026-03-20', active: 'end' }, '2026-04-02')).toEqual({
      start: '2026-03-10',
      end: '2026-04-02',
      active: 'end',
      done: true,
    });
  });

  it('allows a same-day range', () => {
    expect(applyRangeClick({ start: '2026-03-10', end: '2026-03-20', active: 'end' }, '2026-03-10')).toEqual({
      start: '2026-03-10',
      end: '2026-03-10',
      active: 'end',
      done: true,
    });
  });

  it('makes a click before the start the new start, shifting the end, and keeps waiting for the end', () => {
    expect(applyRangeClick({ start: '2026-03-10', end: '2026-03-12', active: 'end' }, '2026-03-01')).toEqual({
      start: '2026-03-01',
      end: '2026-03-03',
      active: 'end',
      done: false,
    });
  });

  it('moves the start alone when the end is empty', () => {
    expect(applyRangeClick({ start: '2026-03-10', end: '', active: 'end' }, '2026-03-01')).toEqual({
      start: '2026-03-01',
      end: '',
      active: 'end',
      done: false,
    });
  });

  it('treats an empty start as the start being active', () => {
    expect(applyRangeClick({ start: '', end: '2026-03-20', active: 'end' }, '2026-03-05')).toEqual({
      start: '2026-03-05',
      end: '2026-03-20',
      active: 'end',
      done: false,
    });
    // past the end with no start to measure from: the end follows the click
    expect(applyRangeClick({ start: '', end: '2026-03-20', active: 'end' }, '2026-03-25')).toEqual({
      start: '2026-03-25',
      end: '2026-03-25',
      active: 'end',
      done: false,
    });
  });
});

describe('collapseOptionalEnd', () => {
  it('turns an end equal to the start into "" when the end is optional', () => {
    expect(collapseOptionalEnd({ start: '2026-03-10', end: '2026-03-10' }, true)).toEqual({ start: '2026-03-10', end: '' });
  });

  it('keeps a distinct end, and any end of a required range', () => {
    expect(collapseOptionalEnd({ start: '2026-03-10', end: '2026-03-11' }, true)).toEqual({ start: '2026-03-10', end: '2026-03-11' });
    expect(collapseOptionalEnd({ start: '2026-03-10', end: '2026-03-10' }, false)).toEqual({ start: '2026-03-10', end: '2026-03-10' });
  });
});

describe('previewRange', () => {
  it('previews the range the hovered day would produce while the end is awaited', () => {
    expect(previewRange({ start: '2026-03-10', end: '', active: 'end' }, '2026-03-14')).toEqual({ from: '2026-03-10', to: '2026-03-14' });
  });

  it('previews the shifted range when the hovered day would move the start', () => {
    expect(previewRange({ start: '2026-03-10', end: '2026-03-12', active: 'start' }, '2026-03-20')).toEqual({
      from: '2026-03-20',
      to: '2026-03-22',
    });
  });

  it('has nothing to preview without both ends', () => {
    expect(previewRange({ start: '', end: '', active: 'start' }, '2026-03-14')).toBeNull();
    expect(previewRange({ start: '2026-03-10', end: '', active: 'end' }, '2026-03-01')).toBeNull();
  });
});

describe('initialMonth', () => {
  it('opens on the month of the active field', () => {
    expect(initialMonth({ start: '2026-03-10', end: '2026-07-02', active: 'start' }, 2, '2026-10-22')).toBe('2026-03-01');
    expect(initialMonth({ start: '2026-03-10', end: '2026-07-02', active: 'end' }, 2, '2026-10-22')).toBe('2026-07-01');
  });

  it('shows the start month first when the end sits in the next one (both visible)', () => {
    expect(initialMonth({ start: '2026-03-28', end: '2026-04-02', active: 'end' }, 2, '2026-10-22')).toBe('2026-03-01');
    expect(initialMonth({ start: '2026-03-28', end: '2026-04-02', active: 'end' }, 1, '2026-10-22')).toBe('2026-04-01');
  });

  it('falls back to the start, then to today', () => {
    expect(initialMonth({ start: '2026-03-10', end: '', active: 'end' }, 2, '2026-10-22')).toBe('2026-03-01');
    expect(initialMonth({ start: '', end: '', active: 'start' }, 2, '2026-10-22')).toBe('2026-10-01');
  });
});
