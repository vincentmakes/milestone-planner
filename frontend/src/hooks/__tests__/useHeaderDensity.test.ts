/**
 * The header's breakpoints live in this hook and nowhere else, so these are
 * the tests that pin them. jsdom does not implement matchMedia, hence the stub.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHeaderDensity } from '../useHeaderDensity';

type Listener = () => void;
let listeners: Listener[] = [];
let currentWidth = 1920;

/** A matchMedia that parses `(min-width: Npx)` against a settable width. */
function stubMatchMedia(width: number) {
  currentWidth = width;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
      return {
        get matches() {
          return currentWidth >= min;
        },
        media: query,
        addEventListener: (_: string, fn: Listener) => {
          listeners.push(fn);
        },
        removeEventListener: (_: string, fn: Listener) => {
          listeners = listeners.filter((l) => l !== fn);
        },
      };
    },
  });
}

afterEach(() => {
  listeners = [];
  // @ts-expect-error -- restore jsdom's (absent) matchMedia
  delete window.matchMedia;
});

describe('useHeaderDensity', () => {
  it.each([
    [1920, 'full'],
    [1600, 'full'],
    [1599, 'compact'],
    [1440, 'compact'],
    [1280, 'compact'],
    [1279, 'condensed'],
    [1100, 'condensed'],
    [1024, 'condensed'],
    [1023, 'minimal'],
    [768, 'minimal'],
    [375, 'minimal'],
  ])('%i px -> %s', (width, expected) => {
    stubMatchMedia(width);
    const { result } = renderHook(() => useHeaderDensity());
    expect(result.current).toBe(expected);
  });

  it('assumes the roomy layout when matchMedia is unavailable', () => {
    // Guards the jsdom fallback. Without it every test that renders the header
    // throws — and a browser lacking matchMedia would silently hide controls
    // rather than show them all.
    expect(window.matchMedia).toBeUndefined();
    const { result } = renderHook(() => useHeaderDensity());
    expect(result.current).toBe('full');
  });

  it('re-resolves when the window crosses a breakpoint', () => {
    stubMatchMedia(1920);
    const { result } = renderHook(() => useHeaderDensity());
    expect(result.current).toBe('full');

    act(() => {
      currentWidth = 768;
      listeners.forEach((fn) => fn());
    });
    expect(result.current).toBe('minimal');
  });

  it('lands on the right tier when two boundaries are crossed at once', () => {
    // Re-reading every query rather than trusting the one that fired is what
    // makes a 1920 -> 1100 jump resolve to condensed and not compact.
    stubMatchMedia(1920);
    const { result } = renderHook(() => useHeaderDensity());

    act(() => {
      currentWidth = 1100;
      listeners.forEach((fn) => fn());
    });
    expect(result.current).toBe('condensed');
  });

  it('detaches its listeners on unmount', () => {
    stubMatchMedia(1440);
    const { unmount } = renderHook(() => useHeaderDensity());
    expect(listeners).toHaveLength(3);
    unmount();
    expect(listeners).toHaveLength(0);
  });
});
