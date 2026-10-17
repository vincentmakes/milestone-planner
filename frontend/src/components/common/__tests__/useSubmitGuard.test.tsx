/**
 * useSubmitGuard keeps one write in flight per dialog. The flag lives in a
 * ref, so a second call in the same tick (Enter pressed twice before React
 * re-renders) is refused, not only calls after the next render.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSubmitGuard } from '../useSubmitGuard';

describe('useSubmitGuard', () => {
  it('refuses a second begin() until end(), even within one tick', () => {
    const { result } = renderHook(() => useSubmitGuard());

    let first = false;
    let second = true;
    act(() => {
      first = result.current.begin();
      second = result.current.begin();
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(result.current.isSubmitting).toBe(true);

    act(() => result.current.end());
    expect(result.current.isSubmitting).toBe(false);
    let third = false;
    act(() => {
      third = result.current.begin();
    });
    expect(third).toBe(true);
  });

  it('guard() runs the task once and releases the guard when it fails', async () => {
    const { result } = renderHook(() => useSubmitGuard());
    let calls = 0;
    let release!: () => void;
    const task = () =>
      new Promise<string>((resolve) => {
        calls += 1;
        release = () => resolve('done');
      });

    let firstRun!: Promise<string | undefined>;
    let secondRun!: Promise<string | undefined>;
    act(() => {
      firstRun = result.current.guard(task);
      secondRun = result.current.guard(task);
    });
    expect(calls).toBe(1);
    await expect(secondRun).resolves.toBeUndefined();

    await act(async () => release());
    await expect(firstRun).resolves.toBe('done');
    expect(result.current.isSubmitting).toBe(false);

    await act(async () => {
      await expect(result.current.guard(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    });
    expect(result.current.isSubmitting).toBe(false);
  });
});
