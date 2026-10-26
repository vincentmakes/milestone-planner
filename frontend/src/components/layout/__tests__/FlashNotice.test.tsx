/**
 * FlashNotice shows `uiStore.flashNotice` bottom-right as an alert and clears
 * it after FLASH_DURATION_MS or on Dismiss; a newer flash is never cleared by
 * an older one's timer. The slot is an opaque surface, so the Notice's
 * translucent tint stays readable over the Staff heatmap in every theme.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { FlashNotice, FLASH_DURATION_MS } from '../FlashNotice';
import { useUIStore } from '@/stores/uiStore';

beforeEach(() => {
  vi.useFakeTimers();
  useUIStore.setState({ flashNotice: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FlashNotice', () => {
  it('renders nothing until a flash is shown, then an alert in the chosen tone', () => {
    render(<FlashNotice />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    act(() => useUIStore.getState().showFlash('Could not delete the phase', 'warning'));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not delete the phase');
    expect(alert.className).toMatch(/warning/);
  });

  it('clears itself after the duration, and at once on Dismiss', () => {
    render(<FlashNotice />);
    act(() => useUIStore.getState().showFlash('Boom'));
    act(() => vi.advanceTimersByTime(FLASH_DURATION_MS - 1));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(useUIStore.getState().flashNotice).toBeNull();

    act(() => useUIStore.getState().showFlash('Again'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a newer flash when the older timer would have fired', () => {
    render(<FlashNotice />);
    act(() => useUIStore.getState().showFlash('First'));
    act(() => vi.advanceTimersByTime(FLASH_DURATION_MS - 100));
    act(() => useUIStore.getState().showFlash('Second'));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('alert')).toHaveTextContent('Second');

    // dismissFlash with a stale id is a no-op
    act(() => useUIStore.getState().dismissFlash(-1));
    expect(screen.getByRole('alert')).toHaveTextContent('Second');
  });

  it('defaults to the error tone and is reset with the store', () => {
    useUIStore.getState().showFlash('Oops');
    expect(useUIStore.getState().flashNotice).toMatchObject({ message: 'Oops', tone: 'error' });
    useUIStore.getState().dismissFlash();
    expect(useUIStore.getState().flashNotice).toBeNull();
  });

  it('sits in the opaque slot', () => {
    render(<FlashNotice />);
    act(() => useUIStore.getState().showFlash('This person is already booked on this card for overlapping dates'));
    expect(screen.getByRole('alert').parentElement?.className).toMatch(/slot/);
    // Under Vitest a .module.css import is a stub: read the rule itself.
    const css = readFileSync(join(__dirname, '..', 'FlashNotice.module.css'), 'utf8');
    const slot = css.match(/\.slot\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(slot).toMatch(/background:\s*var\(--bg-secondary\);/);
  });
});
