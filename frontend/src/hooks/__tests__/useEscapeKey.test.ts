/**
 * useEscapeKey: Escape closes standalone dialogs while they are active.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEscapeKey } from '../useEscapeKey';
import { useConfirmStore } from '@/stores/confirmStore';

describe('useEscapeKey', () => {
  it('calls the handler on Escape only while active', () => {
    const onEscape = vi.fn();
    const { rerender } = renderHook(({ active }) => useEscapeKey(onEscape, active), {
      initialProps: { active: true },
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onEscape).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onEscape).toHaveBeenCalledTimes(1);

    rerender({ active: false });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while an in-app confirmation is pending', () => {
    const onEscape = vi.fn();
    renderHook(() => useEscapeKey(onEscape));
    const resolve = vi.fn();
    let id = 0;
    act(() => {
      id = useConfirmStore.getState().enqueue({ message: 'Delete?' }, resolve);
    });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onEscape).not.toHaveBeenCalled();

    act(() => useConfirmStore.getState().settle(id, false));
    expect(resolve).toHaveBeenCalledWith(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});
