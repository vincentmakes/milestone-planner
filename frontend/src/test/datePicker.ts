/**
 * Test helpers for `DateRangeField` / `DateField` (components/common/DateRangeField).
 *
 *   pickRange('Start Date', '2026-03-10', '2026-03-14');
 *   pickDate('Due date', '2026-04-01');
 *   expect(dateValue('End Date')).toBe('2026-03-14');
 *
 * Fields are found by their label. Assert the ISO value through `dateValue`
 * (the field's `data-value`), never the visible text, which follows the
 * browser locale. Navigation goes through the first month's "Choose the Year"
 * then "Choose the Month" dropdowns (in that order: month options outside the
 * navigable range are disabled), then the day is clicked in a cell of its own
 * month (outside-day cells carry the neighbouring month's `data-day`).
 */
import { fireEvent, screen, within } from '@testing-library/react';

const PANEL_NAME = /^Choose (dates|a date)$/;

/** The ISO value of a date field (`''` when empty). */
export function dateValue(label: string): string {
  return screen.getByLabelText(label).getAttribute('data-value') ?? '';
}

/** The open calendar panel. */
export function datePanel(): HTMLElement {
  return screen.getByRole('dialog', { name: PANEL_NAME });
}

/** Click the field and return the calendar panel. */
export function openDateField(label: string): HTMLElement {
  fireEvent.click(screen.getByLabelText(label));
  return datePanel();
}

/** Show the month of `iso` as the first month of the panel. */
export function showMonth(panel: HTMLElement, iso: string): void {
  const [year, month] = iso.split('-').map(Number);
  fireEvent.change(within(panel).getAllByRole('combobox', { name: 'Choose the Year' })[0], {
    target: { value: String(year) },
  });
  fireEvent.change(within(panel).getAllByRole('combobox', { name: 'Choose the Month' })[0], {
    target: { value: String(month - 1) },
  });
}

/** The day button of `iso` in the open panel (in a cell of its own month). */
export function dayButton(panel: HTMLElement, iso: string): HTMLButtonElement {
  const button = panel.querySelector<HTMLButtonElement>(`td[data-day="${iso}"]:not([data-outside]) button`);
  if (!button) throw new Error(`No day button for ${iso} in the date panel`);
  return button;
}

function clickDay(iso: string): void {
  const panel = datePanel();
  showMonth(panel, iso);
  fireEvent.click(dayButton(panel, iso));
}

/** Open the field and click `iso` (a single date, or the field's turn of a range). */
export function pickDate(label: string, iso: string): void {
  openDateField(label);
  clickDay(iso);
}

/** Open the Start field and click the start, then the end. */
export function pickRange(startLabel: string, start: string, end: string): void {
  openDateField(startLabel);
  clickDay(start);
  clickDay(end);
}

/** Open the End field and click the end. */
export function pickEnd(endLabel: string, iso: string): void {
  pickDate(endLabel, iso);
}
