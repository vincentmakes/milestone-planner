/**
 * Placement of the calendar panel (position: fixed, so viewport coordinates).
 * jsdom returns zero rects, so the component tests cannot exercise flipping
 * or clamping — this is where they are pinned.
 */
import { describe, it, expect } from 'vitest';
import { computePopoverPosition, isAnchorInView, unionRect } from '../computePopoverPosition';

const DESKTOP = { width: 1440, height: 900 };
const PANEL = { width: 560, height: 340 };
const OPTS = { gap: 4, gutter: 8 };

function anchorAt(top: number, left = 100, height = 36, width = 400) {
  return { top, left, bottom: top + height, right: left + width };
}

describe('computePopoverPosition', () => {
  it('opens below the fields, aligned to their left edge', () => {
    expect(computePopoverPosition(anchorAt(100), PANEL, DESKTOP, OPTS)).toEqual({
      top: 140,
      left: 100,
      placement: 'below',
      maxHeight: 900 - 136 - 4 - 8,
    });
  });

  it('flips above when there is not enough room below', () => {
    expect(computePopoverPosition(anchorAt(600), PANEL, DESKTOP, OPTS)).toEqual({
      top: 600 - 4 - 340,
      left: 100,
      placement: 'above',
      maxHeight: 600 - 4 - 8,
    });
  });

  it('keeps the previous side while it still fits', () => {
    const tall = { width: 1440, height: 1000 };
    expect(computePopoverPosition(anchorAt(600), PANEL, tall, OPTS).placement).toBe('below');
    expect(computePopoverPosition(anchorAt(600), PANEL, tall, { ...OPTS, keep: 'above' }).placement).toBe('above');
    // …but not once it no longer fits
    expect(computePopoverPosition(anchorAt(100), PANEL, tall, { ...OPTS, keep: 'above' }).placement).toBe('below');
  });

  it('clamps to the right edge of the viewport', () => {
    expect(computePopoverPosition(anchorAt(100, 1000), PANEL, DESKTOP, OPTS).left).toBe(1440 - 8 - 560);
  });

  it('keeps the left gutter', () => {
    expect(computePopoverPosition(anchorAt(100, 2), PANEL, DESKTOP, OPTS).left).toBe(8);
  });

  it('takes the roomier side and caps the height when the panel fits neither', () => {
    const short = { width: 1440, height: 500 };
    const tallPanel = { width: 560, height: 600 };
    // below: 500 - 236 - 12 = 252, above: 200 - 12 = 188
    expect(computePopoverPosition(anchorAt(200), tallPanel, short, OPTS)).toEqual({
      top: 240,
      left: 100,
      placement: 'below',
      maxHeight: 252,
    });
    // below: 500 - 336 - 12 = 152, above: 300 - 12 = 288 → above, pinned to the top gutter
    expect(computePopoverPosition(anchorAt(300), tallPanel, short, OPTS)).toEqual({
      top: 8,
      left: 100,
      placement: 'above',
      maxHeight: 288,
    });
  });

  it('uses a 4 px gutter on a 320 px phone and centres a panel wider than the room', () => {
    const phone = { width: 320, height: 640 };
    expect(computePopoverPosition(anchorAt(100, 16, 36, 288), { width: 312, height: 380 }, phone, OPTS).left).toBe(4);
    expect(computePopoverPosition(anchorAt(100, 16, 36, 288), { width: 318, height: 380 }, phone, OPTS).left).toBe(1);
  });
});

describe('unionRect', () => {
  it('spans both fields, side by side or stacked', () => {
    expect(
      unionRect([
        { top: 100, left: 20, bottom: 136, right: 200 },
        { top: 100, left: 216, bottom: 136, right: 396 },
      ])
    ).toEqual({ top: 100, left: 20, bottom: 136, right: 396 });
    expect(
      unionRect([
        { top: 100, left: 16, bottom: 136, right: 304 },
        { top: 152, left: 16, bottom: 188, right: 304 },
      ])
    ).toEqual({ top: 100, left: 16, bottom: 188, right: 304 });
  });
});

describe('isAnchorInView', () => {
  it('is false once the fields have scrolled out of the viewport', () => {
    expect(isAnchorInView(anchorAt(100), DESKTOP)).toBe(true);
    expect(isAnchorInView(anchorAt(-40), DESKTOP)).toBe(false);
    expect(isAnchorInView(anchorAt(901), DESKTOP)).toBe(false);
    expect(isAnchorInView(anchorAt(-30), DESKTOP)).toBe(true); // partly visible
  });
});
