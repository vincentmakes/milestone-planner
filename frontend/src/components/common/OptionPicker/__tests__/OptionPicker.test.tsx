/**
 * OptionPicker: the shared combobox behind the TagPicker and the
 * multi-select project fields.
 * - pills of the chosen items in option order, removable;
 * - the listbox opens on a click, typing or ArrowDown, never on plain focus;
 * - Enter picks the exact match or the only remaining one;
 * - it closes on Escape (focus back on the search box), an outside mousedown
 *   and Tab out, and Escape never reaches the dialog around it.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { OptionPicker } from '../OptionPicker';
import type { OptionPickerItem } from '../OptionPicker';

const OPTIONS: OptionPickerItem[] = [
  { id: 1, name: 'Process', color: '#1e3a8a' },
  { id: 2, name: 'Analytics', color: '#8b5cf6' },
  { id: 3, name: 'QA', color: '#fde047' },
];

function Harness({
  initial = [] as number[],
  options = OPTIONS,
  disabled = false,
  onKeyDown,
}: {
  initial?: number[];
  options?: OptionPickerItem[];
  disabled?: boolean;
  onKeyDown?: () => void;
}) {
  const [selected, setSelected] = useState(new Set(initial));
  return (
    <div onKeyDown={onKeyDown}>
      <OptionPicker
        options={options}
        selectedIds={selected}
        onChange={setSelected}
        searchLabel="Area"
        placeholder="Find an item..."
        emptyText="None"
        noOptionsText="No items for this site"
        noMatchText="No items match"
        disabled={disabled}
        action={<button type="button">Manage</button>}
      />
      <output data-testid="selected">{[...selected].sort().join(',')}</output>
      <button type="button">Outside</button>
    </div>
  );
}

const search = () => screen.getByRole('combobox', { name: 'Area' });

describe('OptionPicker', () => {
  it('shows the chosen items as pills in option order, coloured, and the empty text without', () => {
    const { unmount } = render(<Harness initial={[3, 1]} />);
    expect(screen.getAllByTitle(/./).map((p) => p.textContent)).toEqual(['Process', 'QA']);
    expect(screen.getByTitle('QA')).toHaveStyle({ color: 'rgb(17, 24, 39)' });
    expect(screen.getByTitle('Process')).toHaveStyle({ color: 'rgb(255, 255, 255)' });
    unmount();

    render(<Harness />);
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('opens on a click, typing or ArrowDown, not on focus', () => {
    render(<Harness />);
    fireEvent.focus(search());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(search()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(screen.getByRole('listbox', { name: 'Area' })).toBeInTheDocument();
    expect(search()).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
  });

  it('toggles an item by clicking it, and removes one through its pill', () => {
    render(<Harness initial={[1]} />);
    fireEvent.click(search());
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'Process' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(listbox).getByRole('option', { name: 'QA' }));
    expect(screen.getByTestId('selected')).toHaveTextContent('1,3');
    fireEvent.click(within(listbox).getByRole('option', { name: 'Process' }));
    expect(screen.getByTestId('selected')).toHaveTextContent('3');

    fireEvent.click(screen.getByRole('button', { name: 'Remove QA' }));
    expect(screen.getByTestId('selected')).toHaveTextContent('');
  });

  it('filters by name; Enter picks the exact or only match and never an already chosen one', () => {
    render(<Harness initial={[3]} />);
    fireEvent.change(search(), { target: { value: 'a' } }); // Analytics and QA
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2);
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(screen.getByTestId('selected')).toHaveTextContent('3');

    fireEvent.change(search(), { target: { value: 'qa' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(screen.getByTestId('selected')).toHaveTextContent('3');

    fireEvent.change(search(), { target: { value: 'analytics' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(screen.getByTestId('selected')).toHaveTextContent('2,3');
    expect(search()).toHaveValue('');

    fireEvent.keyDown(search(), { key: 'Enter' }); // empty search: nothing
    fireEvent.keyDown(search(), { key: 'a' }); // other keys: nothing
    expect(screen.getByTestId('selected')).toHaveTextContent('2,3');

    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(screen.getByText('No items match')).toBeInTheDocument();
  });

  it('says so when nothing is on offer', () => {
    render(<Harness options={[]} />);
    fireEvent.click(search());
    expect(screen.getByText('No items for this site')).toBeInTheDocument();
  });

  it('closes on Escape without letting it through, focus back on the search box', () => {
    const onKeyDown = vi.fn();
    render(<Harness onKeyDown={onKeyDown} />);
    fireEvent.click(search());
    const option = within(screen.getByRole('listbox')).getByRole('option', { name: 'QA' });
    option.focus();
    fireEvent.keyDown(option, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(search()).toHaveFocus();
  });

  it('closes on an outside mousedown and on Tab out, not on a mousedown inside', () => {
    render(<Harness />);
    fireEvent.click(search());
    fireEvent.mouseDown(screen.getByRole('option', { name: 'QA' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(search());
    fireEvent.blur(search(), { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('locks the search box and the pills while disabled, and never opens', () => {
    render(<Harness initial={[1]} disabled />);
    expect(search()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Process' })).toBeDisabled();
    fireEvent.click(search());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // The action slot is the caller's
    expect(screen.getByRole('button', { name: 'Manage' })).toBeEnabled();
  });
});
