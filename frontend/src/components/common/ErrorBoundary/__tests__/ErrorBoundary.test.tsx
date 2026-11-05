/**
 * ErrorBoundary: a child that throws while rendering is replaced by the
 * message and Retry (or a custom fallback); Retry remounts the children;
 * the error is logged, never shown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Suspense, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary, ERROR_BOUNDARY_MESSAGE } from '../ErrorBoundary';
import { retryableLazy } from '../retryableLazy';

const state = { fail: true, mounts: 0 };

function Flaky() {
  if (state.fail) throw new Error('secret internals');
  return <p>Rendered</p>;
}

function CountsMounts() {
  state.mounts += 1;
  return <p>Mount {state.mounts}</p>;
}

let error: ReturnType<typeof vi.spyOn>;
// React reports a render error to window 'error' too (dev build); jsdom
// would print it. The boundary is what is under test.
const silence = (e: ErrorEvent) => e.preventDefault();

beforeEach(() => {
  state.fail = true;
  state.mounts = 0;
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  window.addEventListener('error', silence);
});

afterEach(() => {
  error.mockRestore();
  window.removeEventListener('error', silence);
});

describe('ErrorBoundary', () => {
  it('renders its children while nothing fails', () => {
    state.fail = false;
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );
    expect(screen.getByText('Rendered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the message and Retry instead of a child that throws, and logs the error', () => {
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toHaveTextContent(ERROR_BOUNDARY_MESSAGE);
    expect(ERROR_BOUNDARY_MESSAGE).toBe('This view could not be shown.');
    expect(screen.queryByText(/secret internals/)).not.toBeInTheDocument();
    expect(error).toHaveBeenCalledWith(
      '[ErrorBoundary] A view failed to render',
      expect.objectContaining({ message: 'secret internals' }),
      expect.anything()
    );
  });

  it('remounts the children on Retry', () => {
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );
    state.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('Rendered')).toBeInTheDocument();
  });

  it('fails again on Retry while the child still throws', () => {
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('alert')).toHaveTextContent(ERROR_BOUNDARY_MESSAGE);
  });

  it('renders a custom fallback with the retry function', () => {
    render(
      <ErrorBoundary
        fallback={(retry) => (
          <button type="button" onClick={retry}>
            Try that again
          </button>
        )}
      >
        <Flaky />
      </ErrorBoundary>
    );
    state.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try that again' }));
    expect(screen.getByText('Rendered')).toBeInTheDocument();
  });

  it('gives Retry a fresh mount, not the old instance', () => {
    let throwNow = true;
    function Sometimes() {
      if (throwNow) throw new Error('once');
      return <CountsMounts />;
    }
    render(
      <ErrorBoundary>
        <Sometimes />
      </ErrorBoundary>
    );
    throwNow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('Mount 1')).toBeInTheDocument();
  });
});

describe('retryableLazy', () => {
  const Loaded = () => <p>Chunk loaded</p>;

  function mountUnderBoundary(getView: ReturnType<typeof retryableLazy>) {
    function LazyView() {
      const [View] = useState(getView);
      return (
        <Suspense fallback={<p>Loading</p>}>
          <View />
        </Suspense>
      );
    }
    return render(
      <ErrorBoundary>
        <LazyView />
      </ErrorBoundary>
    );
  }

  it('lets Retry recover a chunk that failed to load once', async () => {
    const load = vi
      .fn<() => Promise<{ default: typeof Loaded }>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValue({ default: Loaded });
    mountUnderBoundary(retryableLazy(load));
    expect(await screen.findByText(ERROR_BOUNDARY_MESSAGE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Chunk loaded')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('hands out the same lazy component while its import has not failed', async () => {
    const load = vi.fn(async () => ({ default: Loaded }));
    const getView = retryableLazy(load);
    expect(getView()).toBe(getView());
    const { unmount } = mountUnderBoundary(getView);
    expect(await screen.findByText('Chunk loaded')).toBeInTheDocument();
    unmount();
    // Mounted again: no new import, and no Suspense fallback.
    mountUnderBoundary(getView);
    expect(screen.getByText('Chunk loaded')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
