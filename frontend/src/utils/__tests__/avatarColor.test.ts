import { describe, it, expect } from 'vitest';
import { AVATAR_COLORS, avatarColorFor } from '../avatarColor';

describe('avatarColorFor', () => {
  it('cycles through the eight palette colours by id', () => {
    expect(AVATAR_COLORS).toHaveLength(8);
    AVATAR_COLORS.forEach((color, i) => {
      expect(avatarColorFor(i)).toBe(color);
      expect(avatarColorFor(i + 8)).toBe(color);
      expect(avatarColorFor(i + 800)).toBe(color);
    });
  });

  it('is stable for the same id and tolerant of odd ids', () => {
    expect(avatarColorFor(42)).toBe(avatarColorFor(42));
    expect(avatarColorFor(-3)).toBe(AVATAR_COLORS[3]);
    expect(avatarColorFor(5.9)).toBe(AVATAR_COLORS[5]);
    expect(AVATAR_COLORS).toContain(avatarColorFor(Number.NaN));
  });
});
