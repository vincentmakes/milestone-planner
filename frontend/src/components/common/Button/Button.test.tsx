import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';
import styles from './Button.module.css';

const Svg = () => <svg data-testid="svg" aria-hidden="true" />;

describe('Button', () => {
  it('defaults to a primary md button', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn).toHaveClass(styles.button, styles.primary, styles.md);
  });

  it.each([
    ['secondary', 'secondary'],
    ['danger', 'danger'],
    ['ghost', 'ghost'],
  ] as const)('maps variant %s to its class', (variant, cls) => {
    render(<Button variant={variant}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass(styles[cls]);
  });

  it.each(['sm', 'md', 'lg'] as const)('maps size %s to its class', (size) => {
    render(<Button size={size}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass(styles[size]);
  });

  it('wraps the icon prop in the icon slot, not in the icon-only box', () => {
    render(<Button icon={<Svg />}>Add holiday</Button>);
    const btn = screen.getByRole('button', { name: 'Add holiday' });
    const slot = screen.getByTestId('svg').parentElement!;
    expect(slot).toHaveClass(styles.iconSlot);
    // The wrapper must never pick up the icon-only variant's 36 px box
    expect(slot).not.toHaveClass(styles.iconOnly);
    expect(styles.iconSlot).not.toBe(styles.iconOnly);
    // The icon sits before the label inside the button
    expect(btn.firstElementChild).toBe(slot);
    expect(btn).not.toHaveClass(styles.iconOnly);
  });

  it('places the icon after the label with iconPosition="right"', () => {
    render(
      <Button icon={<Svg />} iconPosition="right">
        Next
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Next' });
    expect(btn.lastElementChild).toBe(screen.getByTestId('svg').parentElement);
  });

  it('uses the iconOnly class for the icon variant', () => {
    render(<Button variant="icon" aria-label="Close" icon={<Svg />} />);
    const btn = screen.getByRole('button', { name: 'Close' });
    expect(btn).toHaveClass(styles.iconOnly);
    expect(screen.getByTestId('svg').parentElement).toHaveClass(styles.iconSlot);
  });

  it('is disabled and does not fire onClick when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Delete
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveClass(styles.disabled);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows a spinner, hides the icon and disables the button while loading', () => {
    const { container } = render(
      <Button loading icon={<Svg />}>
        Saving
      </Button>
    );
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveClass(styles.loading);
    expect(screen.queryByTestId('svg')).not.toBeInTheDocument();
    expect(container.querySelector(`.${styles.spinner}`)).not.toBeNull();
  });

  it('passes type and other button attributes through', () => {
    render(
      <Button type="submit" title="Create it" aria-pressed="true">
        Create
      </Button>
    );
    const btn = screen.getByRole('button', { name: 'Create' });
    expect(btn).toHaveAttribute('type', 'submit');
    expect(btn).toHaveAttribute('title', 'Create it');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });
});
