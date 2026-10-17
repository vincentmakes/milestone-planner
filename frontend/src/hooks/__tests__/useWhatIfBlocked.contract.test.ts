/**
 * Contract of useWhatIfBlocked (shared with the modal package, R-6):
 * `blocked` follows whatIfStore.whatIfMode and `reason()` uses the standard
 * whatIfUnavailableMessage wording.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWhatIfBlocked } from '../useWhatIfBlocked';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { whatIfUnavailableMessage } from '@/utils/whatIf';

describe('useWhatIfBlocked', () => {
  beforeEach(() => {
    useWhatIfStore.getState().reset();
  });

  it('is not blocked outside What-If', () => {
    const { result } = renderHook(() => useWhatIfBlocked());
    expect(result.current.blocked).toBe(false);
  });

  it('blocks while What-If is active and explains why', () => {
    const { result } = renderHook(() => useWhatIfBlocked());
    act(() => useWhatIfStore.getState().enterWhatIfMode([]));

    expect(result.current.blocked).toBe(true);
    expect(result.current.reason('Adding absences')).toBe(whatIfUnavailableMessage('Adding absences'));
    expect(result.current.reason('Adding absences')).toContain('Apply or discard');

    act(() => useWhatIfStore.getState().reset());
    expect(result.current.blocked).toBe(false);
  });
});
