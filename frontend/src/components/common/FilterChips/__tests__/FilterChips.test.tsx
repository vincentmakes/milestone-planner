import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FilterChips } from '../FilterChips';

const OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'success', label: 'Success' },
  { value: 'failure', label: 'Failure' },
] as const;

describe('FilterChips', () => {
  it('is a named group whose chosen chip is pressed', () => {
    render(<FilterChips label="Outcome" options={OPTIONS} value="success" onChange={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Outcome' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['All', 'Success', 'Failure']);
    expect(within(group).getByRole('button', { name: 'Success' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the clicked value', () => {
    const onChange = vi.fn();
    render(<FilterChips label="Outcome" options={OPTIONS} value="all" onChange={onChange} className="extra" />);
    fireEvent.click(screen.getByRole('button', { name: 'Failure' }));
    expect(onChange).toHaveBeenCalledWith('failure');
    expect(screen.getByRole('group', { name: 'Outcome' }).className).toContain('extra');
  });
});
