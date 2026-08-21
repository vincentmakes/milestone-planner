/**
 * The header's "⋯" menu: where toolbar controls go when the bar runs out of
 * room, so that narrowing the window never makes a control unreachable.
 *
 * Deliberately dumb — it owns the trigger, the open state and the dismiss
 * behaviour; the controls themselves are passed as children and stay wired up
 * in Header.tsx, rendered in exactly one place at any width.
 *
 * It is NOT the shared ContextMenu, which closes on every item click and is
 * positioned from right-click coordinates. What lives in here is a
 * `− 100% +` triplet and a segmented view-mode switcher: pressing `+` three
 * times has to keep the panel open and the percentage live. Only an outside
 * click or Escape closes this one.
 */

import { useEffect, useRef, useState } from 'react';
import styles from './HeaderOverflowMenu.module.css';

interface HeaderOverflowMenuProps {
  children: React.ReactNode;
  /** Overrides the trigger's accessible name; defaults to "More controls". */
  label?: string;
}

export function HeaderOverflowMenu({ children, label = 'More controls' }: HeaderOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Close only this menu — anything open behind it stays open.
      e.stopPropagation();
      setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    // Capture, so the menu wins Escape ahead of the app-wide shortcut handler.
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>

      {open && (
        <div className={styles.panel} role="group" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

/** One labelled row inside the menu. Exported so Header.tsx composes the rows. */
export function OverflowRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      {children}
    </div>
  );
}
