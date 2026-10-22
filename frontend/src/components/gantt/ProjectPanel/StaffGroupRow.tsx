/**
 * StaffGroupRow - the overview row of one person's bookings on one phase /
 * subphase (1.17.0), shown when the person has two or more rows there:
 * chevron, name, "N bookings" and the allocation range. The bookings follow
 * at the next depth while expanded (CardStaffRows); the timeline draws the
 * matching SegmentsBar row.
 *
 * Its height (--detail-row-height + 1 px border) equals an assignment row's.
 * Class names deliberately avoid "row" and the element carries no
 * `data-*-id`: drag/resize hooks and the dependency layer locate rows with
 * `[class*="row"]` / data-attribute selectors (see SectionRow).
 */

import { memo } from 'react';
import styles from './StaffGroupRow.module.css';

interface StaffGroupRowProps {
  name: string;
  /** Number of bookings the person has on the card (2+) */
  count: number;
  /** "40 %" or "20–60 %" (allocationRange) */
  allocationText: string;
  collapsed: boolean;
  onToggle: () => void;
  depth: number;
}

export const StaffGroupRow = memo(function StaffGroupRow({
  name,
  count,
  allocationText,
  collapsed,
  onToggle,
  depth,
}: StaffGroupRowProps) {
  // Same left edge as a phase row at this depth (chevron in the expand slot),
  // so the name lines up with an assignment row's badge at the same depth.
  const paddingLeft = depth * 16 + 8;
  return (
    <div className={styles.staffGroup} style={{ paddingLeft }}>
      <button
        type="button"
        className={styles.collapseBtn}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}'s bookings`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        <svg
          className={`${styles.chevron} ${collapsed ? '' : styles.chevronOpen}`}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      <span className={styles.name} title={name}>
        {name}
      </span>
      <span className={styles.count}>{count} bookings</span>
      <span className={styles.allocation}>{allocationText}</span>
    </div>
  );
});
