import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { DateField } from '../DateField';
import type { DateFieldProps } from '../DateField';
import { useAppStore } from '@/stores/appStore';
import { formatMediumDate } from '@/utils/date';
import { datePanel, dateValue, dayButton, pickDate } from '@/test/datePicker';

function Harness({
  initial = '2026-03-10',
  spy = vi.fn(),
  ...props
}: Partial<DateFieldProps> & { initial?: string; spy?: (next: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <DateField
      value={value}
      onChange={(next) => {
        spy(next);
        setValue(next);
      }}
      label="Due date"
      {...props}
    />
  );
}

const field = () => screen.getByRole('combobox', { name: 'Due date' });
const queryPanel = () => screen.queryByRole('dialog', { name: 'Choose a date' });

beforeEach(() => {
  useAppStore.setState({ bankHolidays: [], bankHolidayDates: new Set(), closureIndex: new Map() });
});

describe('DateField', () => {
  it('renders a read-only combobox showing the date, with the ISO value in data-value', () => {
    render(<Harness fullWidth />);
    expect(field()).toHaveAttribute('readonly');
    expect(field()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(field()).toHaveAttribute('aria-expanded', 'false');
    expect(field()).toHaveValue(formatMediumDate('2026-03-10'));
    expect(dateValue('Due date')).toBe('2026-03-10');
  });

  it('shows a placeholder when empty', () => {
    const { unmount } = render(<Harness initial="" />);
    expect(field()).toHaveAttribute('placeholder', 'Pick a date');
    unmount();
    render(<Harness initial="" placeholder="No due date" />);
    expect(field()).toHaveAttribute('placeholder', 'No due date');
  });

  it('selects a day with one click, closes and returns focus to the field', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.click(field());
    const panel = datePanel();
    expect(field()).toHaveAttribute('aria-expanded', 'true');
    expect(field()).toHaveAttribute('aria-controls', panel.id);
    expect(dayButton(panel, '2026-03-10').closest('td')).toHaveAttribute('aria-selected', 'true');
    expect(within(panel).queryByText('Now pick the end date')).not.toBeInTheDocument();

    fireEvent.click(dayButton(panel, '2026-03-18'));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('2026-03-18');
    expect(queryPanel()).not.toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(dateValue('Due date')).toBe('2026-03-18');
  });

  it('works with the pickDate helper across years', () => {
    render(<Harness />);
    pickDate('Due date', '2028-11-02');
    expect(dateValue('Due date')).toBe('2028-11-02');
  });

  it.each(['Enter', ' ', 'ArrowDown'])('opens on %j without submitting the form', (key) => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness />
      </form>
    );
    expect(fireEvent.keyDown(field(), { key })).toBe(false);
    expect(datePanel()).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('focuses the selected day on a keyboard open', () => {
    render(<Harness />);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(dayButton(datePanel(), '2026-03-10')).toHaveFocus();
  });

  it('moves focus into the calendar on Enter after a mouse open', () => {
    render(<Harness />);
    fireEvent.click(field());
    expect(datePanel()).toBeInTheDocument();
    expect(dayButton(datePanel(), '2026-03-10')).not.toHaveFocus();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(datePanel()).toBeInTheDocument();
    expect(dayButton(datePanel(), '2026-03-10')).toHaveFocus();
  });

  it('focuses the calendar’s focus target on a keyboard open without a value', () => {
    render(<Harness initial="" />);
    fireEvent.keyDown(field(), { key: 'Enter' });
    const focused = document.activeElement as HTMLElement;
    expect(datePanel()).toContainElement(focused);
    expect(focused.closest('td')).toHaveAttribute('data-day');
  });

  it('Escape closes the panel and refocuses the field', () => {
    render(<Harness />);
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(queryPanel()).not.toBeInTheDocument();
    expect(field()).toHaveFocus();
  });

  it('closes on an outside mousedown', () => {
    render(
      <>
        <Harness />
        <p>outside</p>
      </>
    );
    fireEvent.click(field());
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(queryPanel()).not.toBeInTheDocument();
  });

  it('clears an optional date with the footer button or Backspace', () => {
    const spy = vi.fn();
    render(<Harness clearable spy={spy} />);
    fireEvent.click(field());
    fireEvent.click(screen.getByRole('button', { name: 'Clear date' }));
    expect(spy).toHaveBeenCalledWith('');
    expect(queryPanel()).not.toBeInTheDocument();
    expect(field()).toHaveFocus();

    fireEvent.click(field());
    expect(screen.getByRole('button', { name: 'Clear date' })).toBeDisabled();
  });

  it('clears with Backspace only when clearable', () => {
    const spy = vi.fn();
    const { unmount } = render(<Harness spy={spy} />);
    fireEvent.keyDown(field(), { key: 'Backspace' });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(field());
    expect(screen.queryByRole('button', { name: 'Clear date' })).not.toBeInTheDocument();
    unmount();

    render(<Harness clearable spy={spy} />);
    fireEvent.keyDown(field(), { key: 'Backspace' });
    expect(spy).toHaveBeenCalledWith('');
  });

  it('does not open while disabled', () => {
    render(<Harness disabled />);
    fireEvent.click(field());
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(queryPanel()).not.toBeInTheDocument();
  });

  it('marks the site calendar unless told not to', () => {
    useAppStore.setState({
      bankHolidays: [{ id: 1, site_id: 1, date: '2026-03-19', end_date: '2026-03-20', name: 'Spring break', is_custom: true }],
      bankHolidayDates: new Set(['2026-03-19', '2026-03-20']),
    });
    const { unmount } = render(<Harness />);
    fireEvent.click(field());
    expect(dayButton(datePanel(), '2026-03-20')).toHaveAttribute('title', 'Bank holiday: Spring break');
    unmount();

    render(<Harness markSiteCalendar={false} />);
    fireEvent.click(field());
    expect(dayButton(datePanel(), '2026-03-20')).not.toHaveAttribute('title');
  });
});
