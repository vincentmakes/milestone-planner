/**
 * The double-booking warning: a named image (the red Material warning
 * triangle), whose svg itself stays decorative.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverlapWarningIcon } from '../OverlapWarningIcon';

describe('OverlapWarningIcon', () => {
  it('is an image named by its default title', () => {
    render(<OverlapWarningIcon />);
    const img = screen.getByRole('img', { name: 'Booking conflict: overlapping reservations' });
    expect(img).toHaveAttribute('title', 'Booking conflict: overlapping reservations');
    const svg = img.querySelector('svg') as SVGElement;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('data-testid', 'WarningAmberOutlinedIcon');
    expect(svg.style.fontSize).toBe('14px');
  });

  it('takes a title, a size and an extra class', () => {
    render(<OverlapWarningIcon title="Blocked twice" size={12} className="extra" />);
    const img = screen.getByRole('img', { name: 'Blocked twice' });
    expect(img).toHaveClass('extra');
    expect(img.className.split(' ').length).toBe(2);
    expect((img.querySelector('svg') as SVGElement).style.fontSize).toBe('12px');
  });
});
