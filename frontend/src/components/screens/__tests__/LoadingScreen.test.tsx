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

  it('fills a view slot without the logo when compact', () => {
    const { rerender } = render(<LoadingScreen />);
    expect(screen.getByRole('img', { name: 'Milestone' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<LoadingScreen compact message="Loading dashboards…" />);
    expect(screen.queryByRole('img', { name: 'Milestone' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading dashboards…');
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
