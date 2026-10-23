/**
 * Test helpers for the listbox dropdowns: `SearchableSelect` and
 * `MultiSelectDropdown` (components/common).
 *
 *   pickOption(/^Project Manager/, 'Alice');
 *   expect(pickerOptions(/^Staff Member/).map(optionLabel)).toEqual(['Select staff member', 'Bob']);
 *   fireEvent.change(pickerSearch(/^Members/), { target: { value: 'al' } });
 *
 * A picker is found by its trigger, a button with `aria-haspopup="listbox"`
 * whose accessible name is the label followed by the chosen item (or the
 * placeholder) — hence a regex, usually anchored on the label. Opening is a
 * click on the trigger (left as is when already open).
 */
import { fireEvent, screen, within } from '@testing-library/react';

/** The picker's trigger button. */
export function pickerTrigger(name: RegExp): HTMLElement {
  const triggers = screen
    .getAllByRole('button', { name })
    .filter((b) => b.getAttribute('aria-haspopup') === 'listbox');
  if (triggers.length !== 1) throw new Error(`Expected one picker named ${name}, found ${triggers.length}`);
  return triggers[0];
}

/** Open the picker (when closed) and return its listbox. */
export function openPicker(name: RegExp): HTMLElement {
  const trigger = pickerTrigger(name);
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const listId = trigger.getAttribute('aria-controls');
  const listbox = listId ? document.getElementById(listId) : null;
  if (!listbox) throw new Error(`Picker ${name} did not open`);
  return listbox;
}

/** The search box of the open picker (opened first). */
export function pickerSearch(name: RegExp): HTMLInputElement {
  const listbox = openPicker(name);
  const panel = listbox.parentElement as HTMLElement;
  return within(panel).getByRole('combobox') as HTMLInputElement;
}

/** The option rows the picker shows (opened first). */
export function pickerOptions(name: RegExp): HTMLElement[] {
  return within(openPicker(name)).queryAllByRole('option');
}

/** The label of an option row: its first visible text, without hint or note. */
export function optionLabel(option: HTMLElement): string {
  const span = Array.from(option.children).find((c) => c.tagName === 'SPAN' && !c.hasAttribute('aria-hidden'));
  return span?.textContent ?? '';
}

/** Open the picker and click the option whose label is `label`. */
export function pickOption(name: RegExp, label: string): void {
  const option = pickerOptions(name).find((o) => optionLabel(o) === label);
  if (!option) throw new Error(`No option "${label}" in picker ${name}`);
  fireEvent.click(option);
}
