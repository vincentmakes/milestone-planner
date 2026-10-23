/**
 * MultiSelectDropdown: a Select-looking box listing the chosen names, over a
 * multi-select listbox — click / Space / Enter toggle and keep it open,
 * arrows move, Clear empties, Escape closes back to the trigger, an outside
 * mousedown or Tab out closes it.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MultiSelectDropdown } from '../MultiSelectDropdown';
import type { MultiSelectDropdownItem } from '../MultiSelectDropdown';

const ITEMS: MultiSelectDropdownItem[] = [
  { id: 1, name: 'Process', color: '#2563eb' },
  { id: 2, name: 'Analytics', color: '#16a34a' },
  { id: 3, name: 'QA' },
];

function Harness({
  initial = [],
  options = ITEMS,
  onChange = () => {},
  disabled,
}: {
  initial?: number[];
  options?: MultiSelectDropdownItem[];
  onChange?: (next: number[]) => void;
  disabled?: boolean;
}) {
  const [ids, setIds] = useState(initial);
  return (
    <>
      <MultiSelectDropdown
        label="Area"
        options={options}
        selectedIds={new Set(ids)}
        onChange={(next) => {
          onChange(next);
          setIds(next);
        }}
        disabled={disabled}
      />
      <button type="button">Outside</button>
    </>
  );
}

const trigger = () => screen.getByRole('button', { name: /^Area/ });
const listbox = () => screen.getByRole('listbox', { name: 'Area' });
const option = (name: string) => within(listbox()).getByRole('option', { name });

describe('MultiSelectDropdown', () => {
  it('shows the placeholder, then the chosen names in item order', () => {
    const { unmount } = render(<Harness />);
    expect(trigger()).toHaveTextContent('None');
    expect(trigger()).toHaveAccessibleName('Area None');
    unmount();

    render(<Harness initial={[3, 1]} />);
    expect(trigger()).toHaveTextContent('Process, QA');
    expect(screen.getByText('Process, QA')).toHaveAttribute('title', 'Process, QA');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('ignores chosen ids that are no longer on offer', () => {
    render(<Harness initial={[99, 2]} />);
    expect(trigger()).toHaveTextContent('Analytics');
  });

  it('opens a labelled multi-select listbox with one option per item', () => {
    render(<Harness initial={[2]} />);
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', listbox().id);
    expect(listbox()).toHaveAttribute('aria-multiselectable', 'true');
    expect(within(listbox()).getAllByRole('option').map((o) => o.textContent)).toEqual(['Process', 'Analytics', 'QA']);
    expect(option('Analytics')).toHaveAttribute('aria-selected', 'true');
    expect(option('Process')).toHaveAttribute('aria-selected', 'false');
    // focus lands in the list, on the first chosen item
    expect(listbox()).toHaveFocus();
    expect(listbox()).toHaveAttribute('aria-activedescendant', option('Analytics').id);
  });

  it('toggles on click, keeps the panel open and reports ids in item order', () => {
    const onChange = vi.fn();
    render(<Harness initial={[3]} onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(option('Process'));
    expect(onChange).toHaveBeenLastCalledWith([1, 3]);
    expect(listbox()).toBeInTheDocument();
    expect(trigger()).toHaveTextContent('Process, QA');

    fireEvent.click(option('QA'));
    expect(onChange).toHaveBeenLastCalledWith([1]);
    expect(option('QA')).toHaveAttribute('aria-selected', 'false');
  });

  it('moves with the arrows, Home and End, and toggles with Space and Enter', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(listbox()).toHaveAttribute('aria-activedescendant', option('Process').id);

    fireEvent.keyDown(listbox(), { key: 'ArrowDown' });
    fireEvent.keyDown(listbox(), { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith([2]);

    fireEvent.keyDown(listbox(), { key: 'End' });
    fireEvent.keyDown(listbox(), { key: 'ArrowDown' }); // stays on the last
    fireEvent.keyDown(listbox(), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith([2, 3]);

    fireEvent.keyDown(listbox(), { key: 'Home' });
    fireEvent.keyDown(listbox(), { key: 'ArrowUp' }); // stays on the first
    expect(listbox()).toHaveAttribute('aria-activedescendant', option('Process').id);
    fireEvent.keyDown(listbox(), { key: 'Tab' }); // other keys do nothing
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('opens on ArrowUp too, and the trigger toggles the panel', () => {
    render(<Harness />);
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    expect(listbox()).toBeInTheDocument();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' }); // already open: nothing
    fireEvent.click(trigger());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('clears the choice from the Clear row, shown only when something is chosen', () => {
    const onChange = vi.fn();
    render(<Harness initial={[1, 2]} onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(trigger()).toHaveTextContent('None');
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    expect(listbox()).toHaveFocus();
  });

  it('closes on Escape with focus back on the trigger', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.keyDown(listbox(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('closes on a mousedown outside and when focus leaves it', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(trigger());
    fireEvent.blur(listbox(), { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('says when the site offers no item', () => {
    render(<Harness options={[]} />);
    fireEvent.click(trigger());
    expect(screen.getByRole('status')).toHaveTextContent('No items for this site');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('cannot be opened while disabled', () => {
    render(<Harness disabled />);
    expect(trigger()).toBeDisabled();
  });
});
