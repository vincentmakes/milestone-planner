/**
 * MultiSelectDropdown: a Select-looking box listing the chosen names, over a
 * multi-select listbox — click / Space / Enter toggle and keep it open,
 * arrows move, Clear empties, Escape closes back to the trigger, an outside
 * mousedown or Tab out closes it. With `searchable`, a focused search box
 * filters the rows; Enter toggles and keeps it open, Space types.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MultiSelectDropdown } from '../MultiSelectDropdown';
import type { MultiSelectDropdownItem, MultiSelectDropdownProps } from '../MultiSelectDropdown';

const ITEMS: MultiSelectDropdownItem[] = [
  { id: 1, name: 'Process', color: '#2563eb' },
  { id: 2, name: 'Analytics', color: '#16a34a' },
  { id: 3, name: 'QA' },
];

function Harness({
  initial = [],
  options = ITEMS,
  onChange = () => {},
  ...props
}: Partial<MultiSelectDropdownProps> & {
  initial?: number[];
  options?: MultiSelectDropdownItem[];
}) {
  const [ids, setIds] = useState(initial);
  return (
    <>
      <MultiSelectDropdown
        label="Area"
        {...props}
        options={options}
        selectedIds={new Set(ids)}
        onChange={(next) => {
          onChange(next);
          setIds(next);
        }}
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
    // a mousedown on a row or on Clear never takes focus out of the list
    expect(fireEvent.mouseDown(option('Process'))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Clear' }))).toBe(false);
    expect(listbox()).toHaveFocus();
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

  it('puts the active row back on the list when the options shrink while open', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(listbox(), { key: 'End' }); // QA, row 2
    rerender(<Harness onChange={onChange} options={[ITEMS[1]]} />);
    expect(listbox()).toHaveAttribute('aria-activedescendant', option('Analytics').id);
    fireEvent.keyDown(listbox(), { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith([2]);
  });

  it('reveals the open panel when it ends below the visible area', () => {
    const original = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const rect = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ top: 140, bottom: window.innerHeight + 40, height: 100 } as DOMRect);
    try {
      render(<Harness searchable />);
      fireEvent.click(trigger());
      const reveal = scrollIntoView.mock.calls.findIndex(([arg]) => arg?.block === 'end');
      expect(scrollIntoView.mock.calls[reveal]).toEqual([{ block: 'end', inline: 'nearest' }]);
      expect(scrollIntoView.mock.contexts[reveal]).toBe(listbox().parentElement);
    } finally {
      rect.mockRestore();
      Element.prototype.scrollIntoView = original;
    }
  });

  describe('searchable', () => {
    const PEOPLE: MultiSelectDropdownItem[] = [
      { id: 1, name: 'Alice Martin', hint: 'Chemist' },
      { id: 2, name: 'Bob Brown', hint: 'Lab technician' },
      { id: 3, name: 'Charlie Day' },
    ];
    const search = () => screen.getByRole('combobox', { name: 'Find a person' });
    const names = () => within(listbox()).queryAllByRole('option').map((o) => o.textContent);

    it('focuses the search box on open, the combobox wiring on it, not the list', () => {
      render(<Harness options={PEOPLE} searchable initial={[2]} />);
      fireEvent.click(trigger());
      expect(search()).toHaveFocus();
      expect(search()).toHaveAttribute('placeholder', 'Type to find…');
      expect(search()).toHaveAttribute('aria-controls', listbox().id);
      expect(search()).toHaveAttribute('aria-autocomplete', 'list');
      expect(search()).toHaveAttribute('aria-activedescendant', option('Bob Brown Lab technician').id);
      expect(listbox()).not.toHaveAttribute('tabindex');
      expect(listbox()).not.toHaveAttribute('aria-activedescendant');
      expect(names()).toEqual(['Alice Martin Chemist', 'Bob Brown Lab technician', 'Charlie Day']);
    });

    it('filters by name and hint from the first character, and says when nothing matches', () => {
      render(<Harness options={PEOPLE} searchable noMatchText="Nobody here" />);
      fireEvent.click(trigger());
      fireEvent.change(search(), { target: { value: 'c' } });
      expect(names()).toEqual(['Alice Martin Chemist', 'Bob Brown Lab technician', 'Charlie Day']);
      fireEvent.change(search(), { target: { value: 'TECH' } });
      expect(names()).toEqual(['Bob Brown Lab technician']);
      expect(search()).toHaveAttribute('aria-activedescendant', option('Bob Brown Lab technician').id);
      fireEvent.change(search(), { target: { value: 'zzz' } });
      expect(names()).toEqual([]);
      expect(screen.getByRole('status')).toHaveTextContent('Nobody here');
      expect(search()).not.toHaveAttribute('aria-activedescendant');
      expect(fireEvent.keyDown(search(), { key: 'Enter' })).toBe(false); // nothing to toggle
    });

    it('moves with the arrows, Enter toggles the active row and keeps the panel open', () => {
      const onChange = vi.fn();
      render(<Harness options={PEOPLE} searchable onChange={onChange} />);
      fireEvent.click(trigger());
      fireEvent.keyDown(search(), { key: 'ArrowDown' });
      expect(fireEvent.keyDown(search(), { key: 'Enter' })).toBe(false);
      expect(onChange).toHaveBeenLastCalledWith([2]);
      expect(listbox()).toBeInTheDocument();
      expect(search()).toHaveFocus();
      fireEvent.keyDown(search(), { key: 'End' });
      fireEvent.keyDown(search(), { key: 'Enter' });
      expect(onChange).toHaveBeenLastCalledWith([2, 3]);
      // Space is text in the search box: it filters, it never toggles
      expect(fireEvent.keyDown(search(), { key: ' ' })).toBe(true);
      fireEvent.change(search(), { target: { value: 'bob ' } });
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(names()).toEqual(['Bob Brown Lab technician']);
    });

    it('keeps a chosen item hidden by the query when another is toggled', () => {
      const onChange = vi.fn();
      render(<Harness options={PEOPLE} searchable initial={[1, 3]} onChange={onChange} />);
      fireEvent.click(trigger());
      fireEvent.change(search(), { target: { value: 'bob' } });
      fireEvent.click(option('Bob Brown Lab technician'));
      expect(onChange).toHaveBeenLastCalledWith([1, 2, 3]);
      fireEvent.keyDown(search(), { key: 'Enter' }); // the active row: Bob again
      expect(onChange).toHaveBeenLastCalledWith([1, 3]);
    });

    it('focuses the search box again after Clear', () => {
      const onChange = vi.fn();
      render(<Harness options={PEOPLE} searchable initial={[1]} onChange={onChange} />);
      fireEvent.click(trigger());
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(onChange).toHaveBeenLastCalledWith([]);
      expect(search()).toHaveFocus();
    });

    it('starts afresh after closing, and Tab out closes it', () => {
      render(<Harness options={PEOPLE} searchable />);
      fireEvent.click(trigger());
      fireEvent.change(search(), { target: { value: 'ali' } });
      fireEvent.keyDown(search(), { key: 'Escape' });
      expect(trigger()).toHaveFocus();
      fireEvent.click(trigger());
      expect(search()).toHaveValue('');
      expect(names()).toHaveLength(3);
      fireEvent.blur(search(), { relatedTarget: trigger() }); // Shift+Tab: stays
      expect(listbox()).toBeInTheDocument();
      fireEvent.blur(search(), { relatedTarget: screen.getByRole('button', { name: 'Outside' }) });
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('never submits a host form on Enter', () => {
      const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
      render(
        <form onSubmit={onSubmit}>
          <Harness options={PEOPLE} searchable />
        </form>
      );
      fireEvent.click(trigger());
      // jsdom never submits on a keyDown: the prevented default is the proof
      expect(fireEvent.keyDown(search(), { key: 'Enter' })).toBe(false);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('hides Clear with allowClear={false} and shows the summary on the trigger', () => {
      render(
        <Harness
          options={PEOPLE}
          searchable
          allowClear={false}
          initial={[1, 2]}
          placeholder="No members"
          summary={(chosen) => `${chosen.length} members`}
        />
      );
      expect(trigger()).toHaveAccessibleName('Area 2 members');
      expect(screen.getByText('2 members')).toHaveAttribute('title', 'Alice Martin, Bob Brown');
      fireEvent.click(trigger());
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
      fireEvent.click(option('Alice Martin Chemist'));
      fireEvent.click(option('Bob Brown Lab technician'));
      expect(trigger()).toHaveAccessibleName('Area No members');
    });

    it('shows no search box when there is no item', () => {
      render(<Harness options={[]} searchable />);
      fireEvent.click(trigger());
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('No items for this site');
    });
  });
});
