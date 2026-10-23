/**
 * SearchableSelect: a Select-looking trigger over a panel whose search box
 * opens focused and filters from the first character (label and hint, never
 * the note); arrows / Home / End / Enter pick, Escape / outside mousedown /
 * Tab out close, and onChange fires only on a real change.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SearchableSelect } from '../SearchableSelect';
import type { SearchableOption, SearchableSelectProps } from '../SearchableSelect';
import { Modal } from '@/components/common/Modal';
import { optionLabel, pickerOptions, pickerSearch, pickOption } from '@/test/searchableSelect';

const PEOPLE: SearchableOption[] = [
  { id: 1, label: 'Alice Martin', hint: 'Chemist', note: '80% capacity' },
  { id: 2, label: 'Bob Brown', hint: 'Lab technician' },
  { id: 3, label: 'Charlie Day', hint: 'Analyst', note: 'already on this card' },
  { id: 4, label: 'Diana Prince', disabled: true },
];

type HarnessProps = Partial<SearchableSelectProps> & { initial?: number | null };

function Harness({ initial = null, onChange = () => {}, ...props }: HarnessProps) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <>
      <SearchableSelect
        label="Staff Member"
        options={PEOPLE}
        emptyLabel="Select staff member"
        {...props}
        value={value}
        onChange={(id) => {
          onChange(id);
          setValue(id);
        }}
      />
      <button type="button">Outside</button>
    </>
  );
}

const trigger = () => screen.getByRole('button', { name: /^Staff Member/ });
const search = () => screen.getByRole('combobox', { name: 'Find a person' });
const listbox = () => screen.getByRole('listbox', { name: 'Staff Member' });
const labels = () => within(listbox()).getAllByRole('option').map(optionLabel);
const option = (label: string) => within(listbox()).getAllByRole('option').find((o) => optionLabel(o) === label)!;

describe('SearchableSelect', () => {
  it('shows the placeholder, then the chosen label, named with the label', () => {
    const { unmount } = render(<Harness />);
    expect(trigger()).toHaveAccessibleName('Staff Member Select staff member');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    unmount();

    render(<Harness initial={2} placeholder="Nobody yet" />);
    expect(trigger()).toHaveAccessibleName('Staff Member Bob Brown');
    expect(trigger()).toHaveAttribute('title', 'Bob Brown');
  });

  it('reads the placeholder over the empty label, and nothing when it has neither', () => {
    const { unmount } = render(<Harness placeholder="Nobody yet" />);
    expect(trigger()).toHaveTextContent('Nobody yet');
    unmount();
    render(<Harness emptyLabel={undefined} />);
    expect(trigger()).toHaveTextContent('');
  });

  it('opens on a click with the search box focused and the combobox wiring', () => {
    render(<Harness initial={3} />);
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', listbox().id);
    expect(search()).toHaveFocus();
    expect(search()).toHaveValue('');
    expect(search()).toHaveAttribute('aria-expanded', 'true');
    expect(search()).toHaveAttribute('aria-controls', listbox().id);
    expect(search()).toHaveAttribute('aria-autocomplete', 'list');
    // the active row starts on the current value, announced from the input
    expect(search()).toHaveAttribute('aria-activedescendant', option('Charlie Day').id);
    expect(listbox()).not.toHaveAttribute('aria-activedescendant');
    expect(listbox()).not.toHaveAttribute('tabindex');
    expect(labels()).toEqual(['Select staff member', 'Alice Martin', 'Bob Brown', 'Charlie Day', 'Diana Prince']);
    expect(option('Charlie Day')).toHaveAttribute('aria-selected', 'true');
    expect(option('Alice Martin')).toHaveAttribute('aria-selected', 'false');
    expect(option('Diana Prince')).toHaveAttribute('aria-disabled', 'true');
    // hint and note are shown in the row
    expect(option('Alice Martin')).toHaveTextContent('Alice Martin Chemist 80% capacity');
  });

  it('leaves Enter and Space to the native click, and toggles on the trigger', () => {
    render(<Harness />);
    // keydown alone neither opens nor is prevented: the browser's click does it
    expect(fireEvent.keyDown(trigger(), { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(trigger(), { key: ' ' })).toBe(true);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(trigger());
    expect(listbox()).toBeInTheDocument();
    fireEvent.click(trigger());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens on ArrowDown and ArrowUp', () => {
    render(<Harness />);
    expect(fireEvent.keyDown(trigger(), { key: 'ArrowDown' })).toBe(false);
    expect(search()).toHaveFocus();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' }); // already open: nothing
    expect(listbox()).toBeInTheDocument();
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    expect(listbox()).toBeInTheDocument();
  });

  it('opens on a printable key with that character as the query, typed once', () => {
    const { container } = render(<Harness />);
    expect(fireEvent.keyDown(trigger(), { key: 'b' })).toBe(false);
    expect(search()).toHaveFocus();
    expect(search()).toHaveValue('b');
    expect(labels()).toEqual(['Select staff member', 'Bob Brown']);
    expect(search()).toHaveAttribute('aria-activedescendant', option('Bob Brown').id);

    // back on the open trigger (Shift+Tab), a key adds to the query
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: 'r' });
    expect(search()).toHaveValue('br');
    expect(search()).toHaveFocus();

    // modifiers, composition and Space never open it
    fireEvent.keyDown(search(), { key: 'Escape' });
    fireEvent.keyDown(trigger(), { key: 'a', ctrlKey: true });
    fireEvent.keyDown(trigger(), { key: 'a', metaKey: true });
    fireEvent.keyDown(trigger(), { key: 'a', altKey: true });
    fireEvent.keyDown(trigger(), { key: 'a', isComposing: true });
    fireEvent.keyDown(trigger(), { key: 'Shift' });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('filters from the first character on the label and the hint, never the note', () => {
    render(<Harness />);
    const box = pickerSearch(/^Staff Member/);
    fireEvent.change(box, { target: { value: 'D' } });
    expect(labels()).toEqual(['Select staff member', 'Charlie Day', 'Diana Prince']);
    fireEvent.change(box, { target: { value: '  chem ' } });
    expect(labels()).toEqual(['Select staff member', 'Alice Martin']);
    fireEvent.change(box, { target: { value: 'capacity' } });
    expect(labels()).toEqual(['Select staff member']);
    expect(screen.getByRole('status')).toHaveTextContent('No one matches');
    expect(search()).not.toHaveAttribute('aria-activedescendant');
    fireEvent.change(box, { target: { value: '' } });
    expect(labels()).toHaveLength(5);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('moves with the arrows, Home and End over enabled rows, and Enter picks and closes', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    expect(search()).toHaveAttribute('aria-activedescendant', option('Select staff member').id);
    fireEvent.keyDown(search(), { key: 'ArrowUp' }); // stays on the first
    expect(search()).toHaveAttribute('aria-activedescendant', option('Select staff member').id);
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(search()).toHaveAttribute('aria-activedescendant', option('Bob Brown').id);
    fireEvent.keyDown(search(), { key: 'End' }); // Diana is disabled: Charlie
    expect(search()).toHaveAttribute('aria-activedescendant', option('Charlie Day').id);
    fireEvent.keyDown(search(), { key: 'ArrowDown' }); // nothing enabled below
    expect(search()).toHaveAttribute('aria-activedescendant', option('Charlie Day').id);
    fireEvent.keyDown(search(), { key: 'Home' });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(search()).toHaveAttribute('aria-activedescendant', option('Alice Martin').id);
    fireEvent.keyDown(search(), { key: 'Tab' }); // other keys: nothing
    expect(fireEvent.keyDown(search(), { key: 'Enter' })).toBe(false);
    expect(onChange).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAccessibleName('Staff Member Alice Martin');
  });

  it('picks the single match on Enter', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(trigger(), { key: 'b' });
    fireEvent.change(search(), { target: { value: 'bro' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('prevents Enter even when nothing matches, so a host form never submits', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const onChange = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <SearchableSelect label="Staff Member" options={PEOPLE} value={null} onChange={onChange} />
        <button type="submit">Save</button>
      </form>
    );
    fireEvent.click(trigger());
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(fireEvent.keyDown(search(), { key: 'Enter' })).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(listbox()).toBeInTheDocument();
  });

  it('picks with a click, keeps focus in the search box on mousedown, and the empty row picks null', () => {
    const onChange = vi.fn();
    render(<Harness initial={1} onChange={onChange} />);
    fireEvent.click(trigger());
    expect(fireEvent.mouseDown(option('Bob Brown'))).toBe(false);
    pickOption(/^Staff Member/, 'Bob Brown');
    expect(onChange).toHaveBeenLastCalledWith(2);
    expect(trigger()).toHaveFocus();

    pickOption(/^Staff Member/, 'Select staff member');
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(trigger()).toHaveAccessibleName('Staff Member Select staff member');
  });

  it('fires no onChange when the current value is picked again', () => {
    const onChange = vi.fn();
    render(<Harness initial={2} onChange={onChange} />);
    pickOption(/^Staff Member/, 'Bob Brown');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(trigger());
    fireEvent.keyDown(search(), { key: 'Home' });
    fireEvent.keyDown(search(), { key: 'Enter' }); // the empty row: a real change
    expect(onChange).toHaveBeenCalledTimes(1);
    pickOption(/^Staff Member/, 'Select staff member'); // already null
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores a click on a disabled option', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    pickOption(/^Staff Member/, 'Diana Prince');
    expect(onChange).not.toHaveBeenCalled();
    expect(listbox()).toBeInTheDocument();
  });

  it('closes on Escape with focus back on the trigger', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.change(search(), { target: { value: 'al' } });
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    // the next opening starts afresh
    fireEvent.click(trigger());
    expect(search()).toHaveValue('');
  });

  it('inside a Modal, Escape closes the picker and leaves the dialog open', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Assign Staff">
        <SearchableSelect label="Staff Member" options={PEOPLE} value={null} onChange={() => {}} />
      </Modal>
    );
    fireEvent.click(trigger());
    expect(search()).toHaveFocus();
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Assign Staff' })).toBeInTheDocument();
    // a second Escape, with the picker closed, is the dialog's
    fireEvent.keyDown(trigger(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a mousedown outside and when focus leaves it; Shift+Tab to the trigger keeps it open', () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(trigger());
    fireEvent.blur(search(), { relatedTarget: trigger() });
    expect(listbox()).toBeInTheDocument();
    fireEvent.blur(search(), { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('says when there is nothing to choose from', () => {
    render(<Harness options={[]} emptyText="No staff at this site" />);
    fireEvent.click(trigger());
    expect(screen.getByRole('status')).toHaveTextContent('No staff at this site');
    expect(labels()).toEqual(['Select staff member']);
  });

  it('uses the custom search texts', () => {
    render(
      <Harness searchLabel="Find equipment" searchPlaceholder="Type a name…" noMatchText="No equipment matches" />
    );
    fireEvent.click(trigger());
    const box = screen.getByRole('combobox', { name: 'Find equipment' });
    expect(box).toHaveAttribute('placeholder', 'Type a name…');
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByRole('status')).toHaveTextContent('No equipment matches');
  });

  it('never opens while disabled, and passes its title through', () => {
    render(<Harness disabled title="Not during What-If" initial={1} />);
    expect(trigger()).toBeDisabled();
    expect(trigger()).toHaveAttribute('title', 'Not during What-If');
    fireEvent.keyDown(trigger(), { key: 'a' });
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('takes a hidden label from aria-label, and className lands on the wrapper', () => {
    const { container } = render(
      <SearchableSelect
        aria-label="Add assignee"
        className="assignee"
        fullWidth
        options={PEOPLE}
        value={null}
        emptyLabel="Add someone…"
        onChange={() => {}}
      />
    );
    expect(container.firstElementChild).toHaveClass('assignee');
    const button = screen.getByRole('button', { name: 'Add assignee Add someone…' });
    expect(screen.getByText('Add assignee')).toHaveClass('sr-only');
    fireEvent.click(button);
    expect(screen.getByRole('listbox', { name: 'Add assignee' })).toBeInTheDocument();
  });

  it('names the list after the search box when it has no label at all', () => {
    render(<SearchableSelect options={PEOPLE} value={2} onChange={() => {}} />);
    const button = screen.getByRole('button', { name: 'Bob Brown' });
    fireEvent.click(button);
    expect(screen.getByRole('listbox', { name: 'Find a person' })).toBeInTheDocument();
    expect(pickerOptions(/Bob Brown/).map(optionLabel)).toEqual([
      'Alice Martin',
      'Bob Brown',
      'Charlie Day',
      'Diana Prince',
    ]);
  });
});
