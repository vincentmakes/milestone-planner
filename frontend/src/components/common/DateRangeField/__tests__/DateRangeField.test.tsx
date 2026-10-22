import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { DateRangeField } from '../DateRangeField';
import type { DateRangeFieldProps } from '../DateRangeField';
import { Modal } from '../../Modal';
import { useAppStore } from '@/stores/appStore';
import { formatMediumDate } from '@/utils/date';
import { datePanel, dateValue, dayButton, openDateField, showMonth } from '@/test/datePicker';
import type { BankHoliday, CompanyEvent } from '@/types';

type Range = { start: string; end: string };

function Harness({
  initial = { start: '2026-03-10', end: '2026-03-12' },
  spy = vi.fn(),
  ...props
}: Partial<DateRangeFieldProps> & { initial?: Range; spy?: (next: Range) => void }) {
  const [range, setRange] = useState(initial);
  return (
    <DateRangeField
      start={range.start}
      end={range.end}
      onChange={(next) => {
        spy(next);
        setRange(next);
      }}
      startLabel="Start date"
      endLabel="End date"
      {...props}
    />
  );
}

const startField = () => screen.getByRole('combobox', { name: 'Start date' });
const endField = () => screen.getByRole('combobox', { name: 'End date' });
const queryPanel = () => screen.queryByRole('dialog', { name: 'Choose dates' });
const cell = (iso: string) => dayButton(datePanel(), iso).closest('td') as HTMLElement;

/** A controllable `(max-width: 640px)` media query (jsdom has no matchMedia). */
function stubPhoneQuery(matches: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches,
    media: '(max-width: 640px)',
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(() => list) });
  return (next: boolean) => {
    list.matches = next;
    listeners.forEach((listener) => listener());
  };
}

beforeEach(() => {
  useAppStore.setState({ bankHolidays: [], bankHolidayDates: new Set(), closureIndex: new Map() });
});

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
  vi.restoreAllMocks();
});

describe('DateRangeField — fields', () => {
  it('renders two read-only comboboxes showing the dates, with the ISO value in data-value', () => {
    render(<Harness />);
    for (const [field, iso] of [
      [startField(), '2026-03-10'],
      [endField(), '2026-03-12'],
    ] as const) {
      expect(field).toHaveAttribute('readonly');
      expect(field).toHaveAttribute('aria-haspopup', 'dialog');
      expect(field).toHaveAttribute('aria-expanded', 'false');
      expect(field).not.toHaveAttribute('aria-controls');
      expect(field).toHaveAttribute('data-value', iso);
      expect(field).toHaveValue(formatMediumDate(iso));
    }
  });

  it('shows the placeholder for an empty date', () => {
    render(<Harness initial={{ start: '', end: '' }} endPlaceholder="Same day" />);
    expect(startField()).toHaveValue('');
    expect(startField()).toHaveAttribute('placeholder', 'Pick a date');
    expect(endField()).toHaveAttribute('placeholder', 'Same day');
    expect(dateValue('End date')).toBe('');
  });

  it('points both fields at the open panel and marks the active one', () => {
    render(<Harness fieldClassName="gridItem" />);
    expect(startField().closest('.gridItem')).not.toBeNull();
    fireEvent.click(startField());

    const panel = datePanel();
    expect(startField()).toHaveAttribute('aria-expanded', 'true');
    expect(startField()).toHaveAttribute('aria-controls', panel.id);
    expect(endField()).toHaveAttribute('aria-controls', panel.id);
    expect(startField()).toHaveAttribute('data-active', 'true');
    expect(endField()).not.toHaveAttribute('data-active');
    // Two months, starting at the start's month
    expect(within(panel).getAllByRole('grid')).toHaveLength(2);
    expect(dayButton(panel, '2026-03-10')).toBeInTheDocument();
  });

  it('renders the separator between the fields', () => {
    render(<Harness separator={<span data-testid="arrow">→</span>} />);
    const arrow = screen.getByTestId('arrow');
    expect(startField().compareDocumentPosition(arrow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(arrow.compareDocumentPosition(endField()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not open while disabled', () => {
    render(<Harness disabled />);
    expect(startField()).toBeDisabled();
    fireEvent.click(startField());
    fireEvent.keyDown(endField(), { key: 'Enter' });
    expect(queryPanel()).not.toBeInTheDocument();
  });
});

describe('DateRangeField — picking', () => {
  it('sets the start, then the end, then closes with focus on the End field', () => {
    const spy = vi.fn();
    render(<Harness initial={{ start: '', end: '' }} spy={spy} />);
    const panel = openDateField('Start date');
    showMonth(panel, '2026-03-10');
    expect(within(panel).queryByText('Now pick the end date')).not.toBeInTheDocument();

    fireEvent.click(dayButton(panel, '2026-03-10'));
    expect(spy).toHaveBeenLastCalledWith({ start: '2026-03-10', end: '' });
    expect(endField()).toHaveAttribute('data-active', 'true');
    expect(within(datePanel()).getByText('Now pick the end date')).toHaveAttribute('role', 'status');

    fireEvent.click(dayButton(datePanel(), '2026-03-14'));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith({ start: '2026-03-10', end: '2026-03-14' });
    expect(queryPanel()).not.toBeInTheDocument();
    expect(endField()).toHaveFocus();
    expect(dateValue('Start date')).toBe('2026-03-10');
    expect(dateValue('End date')).toBe('2026-03-14');
  });

  it('moves the end with a start picked after it, keeping the duration', () => {
    const spy = vi.fn();
    render(<Harness initial={{ start: '2026-03-10', end: '2026-03-13' }} spy={spy} />);
    fireEvent.click(startField());
    fireEvent.click(dayButton(datePanel(), '2026-03-25'));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith({ start: '2026-03-25', end: '2026-03-28' });
    // The end is now awaited
    expect(endField()).toHaveAttribute('data-active', 'true');
  });

  it('makes an end picked before the start the new start and keeps waiting for the end', () => {
    const spy = vi.fn();
    render(<Harness initial={{ start: '2026-03-10', end: '2026-03-12' }} spy={spy} />);
    fireEvent.click(endField());
    fireEvent.click(dayButton(datePanel(), '2026-03-02'));
    expect(spy).toHaveBeenCalledWith({ start: '2026-03-02', end: '2026-03-04' });
    expect(datePanel()).toBeInTheDocument();
  });

  it('opens on the End field to change only the end', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.click(endField());
    expect(endField()).toHaveAttribute('data-active', 'true');
    fireEvent.click(dayButton(datePanel(), '2026-03-20'));
    expect(spy).toHaveBeenCalledWith({ start: '2026-03-10', end: '2026-03-20' });
    expect(queryPanel()).not.toBeInTheDocument();
  });

  it('previews the range under the hovered day without selecting it', () => {
    render(<Harness />);
    fireEvent.click(endField());
    fireEvent.mouseEnter(dayButton(datePanel(), '2026-03-16'));
    expect(cell('2026-03-14').className).toMatch(/preview/);
    expect(cell('2026-03-14')).not.toHaveAttribute('aria-selected');
    expect(cell('2026-03-20').className).not.toMatch(/preview/);

    fireEvent.mouseLeave(dayButton(datePanel(), '2026-03-16'));
    expect(cell('2026-03-14').className).not.toMatch(/preview/);
  });

  it('drops the preview on a click (a touch tap never sends mouseleave)', () => {
    render(<Harness />);
    fireEvent.click(startField());
    const day = dayButton(datePanel(), '2026-03-16');
    fireEvent.mouseEnter(day); // what a tap sends before the click
    expect(cell('2026-03-17').className).toMatch(/preview/);
    fireEvent.click(day);
    expect(datePanel()).toBeInTheDocument(); // the end is awaited now
    expect(datePanel().querySelectorAll('td[class*="preview"]')).toHaveLength(0);
  });

  it('highlights the range days', () => {
    render(<Harness />);
    fireEvent.click(startField());
    expect(cell('2026-03-11')).toHaveAttribute('aria-selected', 'true');
    expect(cell('2026-03-13')).not.toHaveAttribute('aria-selected');
  });

  it('highlights the given weekdays', () => {
    render(<Harness highlightWeekdays={[1, 3]} />);
    fireEvent.click(startField());
    expect(cell('2026-03-09').className).toMatch(/recurring/); // Monday
    expect(cell('2026-03-11').className).toMatch(/recurring/); // Wednesday
    expect(cell('2026-03-10').className).not.toMatch(/recurring/);
  });
});

describe('DateRangeField — optional end', () => {
  it('emits an end equal to the start as ""', () => {
    const spy = vi.fn();
    render(<Harness initial={{ start: '2026-03-10', end: '' }} endOptional spy={spy} />);
    fireEvent.click(endField());
    // An empty optional end reads as the start day
    expect(cell('2026-03-10')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(dayButton(datePanel(), '2026-03-10'));
    expect(spy).toHaveBeenCalledWith({ start: '2026-03-10', end: '' });
    expect(queryPanel()).not.toBeInTheDocument();
  });

  it('clears the end only, with the footer button or Backspace', () => {
    const spy = vi.fn();
    render(<Harness initial={{ start: '2026-03-10', end: '2026-03-12' }} endOptional spy={spy} />);
    fireEvent.click(startField());
    fireEvent.click(screen.getByRole('button', { name: 'Clear end date' }));
    expect(spy).toHaveBeenLastCalledWith({ start: '2026-03-10', end: '' });
    expect(queryPanel()).not.toBeInTheDocument();
    expect(endField()).toHaveFocus();

    // Nothing left to clear
    fireEvent.click(startField());
    expect(screen.getByRole('button', { name: 'Clear end date' })).toBeDisabled();
  });

  it('clears the end with Backspace on the End field, never the start', () => {
    const spy = vi.fn();
    render(<Harness initial={{ start: '2026-03-10', end: '2026-03-12' }} endOptional spy={spy} />);
    fireEvent.keyDown(startField(), { key: 'Backspace' });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.keyDown(endField(), { key: 'Backspace' });
    expect(spy).toHaveBeenCalledWith({ start: '2026-03-10', end: '' });
  });

  it('offers no Clear and ignores Backspace on a required range', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.keyDown(endField(), { key: 'Backspace' });
    fireEvent.click(startField());
    expect(screen.queryByRole('button', { name: /Clear/ })).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('DateRangeField — keyboard and dismissal', () => {
  it.each(['Enter', ' ', 'ArrowDown'])('opens on %j without submitting the form', (key) => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness />
      </form>
    );
    expect(fireEvent.keyDown(startField(), { key })).toBe(false); // default prevented
    expect(datePanel()).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('never opens on plain focus', () => {
    render(<Harness />);
    fireEvent.focus(startField());
    expect(queryPanel()).not.toBeInTheDocument();
  });

  it('puts focus on the active field’s day on a keyboard open, and the arrows move it', () => {
    render(<Harness />);
    fireEvent.keyDown(endField(), { key: 'Enter' });
    const day = dayButton(datePanel(), '2026-03-12');
    expect(day).toHaveFocus();
    fireEvent.keyDown(day, { key: 'ArrowRight' });
    expect(dayButton(datePanel(), '2026-03-13')).toHaveFocus();
  });

  it('moves focus to the End field’s day when End is activated from the keyboard while open', () => {
    render(<Harness />);
    fireEvent.keyDown(startField(), { key: 'Enter' });
    expect(dayButton(datePanel(), '2026-03-10')).toHaveFocus();

    endField().focus(); // Shift+Tab back out of the calendar onto End
    expect(datePanel()).toBeInTheDocument();
    fireEvent.keyDown(endField(), { key: 'ArrowDown' });
    expect(endField()).toHaveAttribute('data-active', 'true');
    expect(dayButton(datePanel(), '2026-03-12')).toHaveFocus();
  });

  it('leaves focus on the field on a mouse open, even after a keyboard open', () => {
    render(<Harness />);
    fireEvent.keyDown(startField(), { key: 'Enter' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    fireEvent.click(endField());
    expect(datePanel()).toBeInTheDocument();
    expect(startField()).toHaveFocus(); // Escape put it back there; the click moves nothing
  });

  it('leaves focus on the field on a mouse open', () => {
    render(<Harness />);
    startField().focus();
    fireEvent.click(startField());
    expect(startField()).toHaveFocus();
  });

  it('Escape closes the panel, refocuses the field and leaves the enclosing Modal open', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Edit phase">
        <Harness />
      </Modal>
    );
    fireEvent.keyDown(startField(), { key: 'Enter' });
    const day = dayButton(datePanel(), '2026-03-10');
    expect(day).toHaveFocus();
    // The panel lives inside the dialog, so the Modal's Tab trap and aria-modal cover it
    expect(screen.getByRole('dialog', { name: 'Edit phase' })).toContainElement(datePanel());

    fireEvent.keyDown(day, { key: 'Escape' });
    expect(queryPanel()).not.toBeInTheDocument();
    expect(startField()).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    // With the panel closed, Escape belongs to the Modal again
    fireEvent.keyDown(startField(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Escape returns focus to the End field once it is the active one', () => {
    render(<Harness />);
    fireEvent.click(startField());
    fireEvent.click(dayButton(datePanel(), '2026-03-05'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(queryPanel()).not.toBeInTheDocument();
    expect(endField()).toHaveFocus();
  });

  it('closes on Tab-out and on an outside mousedown', () => {
    render(
      <>
        <Harness />
        <button type="button">Outside</button>
      </>
    );
    const outside = screen.getByRole('button', { name: 'Outside' });

    fireEvent.click(startField());
    fireEvent.blur(startField(), { relatedTarget: outside });
    expect(queryPanel()).not.toBeInTheDocument();

    fireEvent.click(startField());
    fireEvent.mouseDown(outside);
    expect(queryPanel()).not.toBeInTheDocument();
  });

  it('stays open when focus moves into the panel or a mousedown hits the other field', () => {
    render(<Harness />);
    fireEvent.click(startField());
    fireEvent.blur(startField(), { relatedTarget: dayButton(datePanel(), '2026-03-10') });
    expect(datePanel()).toBeInTheDocument();

    fireEvent.mouseDown(endField());
    fireEvent.click(endField());
    expect(datePanel()).toBeInTheDocument();
    expect(endField()).toHaveAttribute('data-active', 'true');
  });
});

describe('DateRangeField — site calendar', () => {
  const holiday: BankHoliday = { id: 1, site_id: 1, date: '2026-04-03', name: 'Good Friday', is_custom: false };
  const closure = { id: 7, site_id: 1, date: '2026-03-20', name: 'Inventory', counts_as_unavailable: true } as CompanyEvent;

  beforeEach(() => {
    useAppStore.setState({
      bankHolidays: [holiday],
      bankHolidayDates: new Set(['2026-04-03']),
      closureIndex: new Map([['2026-03-20', [closure]]]),
    });
  });

  it('greys weekends and marks holidays and closures with a dot, a tooltip and the accessible name', () => {
    render(<Harness />);
    fireEvent.click(startField());

    expect(cell('2026-03-14').className).toMatch(/weekend/); // Saturday
    expect(cell('2026-03-16').className).not.toMatch(/weekend/);

    const friday = dayButton(datePanel(), '2026-04-03');
    expect(cell('2026-04-03').className).toMatch(/holiday/);
    expect(friday).toHaveAttribute('title', 'Bank holiday: Good Friday');
    expect(friday).toHaveAccessibleName(/, Bank holiday: Good Friday$/);
    expect(friday.querySelector('[class*="holidayDot"]')).not.toBeNull();

    const closed = dayButton(datePanel(), '2026-03-20');
    expect(cell('2026-03-20').className).toMatch(/closure/);
    expect(closed).toHaveAttribute('title', 'Site closed: Inventory');
    expect(closed).toHaveAccessibleName(/, Site closed: Inventory$/);

    const plain = dayButton(datePanel(), '2026-03-16');
    expect(plain).not.toHaveAttribute('title');
    expect(plain.querySelector('[class*="Dot"]')).toBeNull();
  });

  it('keeps marked days selectable', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.click(endField());
    fireEvent.click(dayButton(datePanel(), '2026-04-03'));
    expect(spy).toHaveBeenCalledWith({ start: '2026-03-10', end: '2026-04-03' });
  });

  it('marks nothing with markSiteCalendar={false}', () => {
    render(<Harness markSiteCalendar={false} />);
    fireEvent.click(startField());
    expect(cell('2026-04-03').className).not.toMatch(/holiday/);
    expect(dayButton(datePanel(), '2026-04-03')).not.toHaveAttribute('title');
    expect(cell('2026-03-14').className).toMatch(/weekend/);
  });
});

describe('DateRangeField — navigation and layout', () => {
  it('lets the year dropdown reach far dates', () => {
    render(<Harness />);
    const panel = openDateField('Start date');
    const year = within(panel).getAllByRole('combobox', { name: 'Choose the Year' })[0];
    expect(within(year).getByRole('option', { name: '2031' })).toBeInTheDocument();

    showMonth(panel, '2031-06-01');
    expect(dayButton(datePanel(), '2031-06-12')).toBeInTheDocument();
  });

  it('widens the navigation to reach values far from today', () => {
    render(<Harness initial={{ start: '1999-05-03', end: '1999-05-04' }} />);
    fireEvent.click(startField());
    expect(dayButton(datePanel(), '1999-05-03')).toBeInTheDocument();
  });

  it('shows one month on a phone and two again when the viewport widens', () => {
    const setPhone = stubPhoneQuery(true);
    render(<Harness />);
    fireEvent.click(startField());
    expect(within(datePanel()).getAllByRole('grid')).toHaveLength(1);

    act(() => setPhone(false));
    expect(within(datePanel()).getAllByRole('grid')).toHaveLength(2);
  });

  it('positions the panel as fixed coordinates', () => {
    render(<Harness />);
    fireEvent.click(startField());
    // jsdom rects are all zero: below the (zero) anchor, at the left gutter
    expect(datePanel().style.top).toBe('4px');
    expect(datePanel().style.left).toBe('8px');
  });

  it('re-measures on resize and scroll, once per animation frame', () => {
    render(<Harness />);
    fireEvent.click(startField());
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const rect = { top: 100, bottom: 136, left: 120, right: 520, width: 400, height: 36, x: 120, y: 100 };
    vi.spyOn(startField(), 'getBoundingClientRect').mockReturnValue({ ...rect, toJSON: () => rect } as DOMRect);

    act(() => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
      document.dispatchEvent(new Event('scroll'));
    });
    expect(raf).toHaveBeenCalledOnce();

    act(() => frames[0](0));
    // The union of the moved Start field and the (zero-rect) End field
    expect(datePanel().style.top).toBe('140px');
    expect(datePanel().style.left).toBe('8px');
  });

  it('re-measures when the status row appears after the first click', () => {
    render(<Harness />);
    fireEvent.click(startField());
    const panel = datePanel();
    const rect = { top: 600, bottom: 636, left: 100, right: 500, width: 400, height: 36, x: 100, y: 600 };
    for (const field of [startField(), endField()]) {
      vi.spyOn(field, 'getBoundingClientRect').mockReturnValue({ ...rect, toJSON: () => rect } as DOMRect);
    }
    // jsdom lays nothing out: the status row adds 30 px to the panel
    Object.defineProperty(panel, 'scrollHeight', {
      configurable: true,
      get: () => (panel.textContent?.includes('Now pick the end date') ? 330 : 300),
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    // The 768 px jsdom viewport leaves 120 px below the fields: the panel sits above
    expect(panel.style.top).toBe(`${600 - 4 - 300}px`);

    fireEvent.click(dayButton(panel, '2026-03-11'));
    expect(panel).toHaveTextContent('Now pick the end date');
    expect(panel.style.top).toBe(`${600 - 4 - 330}px`);
  });

  it('closes when the fields scroll out of view', () => {
    render(<Harness />);
    fireEvent.click(startField());
    const rect = { top: -200, bottom: -164, left: 0, right: 300, width: 300, height: 36, x: 0, y: -200 };
    vi.spyOn(startField(), 'getBoundingClientRect').mockReturnValue({ ...rect, toJSON: () => rect } as DOMRect);
    vi.spyOn(endField(), 'getBoundingClientRect').mockReturnValue({ ...rect, toJSON: () => rect } as DOMRect);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(queryPanel()).not.toBeInTheDocument();
  });
});
