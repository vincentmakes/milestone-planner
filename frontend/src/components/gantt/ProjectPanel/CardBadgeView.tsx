/**
 * CardBadge — the card badge of a phase / subphase booking row and of the
 * per-person overview row in the project tree (1.17.0): one rectangle (the
 * `cardBadge` class of AssignmentRow.module.css, tinted by `cardBadgeStyle`)
 * so it looks the same on every row, holding up to two controls:
 *
 *  - the pin (booking rows only): links / unlinks the booking — `PinIcon`
 *    while it follows the card, `PinOffIcon` while it has its own dates.
 *    On a row the user may not change, or a pending one, it stays in place
 *    as a disabled button (same box, muted), never swapped for a span;
 *  - the name: the card's name; a click scrolls the timeline to the booking.
 *
 * Both are real buttons (keyboard by default) that stop the click from
 * reaching the row; the row keeps its context menu on right-click. The class
 * names contain "Badge" so the global touch-size rule leaves them alone.
 */

import type { MouseEvent } from 'react';
import { Icon, PinIcon, PinOffIcon } from '@/components/common/Icon';
import { cardBadgeName, cardBadgeStyle } from './cardBadge';
import styles from './AssignmentRow.module.css';

export interface CardBadgePin {
  /** Follows the card's dates (true) or has its own dates (false) */
  linked: boolean;
  onToggle: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Shown but inert: the user may not change the booking, or it is pending */
  disabled: boolean;
  title: string;
  /** Accessible name of the toggle ("Own dates for <person>") */
  label: string;
}

interface CardBadgeProps {
  phaseType?: string;
  phaseColor?: string;
  level: 'phase' | 'subphase';
  pin?: CardBadgePin;
  onNameClick: () => void;
  nameTitle: string;
}

export function CardBadge({ phaseType, phaseColor, level, pin, onNameClick, nameTitle }: CardBadgeProps) {
  return (
    <span className={styles.cardBadge} style={cardBadgeStyle(phaseColor)}>
      {pin && (
        <button
          type="button"
          className={styles.cardBadgePin}
          aria-pressed={!pin.linked}
          aria-label={pin.label}
          title={pin.title}
          disabled={pin.disabled}
          onClick={(e) => {
            e.stopPropagation();
            pin.onToggle(e);
          }}
        >
          <Icon icon={pin.linked ? PinIcon : PinOffIcon} size={12} />
        </button>
      )}
      <button
        type="button"
        className={styles.cardBadgeName}
        title={nameTitle}
        onClick={(e) => {
          e.stopPropagation();
          onNameClick();
        }}
      >
        {cardBadgeName(phaseType, level)}
      </button>
    </span>
  );
}
