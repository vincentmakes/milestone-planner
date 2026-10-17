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
    vi.spyOn(window, 'confirm').mockReturnValue(true);
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
