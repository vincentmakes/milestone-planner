/**
 * StaffGroupRow - the overview row of one person's bookings on one phase /
 * subphase (1.17.0), shown when the person has two or more rows there:
 * chevron, the card badge (as on the booking rows, without the pin; its
 * name scrolls the timeline to the person's first booking), name,
 * "N bookings" and the allocation range. The bookings follow two levels
 * deeper while expanded (CardStaffRows); the timeline draws the matching
 * SegmentsBar row.
 *
 * Its height (--detail-row-height + 1 px border) equals an assignment row's.
 * Class names deliberately avoid "row" and the element carries no
 * `data-*-id`: drag/resize hooks and the dependency layer locate rows with
 * `[class*="row"]` / data-attribute selectors (see SectionRow).
 */

import { memo } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { toDateOnly } from '@/utils/date';
import { CardBadge } from './CardBadgeView';
import styles from './StaffGroupRow.module.css';
import { Icon, ChevronRightIcon } from '@/components/common/Icon';

interface StaffGroupRowProps {
  name: string;
  /** Number of bookings the person has on the card (2+) */
  count: number;
  /** "40%" or "20–60%" (allocationRange) */
  allocationText: string;
  collapsed: boolean;
  onToggle: () => void;
  /** The depth of the card's booking rows: the group row lines up with them */
  depth: number;
  /** The card: its badge (name, colour) as on the booking rows, without the pin */
  level: 'phase' | 'subphase';
  phaseType?: string;
  phaseColor?: string;
  /** The effective start of the person's first booking on the card (the badge's name scrolls there) */
  firstStart?: string;
}

export const StaffGroupRow = memo(function StaffGroupRow({
  name,
  count,
  allocationText,
  collapsed,
  onToggle,
  depth,
  level,
  phaseType,
  phaseColor,
  firstStart,
}: StaffGroupRowProps) {
  // Indented like a booking row of the card (AssignmentRow: depth * 16 + 28),
  // not like a phase row: the chevron takes the first 20 px of that edge and
  // the card badge follows, so the group reads as one of the card's bookings;
  // its rows (depth + 2) then start 12 px right of the badge.
  const paddingLeft = depth * 16 + 28;
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
        <Icon icon={ChevronRightIcon} size={12} className={`${styles.chevron} ${collapsed ? '' : styles.chevronOpen}`} />
      </button>
      <CardBadge
        phaseType={phaseType}
        phaseColor={phaseColor}
        level={level}
        onNameClick={() => {
          if (firstStart) useUIStore.getState().triggerScrollToDate(toDateOnly(firstStart));
        }}
        nameTitle={`Scroll to ${name}'s first booking`}
      />
      <span className={styles.name} title={name}>
        {name}
      </span>
      <span className={styles.count}>{count} bookings</span>
      <span className={styles.allocation}>{allocationText}</span>
    </div>
  );
});
