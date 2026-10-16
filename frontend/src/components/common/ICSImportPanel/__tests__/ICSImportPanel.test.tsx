/**
 * ICSImportPanel is the one import UI for vacations, holidays and company
 * events. These pin its selection rules: entries that already exist start
 * unchecked, select-all toggles everything, only checked rows reach onImport,
 * and a disabledReason (What-If mode) blocks the drop zone.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ICSImportPanel } from '../ICSImportPanel';
import type { ParsedICSEvent } from '@/utils/ics';

const year = new Date().getFullYear();

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  `DTSTART;VALUE=DATE:${year}0101`,
  'SUMMARY:New Year',
  'END:VEVENT',
  'BEGIN:VEVENT',
  `DTSTART;VALUE=DATE:${year}0801`,
  'SUMMARY:National Day',
  'END:VEVENT',
  'BEGIN:VEVENT',
  `DTSTART;VALUE=DATE:${year}1225`,
  `DTEND;VALUE=DATE:${year}1227`,
  'SUMMARY:Christmas',
  'END:VEVENT',
  'BEGIN:VEVENT',
  `DTSTART;VALUE=DATE:${year}0105`,
  'RRULE:FREQ=WEEKLY',
  'SUMMARY:Weekly sync',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const loadFile = () => {
  const file = new File([ICS], 'holidays.ics', { type: 'text/calendar' });
  fireEvent.change(screen.getByLabelText('Choose .ics file'), { target: { files: [file] } });
};

const rowBox = (name: string) => screen.getByLabelText(new RegExp(`^Select ${name}`)) as HTMLInputElement;

describe('ICSImportPanel', () => {
  it('flags duplicates and leaves them unchecked; lists unsupported entries', async () => {
    const isDuplicate = (e: ParsedICSEvent) => e.summary === 'National Day';
    render(<ICSImportPanel onImport={vi.fn()} isDuplicate={isDuplicate} itemLabel="holiday" />);
    loadFile();

    await screen.findByText('Christmas');
    expect(rowBox('New Year').checked).toBe(true);
    expect(rowBox('National Day').checked).toBe(false);
    expect(rowBox('Christmas').checked).toBe(true);
    expect(screen.getByText('Exists')).toBeInTheDocument();
    expect(screen.getByText('Weekly sync')).toBeInTheDocument();
    expect(screen.getByText('unsupported recurrence')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 2 holidays' })).toBeEnabled();
  });

  it('select-all checks every row, then clears them', async () => {
    const isDuplicate = (e: ParsedICSEvent) => e.summary === 'National Day';
    render(<ICSImportPanel onImport={vi.fn()} isDuplicate={isDuplicate} />);
    loadFile();
    await screen.findByText('Christmas');

    const selectAll = screen.getByLabelText('Select all') as HTMLInputElement;
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);

    fireEvent.click(selectAll);
    expect(['New Year', 'National Day', 'Christmas'].every((n) => rowBox(n).checked)).toBe(true);
    expect(screen.getByRole('button', { name: 'Import 3 events' })).toBeEnabled();

    fireEvent.click(selectAll);
    expect(['New Year', 'National Day', 'Christmas'].some((n) => rowBox(n).checked)).toBe(false);
    expect(screen.getByRole('button', { name: 'Import 0 events' })).toBeDisabled();
  });

  it('calls onImport with only the selected rows and their extras, then shows the summary', async () => {
    const onImport = vi.fn().mockResolvedValue({ created: 1, skipped: 0, linked: 1 });
    render(
      <ICSImportPanel<string>
        onImport={onImport}
        defaultExtra="#3b82f6"
        extraColumnLabel="Colour"
        renderRowExtra={(row, setExtra) => (
          <button type="button" onClick={() => setExtra('#ef4444')}>
            recolour {row.summary}
          </button>
        )}
      />,
    );
    loadFile();
    await screen.findByText('Christmas');

    fireEvent.click(rowBox('New Year'));
    fireEvent.click(screen.getByText('recolour Christmas'));
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 events' }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const rows = onImport.mock.calls[0][0];
    expect(rows.map((r: { summary: string; extra: string }) => [r.summary, r.extra])).toEqual([
      ['National Day', '#3b82f6'],
      ['Christmas', '#ef4444'],
    ]);
    expect(rows[1]).toMatchObject({ start_date: `${year}-12-25`, end_date: `${year}-12-26` });
    expect(await screen.findByRole('status')).toHaveTextContent('1 created, 0 skipped, 1 linked');
  });

  it('shows the error and keeps the preview when the import fails', async () => {
    const onImport = vi.fn().mockRejectedValue(new Error('Forbidden'));
    render(<ICSImportPanel onImport={onImport} />);
    loadFile();
    await screen.findByText('Christmas');

    fireEvent.click(screen.getByRole('button', { name: 'Import 3 events' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden');
    expect(screen.getByText('Christmas')).toBeInTheDocument();
  });

  it('disables the drop zone and file input when a disabledReason is given', () => {
    render(<ICSImportPanel onImport={vi.fn()} disabledReason="Unavailable in What-If mode" />);

    expect(screen.getByText('Unavailable in What-If mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Choose .ics file')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Drop an .ics file/ })).toHaveAttribute('aria-disabled', 'true');
  });

  it('rejects files that are not calendars', async () => {
    render(<ICSImportPanel onImport={vi.fn()} />);
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Choose .ics file'), { target: { files: [file] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Please select an .ics calendar file');
  });

  it('refuses a file over 5 MB before reading it', async () => {
    const readSpy = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
    render(<ICSImportPanel onImport={vi.fn()} />);
    const file = new File([ICS], 'huge.ics', { type: 'text/calendar' });
    // The size check must not depend on the content: fake a 6 MB file
    Object.defineProperty(file, 'size', { value: 6 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText('Choose .ics file'), { target: { files: [file] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This file is too large (6.0 MB). Calendar files up to 5 MB can be imported'
    );
    expect(readSpy).not.toHaveBeenCalled();
    expect(screen.queryByText('Christmas')).not.toBeInTheDocument();
    readSpy.mockRestore();
  });

  it('still reads a file of exactly 5 MB or less', async () => {
    render(<ICSImportPanel onImport={vi.fn()} />);
    const file = new File([ICS], 'holidays.ics', { type: 'text/calendar' });
    Object.defineProperty(file, 'size', { value: 5 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText('Choose .ics file'), { target: { files: [file] } });
    expect(await screen.findByText('Christmas')).toBeInTheDocument();
  });
});
