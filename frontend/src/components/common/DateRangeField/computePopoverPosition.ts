/**
 * Where the calendar panel goes. The panel is `position: fixed` inside the
 * field wrapper (no portal), so everything here is in viewport coordinates.
 *
 * Below the fields by default, flipped above when the room below is short;
 * the side chosen last time (`keep`) is kept while it still fits, so the
 * panel does not jump while the dialog body scrolls. When neither side fits,
 * the roomier one wins and `maxHeight` caps the panel (it scrolls inside).
 * Horizontally it starts at the fields' left edge and is clamped between the
 * gutters — 4 px instead of `gutter` on viewports under 340 px — and centred
 * when it is wider than the room between them.
 */

export interface AnchorRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Placement = 'below' | 'above';

export interface PopoverPosition {
  top: number;
  left: number;
  placement: Placement;
  maxHeight: number;
}

export interface PopoverPositionOptions {
  /** Between the fields and the panel. */
  gap: number;
  /** Minimum distance to the viewport edges. */
  gutter: number;
  /** The side used before: kept while the panel still fits there. */
  keep?: Placement;
}

const NARROW_VIEWPORT = 340;
const NARROW_GUTTER = 4;

export function computePopoverPosition(
  anchor: AnchorRect,
  panel: Size,
  viewport: Size,
  { gap, gutter, keep }: PopoverPositionOptions
): PopoverPosition {
  const edge = viewport.width < NARROW_VIEWPORT ? Math.min(gutter, NARROW_GUTTER) : gutter;

  const room: Record<Placement, number> = {
    below: viewport.height - anchor.bottom - gap - edge,
    above: anchor.top - gap - edge,
  };
  const fits = (side: Placement) => panel.height <= room[side];

  let placement: Placement;
  if (keep && fits(keep)) placement = keep;
  else if (fits('below')) placement = 'below';
  else if (fits('above')) placement = 'above';
  else placement = room.above > room.below ? 'above' : 'below';

  const maxHeight = Math.max(0, room[placement]);
  const height = Math.min(panel.height, maxHeight);
  const top = placement === 'below' ? anchor.bottom + gap : anchor.top - gap - height;

  const left =
    panel.width > viewport.width - 2 * edge
      ? Math.max(0, (viewport.width - panel.width) / 2)
      : Math.max(edge, Math.min(anchor.left, viewport.width - edge - panel.width));

  return { top, left, placement, maxHeight };
}

/** The box around every rect (the two fields: side by side, or stacked on a phone). */
export function unionRect(rects: readonly AnchorRect[]): AnchorRect {
  return {
    top: Math.min(...rects.map((r) => r.top)),
    left: Math.min(...rects.map((r) => r.left)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
    right: Math.max(...rects.map((r) => r.right)),
  };
}

/** False once the fields have scrolled completely out of the viewport (the panel then closes). */
export function isAnchorInView(anchor: AnchorRect, viewport: Size): boolean {
  return anchor.bottom >= 0 && anchor.top <= viewport.height;
}
