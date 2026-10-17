import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Notice } from '../Notice';

describe('Notice', () => {
  it('is an alert for errors and a status for every other tone, unless told otherwise', () => {
    const { rerender } = render(<Notice>Boom</Notice>);
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');

    for (const tone of ['warning', 'info', 'success'] as const) {
      rerender(<Notice tone={tone}>{tone}</Notice>);
      expect(screen.getByRole('status')).toHaveTextContent(tone);
    }

    rerender(
      <Notice tone="warning" role="alert">
        Urgent
      </Notice>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Urgent');
  });

  it('carries the tone as a class and passes className and style through', () => {
    render(
      <Notice tone="info" className="extra" style={{ marginBottom: 4 }}>
        Hi
      </Notice>
    );
    const el = screen.getByRole('status');
    expect(el.className).toMatch(/info/);
    expect(el.className).toMatch(/extra/);
    expect(el.style.marginBottom).toBe('4px');
  });

  it('offers a labelled dismiss button only when onDismiss is given', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Notice>Boom</Notice>);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();

    rerender(<Notice onDismiss={onDismiss}>Boom</Notice>);
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
