/**
 * The card badge of a phase / subphase booking row in the project tree: the
 * card's name tinted with its colour. Shared by AssignmentRow (where it also
 * carries the pin) and StaffGroupRow (without the pin), together with
 * AssignmentRow.module.css's `typeBadge` class, so the two cannot drift.
 */

import type { CSSProperties } from 'react';

/** Background and text colour of the badge for a card colour. */
export function cardBadgeStyle(phaseColor?: string): CSSProperties {
  return {
    backgroundColor: phaseColor ? `${phaseColor}33` : 'rgba(139, 92, 246, 0.2)',
    color: phaseColor || 'var(--accent-purple)',
  };
}

/** The badge text: the card's name, or its kind when it has none. */
export function cardBadgeName(phaseType: string | undefined, level: 'phase' | 'subphase'): string {
  return phaseType || (level === 'subphase' ? 'Subphase' : 'Phase');
}
