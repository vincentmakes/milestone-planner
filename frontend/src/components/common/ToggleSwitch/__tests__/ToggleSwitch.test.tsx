import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToggleSwitch } from '../ToggleSwitch';

describe('ToggleSwitch', () => {
  it('exposes a switch that reflects the checked state', () => {
    const { rerender } = render(<ToggleSwitch checked={false} onChange={() => {}} label="Active" />);
    const control = screen.getByRole('switch', { name: 'Active' });
    expect(control).not.toBeChecked();

    rerender(<ToggleSwitch checked onChange={() => {}} label="Active" />);
    expect(screen.getByRole('switch', { name: 'Active' })).toBeChecked();
  });

  it('reports the new value when clicked, via the control or its label', () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} onChange={onChange} label="Counts as unavailable" />);

    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByText('Counts as unavailable'));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('disables the underlying control', () => {
    // jsdom still dispatches synthetic clicks on disabled inputs, so the
    // meaningful check is the disabled state the browser honours.
    render(<ToggleSwitch checked={false} onChange={() => {}} label="Enable SSO" disabled />);
    expect(screen.getByRole('switch', { name: 'Enable SSO' })).toBeDisabled();
  });

  it('can be named with aria-label when it has no visible text', () => {
    render(<ToggleSwitch checked onChange={() => {}} aria-label="Show weekends" />);
    expect(screen.getByRole('switch', { name: 'Show weekends' })).toBeChecked();
  });
});
