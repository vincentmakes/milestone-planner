/**
 * Copying generated tenant credentials to the clipboard (closing behaviour is
 * covered by CredentialsModal.test.tsx).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CredentialsModal } from '../CredentialsModal';

function renderModal() {
  render(<CredentialsModal title="Password Reset!" email="admin@demo.local" password="S3cret!" onClose={vi.fn()} />);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CredentialsModal copy', () => {
  it('copies email and password, then resets the button label after 2 s', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderModal();
    expect(screen.getByDisplayValue('S3cret!')).toHaveAttribute('readonly');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Credentials' }));
    });
    expect(writeText).toHaveBeenCalledWith('Email: admin@demo.local\nPassword: S3cret!');
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('button', { name: 'Copy Credentials' })).toBeInTheDocument();
  });

  it('logs a clipboard failure and keeps the label', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Credentials' }));
    });
    expect(error).toHaveBeenCalledWith('Failed to copy:', expect.any(Error));
    expect(screen.getByRole('button', { name: 'Copy Credentials' })).toBeInTheDocument();
  });
});
