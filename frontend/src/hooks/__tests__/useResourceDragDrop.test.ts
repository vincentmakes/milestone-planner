/**
 * useResourceDragDrop is the drag *source* only. The drop (assignment create,
 * What-If gate, per-target permission) lives in ResourceDropOverlay; an
 * ungated create path here once sat exported but unused (N-6) and would have
 * bypassed those checks for any future caller.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useResourceDragDrop } from '../useResourceDragDrop';

describe('useResourceDragDrop', () => {
  it('exposes no drop / create path', () => {
    const { result } = renderHook(() => useResourceDragDrop());
    expect(result.current).not.toHaveProperty('handleDrop');
    expect(result.current).not.toHaveProperty('DEFAULT_DURATION_DAYS');
    expect(typeof result.current.handleDragStart).toBe('function');
    expect(typeof result.current.handleDragEnd).toBe('function');
  });
});
