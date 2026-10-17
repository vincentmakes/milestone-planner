import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LoadingScreen } from '../LoadingScreen';
import { LoadErrorScreen } from '../LoadErrorScreen';

describe('LoadingScreen', () => {
  it('shows the default message', () => {
    render(<LoadingScreen />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows a custom message', () => {
    render(<LoadingScreen message="Loading projects..." />);
    expect(screen.getByText('Loading projects...')).toBeInTheDocument();
  });
});

describe('LoadErrorScreen', () => {
  it('explains the failure and retries on click', async () => {
    const onRetry = vi.fn();
    render(<LoadErrorScreen message="HTTP 500" onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The workspace could not be loaded.');
    expect(alert).toHaveTextContent('HTTP 500');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
