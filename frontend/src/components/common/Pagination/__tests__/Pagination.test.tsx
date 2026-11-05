import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Pagination } from '../Pagination';

const button = (name: string) => screen.getByRole('button', { name });

describe('Pagination', () => {
  it('is a named nav with the four labelled buttons around the page text', () => {
    render(<Pagination page={2} pageCount={5} onPageChange={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'Pagination' });
    expect(within(nav).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'First page',
      'Previous page',
      'Next page',
      'Last page',
    ]);
    expect(nav).toHaveTextContent('Page 2 of 5');
  });

  it('disables First and Previous on the first page, Next and Last on the last', () => {
    const { rerender } = render(<Pagination page={1} pageCount={3} onPageChange={vi.fn()} />);
    expect(button('First page')).toBeDisabled();
    expect(button('Previous page')).toBeDisabled();
    expect(button('Next page')).toBeEnabled();
    expect(button('Last page')).toBeEnabled();

    rerender(<Pagination page={3} pageCount={3} onPageChange={vi.fn()} />);
    expect(button('First page')).toBeEnabled();
    expect(button('Previous page')).toBeEnabled();
    expect(button('Next page')).toBeDisabled();
    expect(button('Last page')).toBeDisabled();
  });

  it('reports the target page of each button', () => {
    const onPageChange = vi.fn();
    render(<Pagination page={3} pageCount={7} onPageChange={onPageChange} />);
    fireEvent.click(button('First page'));
    fireEvent.click(button('Previous page'));
    fireEvent.click(button('Next page'));
    fireEvent.click(button('Last page'));
    expect(onPageChange.mock.calls.map(([page]) => page)).toEqual([1, 2, 4, 7]);
  });

  it('reads a single page for an empty list and clamps the page', () => {
    render(<Pagination page={4} pageCount={0} onPageChange={vi.fn()} />);
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toHaveTextContent('Page 1 of 1');
    for (const name of ['First page', 'Previous page', 'Next page', 'Last page']) {
      expect(button(name)).toBeDisabled();
    }
  });

  it('disables every button while disabled', () => {
    render(<Pagination page={2} pageCount={3} onPageChange={vi.fn()} disabled className="extra" />);
    for (const name of ['First page', 'Previous page', 'Next page', 'Last page']) {
      expect(button(name)).toBeDisabled();
    }
    expect(screen.getByRole('navigation', { name: 'Pagination' }).className).toContain('extra');
  });
});
