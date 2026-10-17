/**
 * R-4: a failed What-If Apply is shown in the header (not only a one-off
 * alert), with Retry (apply the remaining operations again) and Discard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, apiRequest: vi.fn() };
});
vi.mock('@/api/endpoints/projects', () => ({ fetchAllProjects: vi.fn(async () => []) }));

import { WhatIfToggle } from '../WhatIfToggle';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { apiRequest, clientConfig } from '@/api/client';
import { stubConfirm } from '@/test/confirmDialog';

function queue(n: number) {
  for (let i = 1; i <= n; i++) {
    useWhatIfStore.getState().queueWhatIfOperation({ method: 'PUT', url: `/api/phases/${i}`, body: {} });
  }
}

describe('WhatIfToggle apply-failure banner', () => {
  beforeEach(() => {
    useWhatIfStore.getState().reset();
    clientConfig.isWhatIfMode = () => useWhatIfStore.getState().whatIfMode;
    vi.mocked(apiRequest).mockReset().mockResolvedValue({});
    stubConfirm(true);
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useWhatIfStore.getState().enterWhatIfMode([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows no banner while nothing failed', () => {
    queue(2);
    render(<WhatIfToggle />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the failure after Apply and retries the remaining operations', async () => {
    queue(3);
    vi.mocked(apiRequest).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('phase not found'));
    render(<WhatIfToggle />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('1 of 3 changes applied');
    expect(banner).toHaveTextContent('phase not found');
    expect(banner).toHaveTextContent('2 changes are still queued');
    expect(window.alert).not.toHaveBeenCalled();

    vi.mocked(apiRequest).mockClear().mockResolvedValue({});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(vi.mocked(apiRequest).mock.calls.map((c) => c[0])).toEqual(['/api/phases/2', '/api/phases/3']);
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Discard from the banner drops the remaining operations', async () => {
    queue(2);
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error('boom'));
    render(<WhatIfToggle />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    const discardButtons = screen.getAllByRole('button', { name: 'Discard' });
    await act(async () => {
      fireEvent.click(discardButtons[discardButtons.length - 1]);
    });

    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
    expect(useWhatIfStore.getState().whatIfPendingOperations).toEqual([]);
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('Dismiss hides the banner and keeps the queue', async () => {
    queue(2);
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error('boom'));
    render(<WhatIfToggle />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(useWhatIfStore.getState().whatIfPendingOperations).toHaveLength(2);
    expect(useWhatIfStore.getState().whatIfMode).toBe(true);
  });
});

describe('WhatIfToggle confirmations', () => {
  beforeEach(() => {
    useWhatIfStore.getState().reset();
    clientConfig.isWhatIfMode = () => useWhatIfStore.getState().whatIfMode;
    vi.mocked(apiRequest).mockReset().mockResolvedValue({});
    useWhatIfStore.getState().enterWhatIfMode([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the sandbox when the discard is cancelled', async () => {
    queue(2);
    const confirm = stubConfirm(false);
    render(<WhatIfToggle />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Discard 2 pending changes? This cannot be undone.',
        destructive: true,
      })
    );
    expect(useWhatIfStore.getState().whatIfMode).toBe(true);
    expect(useWhatIfStore.getState().whatIfPendingOperations).toHaveLength(2);
  });

  it('discards the queue once confirmed', async () => {
    queue(1);
    const confirm = stubConfirm(true);
    render(<WhatIfToggle />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Discard 1 pending change? This cannot be undone.' })
    );
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
    expect(useWhatIfStore.getState().whatIfPendingOperations).toEqual([]);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('asks to exit when nothing is queued', async () => {
    const confirm = stubConfirm(true);
    render(<WhatIfToggle />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Exit What If mode?' })
    );
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
  });

  it('Exit with nothing queued leaves without asking', async () => {
    const confirm = stubConfirm(true);
    render(<WhatIfToggle />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
  });

  it('applies nothing when the apply is cancelled', async () => {
    queue(2);
    const confirm = stubConfirm(false);
    render(<WhatIfToggle />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Apply 2 changes to the database?',
        confirmLabel: 'Apply',
      })
    );
    expect(apiRequest).not.toHaveBeenCalled();
    expect(useWhatIfStore.getState().whatIfMode).toBe(true);
    expect(useWhatIfStore.getState().whatIfPendingOperations).toHaveLength(2);
  });

  it('replays the queue once the apply is confirmed', async () => {
    queue(1);
    const confirm = stubConfirm(true);
    render(<WhatIfToggle />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Apply 1 change to the database?' })
    );
    expect(vi.mocked(apiRequest).mock.calls.map((c) => c[0])).toEqual(['/api/phases/1']);
    expect(useWhatIfStore.getState().whatIfMode).toBe(false);
  });
});
