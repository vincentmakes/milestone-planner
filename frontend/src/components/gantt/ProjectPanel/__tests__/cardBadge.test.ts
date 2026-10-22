/**
 * The card badge shared by the booking rows and the overview row: the card's
 * colour as a 20 % tint with the colour as text (purple without a colour), and
 * the card's name (its kind without one).
 */
import { describe, it, expect } from 'vitest';
import { cardBadgeName, cardBadgeStyle } from '../cardBadge';

describe('cardBadge', () => {
  it('tints with the card colour, purple without one', () => {
    expect(cardBadgeStyle('#3b82f6')).toEqual({ backgroundColor: '#3b82f633', color: '#3b82f6' });
    expect(cardBadgeStyle()).toEqual({ backgroundColor: 'rgba(139, 92, 246, 0.2)', color: 'var(--accent-purple)' });
  });

  it("names the card, or its kind when it has no name", () => {
    expect(cardBadgeName('Analytics', 'phase')).toBe('Analytics');
    expect(cardBadgeName(undefined, 'phase')).toBe('Phase');
    expect(cardBadgeName('', 'subphase')).toBe('Subphase');
  });
});
