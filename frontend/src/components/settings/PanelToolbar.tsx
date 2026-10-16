/**
 * PanelToolbar — the one toolbar layout of the Settings hub panels.
 *
 * Filters, counts or a search field go in `left`; the panel's actions go in
 * `right` as shared `Button`s (secondary actions first, the primary
 * "Add …" button last). Either slot may be omitted.
 *
 * `align="end"` bottom-aligns both slots — use it when `left` holds
 * labelled fields (a label stacked above a select), so the buttons line up
 * with the controls rather than the middle of the label + control stack.
 */

import type { ReactNode } from 'react';
import styles from './PanelToolbar.module.css';

export interface PanelToolbarProps {
  /** Filters, counts, search — rendered on the left */
  left?: ReactNode;
  /** Action buttons — rendered on the right (primary action last) */
  right?: ReactNode;
  /** Cross-axis alignment of the two slots (default `center`) */
  align?: 'center' | 'end';
  className?: string;
}

export function PanelToolbar({ left, right, align = 'center', className }: PanelToolbarProps) {
  const classes = [styles.toolbar, align === 'end' && styles.alignEnd, className]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes}>
      {left != null && left !== false && <div className={styles.left}>{left}</div>}
      {right != null && right !== false && <div className={styles.right}>{right}</div>}
    </div>
  );
}
