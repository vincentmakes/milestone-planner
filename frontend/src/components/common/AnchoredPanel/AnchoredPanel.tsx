/**
 * AnchoredPanel — a dropdown panel that escapes its container.
 *
 * Renders `children` through a portal into `document.body` (like `Modal`) at
 * `position: fixed`, measured from `triggerRef`'s bounding rect, so no
 * `overflow: hidden` ancestor can clip it (the Gantt pane while an overview
 * panel is open, a short overview header):
 *   - below the trigger, its left edge on the trigger's left (`align="start"`)
 *     or its right edge on the trigger's right (`align="end"`), kept 16 px
 *     inside the viewport;
 *   - flipped above the trigger when the room below is smaller than the
 *     panel's natural height and the room above is larger;
 *   - `max-height` = the room on the chosen side minus a 16 px margin, so a
 *     child with its own `overflow-y: auto` scrolls instead of the panel
 *     leaving the window (the shell is a column flex box);
 *   - re-measured after every render (content changes), on `resize` and on any
 *     `scroll` outside the panel (capture phase) while open.
 * `z-index: var(--z-dropdown)`: under `--z-modal`, so a confirm stacks above.
 *
 * Only the panel moves: the trigger stays where it is, with its
 * `aria-expanded` / `aria-haspopup`. The caller dismisses it through
 * `useDismissableOverlay` with `panelRef` = the ref forwarded here (the panel
 * is outside the wrapper in the DOM; React still bubbles its focus and key
 * events through the wrapper). Keyboard order follows the old in-place panel:
 * Tab on the trigger enters the panel, Shift+Tab from its first stop goes back
 * to the trigger, Tab from its last stop goes on to the element after the
 * trigger (the wrapper's `onBlur` then closes it). Two invisible sentinels at
 * the panel's edges do that.
 *
 * Not for a panel inside a `Modal`: the dialog's Tab trap only knows its own
 * container, so it would pull focus out of a portaled panel.
 *
 * Other HTML attributes (`id`, `role`, `aria-label`, …) go on the panel; the
 * caller's `className` draws it and must not set position, inset or z-index.
 */

import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { FocusEvent, HTMLAttributes, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import styles from './AnchoredPanel.module.css';

export interface AnchoredPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'> {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  /** `start`: the panel's left edge on the trigger's; `end`: right edge on right edge. */
  align: 'start' | 'end';
  children: ReactNode;
  className?: string;
}

/** Margin kept between the panel and the viewport edges. */
const EDGE_MARGIN = 16;
/** Gap between the trigger and the panel. */
const TRIGGER_GAP = 4;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab stops under `root` in document order: one per radio group (its checked radio, else the first). */
function tabStops(root: ParentNode): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('data-focus-sentinel')
  );
  const checkedGroups = new Set(
    all.filter((el) => el instanceof HTMLInputElement && el.type === 'radio' && el.checked).map((el) => (el as HTMLInputElement).name)
  );
  const seenGroups = new Set<string>();
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return true;
    if (checkedGroups.has(el.name)) return el.checked;
    if (seenGroups.has(el.name)) return false;
    seenGroups.add(el.name);
    return true;
  });
}

/** The panel's height without its max-height, keeping every inner scroll position. */
function naturalHeight(panel: HTMLElement): number {
  const scrolled = [panel, ...Array.from(panel.querySelectorAll<HTMLElement>('*'))]
    .filter((el) => el.scrollTop > 0)
    .map((el) => [el, el.scrollTop] as const);
  const previous = panel.style.maxHeight;
  panel.style.maxHeight = 'none';
  const height = panel.getBoundingClientRect().height;
  panel.style.maxHeight = previous;
  for (const [el, top] of scrolled) el.scrollTop = top;
  return height;
}

/** Write the panel's fixed coordinates and max-height from the trigger's rect. */
function place(panel: HTMLElement, trigger: HTMLElement, align: 'start' | 'end'): void {
  const rect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const natural = naturalHeight(panel);
  const roomBelow = viewportHeight - rect.bottom - TRIGGER_GAP - EDGE_MARGIN;
  const roomAbove = rect.top - TRIGGER_GAP - EDGE_MARGIN;
  const above = natural > roomBelow && roomAbove > roomBelow;

  if (above) {
    panel.style.top = 'auto';
    panel.style.bottom = `${viewportHeight - rect.top + TRIGGER_GAP}px`;
  } else {
    panel.style.top = `${rect.bottom + TRIGGER_GAP}px`;
    panel.style.bottom = 'auto';
  }
  panel.style.maxHeight = `${Math.max(0, above ? roomAbove : roomBelow)}px`;

  const width = panel.getBoundingClientRect().width;
  const wanted = align === 'start' ? rect.left : rect.right - width;
  const left = Math.max(EDGE_MARGIN, Math.min(wanted, viewportWidth - width - EDGE_MARGIN));
  panel.style.left = `${left}px`;
  panel.dataset.placement = above ? 'above' : 'below';
}

export const AnchoredPanel = forwardRef<HTMLDivElement, AnchoredPanelProps>(function AnchoredPanel(
  { open, triggerRef, align, children, className, ...rest },
  forwardedRef
) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const alignRef = useRef(align);
  alignRef.current = align;

  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef]
  );

  const reposition = useCallback(() => {
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (panel && trigger) place(panel, trigger, alignRef.current);
  }, [triggerRef]);

  // Every render while open: the content (and so the natural height) may have changed.
  useLayoutEffect(() => {
    if (open) reposition();
  });

  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      // Scrolling the panel's own list moves nothing.
      if (panelRef.current?.contains(e.target as Node)) return;
      reposition();
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, reposition]);

  // Tab on the trigger enters the panel (it sits at the end of <body>, not after the trigger).
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!open || !trigger) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.shiftKey || !panelRef.current) return;
      const first = tabStops(panelRef.current)[0];
      if (!first) return;
      e.preventDefault();
      first.focus();
    };
    trigger.addEventListener('keydown', onKeyDown);
    return () => trigger.removeEventListener('keydown', onKeyDown);
  }, [open, triggerRef]);

  const cameFromPanel = (e: FocusEvent<HTMLElement>) =>
    !!panelRef.current && !!e.relatedTarget && panelRef.current.contains(e.relatedTarget as Node);

  /** Shift+Tab out of the first stop: back to the trigger. */
  const onStartSentinelFocus = (e: FocusEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    if (cameFromPanel(e)) triggerRef.current?.focus();
    else tabStops(panel)[0]?.focus();
  };

  /** Tab out of the last stop: on to whatever follows the trigger. */
  const onEndSentinelFocus = (e: FocusEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    if (!cameFromPanel(e)) {
      const stops = tabStops(panel);
      stops[stops.length - 1]?.focus();
      return;
    }
    const trigger = triggerRef.current;
    const page = tabStops(document.body).filter((el) => !panel.contains(el));
    const index = trigger ? page.indexOf(trigger) : -1;
    const next = index >= 0 ? page[index + 1] : undefined;
    (next ?? trigger)?.focus();
  };

  if (!open) return null;

  return createPortal(
    <div
      {...rest}
      ref={setRef}
      className={className ? `${styles.panel} ${className}` : styles.panel}
      data-align={align}
    >
      <span
        tabIndex={0}
        className={styles.sentinel}
        data-focus-sentinel="start"
        aria-hidden="true"
        onFocus={onStartSentinelFocus}
      />
      {children}
      <span
        tabIndex={0}
        className={styles.sentinel}
        data-focus-sentinel="end"
        aria-hidden="true"
        onFocus={onEndSentinelFocus}
      />
    </div>,
    document.body
  );
});
