/**
 * The picker west of UTC: the evening of 2 Mar in New York is already 3 Mar
 * in UTC. "Today" and every picked day must stay local-calendar dates.
 */
// No @types/node in the app tsconfig; vitest runs on Node, where this exists.
declare const process: { env: Record<string, string | undefined> };
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { DateRangeField } from '../DateRangeField';
import { DateField } from '../DateField';
import { datePanel, dateValue, dayButton } from '@/test/datePicker';

function RangeHarness({ spy }: { spy: (next: { start: string; end: string }) => void }) {
  const [range, setRange] = useState({ start: '', end: '' });
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
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 2, 2, 21, 30)); // 2 Mar 21:30 local = 3 Mar 02:30 UTC
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('DateRangeField in New York', () => {
  it('opens on the local today and emits local calendar dates', () => {
    expect(new Date().getTimezoneOffset()).toBe(300); // EST: the zone is really pinned
    const spy = vi.fn();
    render(<RangeHarness spy={spy} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Start date' }));

    const today = datePanel().querySelector('td[data-today]');
    expect(today).toHaveAttribute('data-day', '2026-03-02');

    fireEvent.click(dayButton(datePanel(), '2026-03-10'));
    expect(spy).toHaveBeenLastCalledWith({ start: '2026-03-10', end: '' });
    fireEvent.click(dayButton(datePanel(), '2026-03-12'));
    expect(spy).toHaveBeenLastCalledWith({ start: '2026-03-10', end: '2026-03-12' });
    expect(dateValue('Start date')).toBe('2026-03-10');
  });

  it('keeps the duration when the start moves across the DST switch', () => {
    const spy = vi.fn();
    render(<RangeHarness spy={spy} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Start date' }));
    fireEvent.click(dayButton(datePanel(), '2026-03-06'));
    fireEvent.click(dayButton(datePanel(), '2026-03-09'));
    // New York springs forward on 8 Mar 2026
    fireEvent.click(screen.getByRole('combobox', { name: 'Start date' }));
    fireEvent.click(dayButton(datePanel(), '2026-03-20'));
    expect(spy).toHaveBeenLastCalledWith({ start: '2026-03-20', end: '2026-03-23' });
  });

  it('DateField emits the local day', () => {
    const onChange = vi.fn();
    render(<DateField value="" onChange={onChange} label="Due date" />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Due date' }));
    fireEvent.click(dayButton(datePanel(), '2026-03-10'));
    expect(onChange).toHaveBeenCalledWith('2026-03-10');
  });
});
