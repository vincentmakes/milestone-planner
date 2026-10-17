import { describe, it, expect, afterEach } from 'vitest';
import { getAllLevelColors, getDepthColor, getLevelBarTextColor, getPhaseColor } from '../themeColors';

const root = document.documentElement;

describe('themeColors', () => {
  afterEach(() => {
    root.style.cssText = '';
  });

  it('falls back to the default palette when no CSS variables are set', () => {
    expect(getPhaseColor()).toBe('#FF50A8');
    expect(getDepthColor(1)).toBe('#05B6D4');
    expect(getDepthColor(10)).toBe('#F43F5E');
    expect(getLevelBarTextColor()).toBe('#ffffff');
  });

  it('clamps the depth to 1..10', () => {
    expect(getDepthColor(0)).toBe(getDepthColor(1));
    expect(getDepthColor(-5)).toBe('#05B6D4');
    expect(getDepthColor(42)).toBe('#F43F5E');
  });

  it('reads the theme CSS variables when present', () => {
    root.style.setProperty('--level-phase', '#111111');
    root.style.setProperty('--level-3', ' #333333 ');
    root.style.setProperty('--level-bar-text', '#000000');
    expect(getPhaseColor()).toBe('#111111');
    expect(getDepthColor(3)).toBe('#333333');
    expect(getDepthColor(2)).toBe('#8B5CF6');
    expect(getLevelBarTextColor()).toBe('#000000');
  });

  it('builds the full level map 0..10', () => {
    root.style.setProperty('--level-5', '#555555');
    const colors = getAllLevelColors();
    expect(Object.keys(colors).map(Number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(colors[0]).toBe('#FF50A8');
    expect(colors[5]).toBe('#555555');
  });
});
