/**
 * useScrollSync: vertical scroll position mirrored between the tree panel
 * and the timeline body, without echo loops.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScrollSync } from '../useScrollSync';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe('useScrollSync', () => {
  it('mirrors scrollTop both ways', async () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    renderHook(() => useScrollSync({ current: a }, { current: b }));

    a.scrollTop = 120;
    a.dispatchEvent(new Event('scroll'));
    expect(b.scrollTop).toBe(120);
    // the echo scroll on b is swallowed while syncing
    b.scrollTop = 5;
    b.dispatchEvent(new Event('scroll'));
    expect(a.scrollTop).toBe(120);

    await nextFrame();
    b.scrollTop = 40;
    b.dispatchEvent(new Event('scroll'));
    expect(a.scrollTop).toBe(40);
  });

  it('does nothing without both elements and detaches on unmount', () => {
    const a = document.createElement('div');
    const { unmount } = renderHook(() => useScrollSync({ current: a }, { current: null }));
    a.scrollTop = 10;
    a.dispatchEvent(new Event('scroll'));
    unmount();

    const b = document.createElement('div');
    const c = document.createElement('div');
    const second = renderHook(() => useScrollSync({ current: b }, { current: c }));
    second.unmount();
    b.scrollTop = 33;
    b.dispatchEvent(new Event('scroll'));
    expect(c.scrollTop).toBe(0);
  });
});
