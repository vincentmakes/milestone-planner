/**
 * VacationModal sends the chosen absence type, and its .ics import (the shared
 * ICSImportPanel) pre-fills each row's type: Outlook "working elsewhere"
 * entries become Home Office, the rest follow the default type.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { VacationModal } from '../VacationModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { createVacation, importVacations, getVacations } from '@/api/endpoints/vacations';
import type { AbsenceType } from '@/types';
import { asSignedIn } from '@/test/permissionFixtures';
import { dateValue, openDateField, pickEnd, pickRange, showMonth } from '@/test/datePicker';

vi.mock('@/api/endpoints/vacations', () => ({
  createVacation: vi.fn().mockResolvedValue({}),
  updateVacation: vi.fn().mockResolvedValue({}),
  getVacations: vi.fn().mockResolvedValue([]),
  importVacations: vi.fn().mockResolvedValue({ created: 2, skipped: 0 }),
}));

const TYPES: AbsenceType[] = [
  { id: 2, name: 'Home Office', color: '#0ea5e9', counts_as_unavailable: false, sort_order: 0, is_active: true },
  { id: 1, name: 'Holidays', color: '#8b5cf6', counts_as_unavailable: true, sort_order: 1, is_active: true },
  { id: 3, name: 'Illness', color: '#ef4444', counts_as_unavailable: true, sort_order: 2, is_active: true },
];

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260304',
  'SUMMARY:Remote',
  'X-MICROSOFT-CDO-BUSYSTATUS:WORKINGELSEWHERE',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260810',
  'DTEND;VALUE=DATE:20260815',
  'SUMMARY:Trip to Spain',
  'X-MICROSOFT-CDO-BUSYSTATUS:OOF',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

beforeEach(() => {
  vi.clearAllMocks();
  useWhatIfStore.setState({ whatIfMode: false });
  useAppStore.setState({
    currentUser: asSignedIn({
      id: 7,
      name: 'Una User',
      email: 'una@demo.local',
      first_name: 'Una',
      last_name: 'User',
      role: 'user',
      active: true,
      is_resource: true,
      site_ids: [1],
    }),
    staff: [],
    vacations: [],
    absenceTypes: TYPES,
  });
  useUIStore.getState().openVacationModal(undefined, 7);
});

describe('VacationModal', () => {
  it('defaults to the first unavailable type and sends the chosen one', async () => {
    render(<VacationModal />);

    // Falls back to the signed-in user when they are not in the site's staff list
    expect(screen.getByText('Una User')).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByLabelText('To')).toHaveAttribute('aria-haspopup', 'dialog');
    const select = screen.getByLabelText('Absence type') as HTMLSelectElement;
    expect(select.value).toBe('1'); // Holidays, not the first-sorted Home Office

    fireEvent.change(select, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createVacation).toHaveBeenCalled());
    expect(vi.mocked(createVacation).mock.calls[0][0]).toMatchObject({
      staff_id: 7,
      absence_type_id: 3,
      description: 'Illness',
    });
  });

  it('opens the day picker from the Recurring switch and forgets the days when switched off', async () => {
    render(<VacationModal />);
    const recurring = screen.getByRole('switch', { name: /Recurring Absence/ });
    expect(recurring).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Mon' })).not.toBeInTheDocument();

    fireEvent.click(recurring);
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
    expect(screen.getByText(/Mon/, { selector: 'div' })).toBeInTheDocument();

    // Off and on again: the picked days are gone, so saving asks for one
    fireEvent.click(recurring);
    expect(screen.queryByRole('button', { name: 'Mon' })).not.toBeInTheDocument();
    fireEvent.click(recurring);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Please select at least one day for the recurring pattern')).toBeInTheDocument();
    expect(createVacation).not.toHaveBeenCalled();
  });

  it('imports .ics rows with a per-row type pre-filled from BUSYSTATUS', async () => {
    render(<VacationModal />);
    fireEvent.click(screen.getByRole('tab', { name: 'Import .ics' }));

    const file = new File([ICS], 'outlook.ics', { type: 'text/calendar' });
    fireEvent.change(screen.getByLabelText('Choose .ics file'), { target: { files: [file] } });

    const remote = (await screen.findByLabelText(/^Absence type for Remote/)) as HTMLSelectElement;
    const trip = screen.getByLabelText(/^Absence type for Trip to Spain/) as HTMLSelectElement;
    expect(remote.value).toBe('2'); // WORKINGELSEWHERE -> Home Office
    expect(trip.value).toBe('1'); // default type

    // Changing the default re-targets rows that were not recognised
    fireEvent.change(screen.getByLabelText('Default absence type'), { target: { value: '3' } });
    expect(trip.value).toBe('3');
    expect(remote.value).toBe('2');

    fireEvent.click(screen.getByRole('button', { name: 'Import 2 absences' }));

    await waitFor(() => expect(importVacations).toHaveBeenCalled());
    expect(importVacations).toHaveBeenCalledWith(7, [
      { start_date: '2026-03-04', end_date: '2026-03-04', description: 'Remote', absence_type_id: 2 },
      { start_date: '2026-08-10', end_date: '2026-08-14', description: 'Trip to Spain', absence_type_id: 3 },
    ]);
    await waitFor(() => expect(getVacations).toHaveBeenCalled());
  });

  it('keeps the typed description when switching to Import .ics and back', async () => {
    render(<VacationModal />);
    const description = screen.getByLabelText(/^Description/) as HTMLInputElement;
    fireEvent.change(description, { target: { value: 'Ski week' } });

    fireEvent.click(screen.getByRole('tab', { name: 'Import .ics' }));
    expect(screen.queryByLabelText(/^Description/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Enter manually' }));

    expect((screen.getByLabelText(/^Description/) as HTMLInputElement).value).toBe('Ski week');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createVacation).toHaveBeenCalled());
    expect(vi.mocked(createVacation).mock.calls[0][0]).toMatchObject({ description: 'Ski week' });
  });

  it('forgets the description draft once the dialog is closed', () => {
    render(<VacationModal />);
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Ski week' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Import .ics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useUIStore.getState().activeModal).toBeNull();

    act(() => useUIStore.getState().openVacationModal(undefined, 7));
    expect((screen.getByLabelText(/^Description/) as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('tab', { name: 'Import .ics' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Enter manually' }));
    expect((screen.getByLabelText(/^Description/) as HTMLInputElement).value).toBe('');
  });

  it('blocks the import while What-If mode is active', () => {
    useWhatIfStore.setState({ whatIfMode: true });
    render(<VacationModal />);
    fireEvent.click(screen.getByRole('tab', { name: 'Import .ics' }));
    expect(screen.getByRole('note')).toHaveTextContent('What-If');
  });

  it('lists a person on several sites once in the staff picker', () => {
    // GET /staff returns one row per user-site pair
    useAppStore.setState({
      currentUser: asSignedIn({ ...useAppStore.getState().currentUser!, role: 'admin', permissions: undefined }),
      staff: [
        { id: 4, name: 'Bob Brown', site_id: 1 },
        { id: 4, name: 'Bob Brown', site_id: 2 },
        { id: 5, name: 'Cleo Chen', site_id: 2 },
      ] as never,
    });
    useUIStore.getState().openVacationModal(undefined, undefined);
    render(<VacationModal />);

    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options.filter((name) => name === 'Bob Brown')).toHaveLength(1);
    expect(options).toContain('Cleo Chen');
  });

  it('books the picked staff member for the typed dates', async () => {
    useAppStore.setState({
      currentUser: asSignedIn({ ...useAppStore.getState().currentUser!, role: 'admin', permissions: undefined }),
      staff: [
        { id: 4, name: 'Bob Brown', site_id: 1 },
        { id: 5, name: 'Cleo Chen', site_id: 1 },
      ] as never,
    });
    useUIStore.getState().openVacationModal(undefined, undefined);
    render(<VacationModal />);

    const picker = screen.getByLabelText('Staff Member');
    fireEvent.change(picker, { target: { value: '5' } });
    expect(picker).toHaveValue('5');
    pickRange('From', '2026-11-02', '2026-11-06');
    expect(dateValue('From')).toBe('2026-11-02');
    expect(dateValue('To')).toBe('2026-11-06');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createVacation).toHaveBeenCalled());
    expect(vi.mocked(createVacation).mock.calls[0][0]).toMatchObject({
      staff_id: 5,
      start_date: '2026-11-02',
      end_date: '2026-11-06',
    });
  });

  // The rule itself is proven in dateRangeLogic.test; this guards the form's payload wiring
  it('never lets the end precede the start', async () => {
    render(<VacationModal />);
    pickRange('From', '2026-11-02', '2026-11-06');
    // An end picked before the start becomes the new start, keeping the duration
    pickEnd('To', '2026-10-28');
    expect(dateValue('From')).toBe('2026-10-28');
    expect(dateValue('To')).toBe('2026-11-01');
    expect(screen.getByText('5 days')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createVacation).toHaveBeenCalled());
    expect(vi.mocked(createVacation).mock.calls[0][0]).toMatchObject({
      start_date: '2026-10-28',
      end_date: '2026-11-01',
    });
  });

  it('highlights the recurring weekdays in the calendar', () => {
    render(<VacationModal />);
    const cellOf = (iso: string) => document.querySelector(`td[data-day="${iso}"]:not([data-outside])`)!;

    showMonth(openDateField('From'), '2026-11-02');
    expect(cellOf('2026-11-02').className).not.toMatch(/recurring/);

    // The open calendar follows the recurring days as they are picked
    fireEvent.click(screen.getByRole('switch', { name: /Recurring Absence/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
    expect(cellOf('2026-11-02').className).toMatch(/recurring/); // Monday
    expect(cellOf('2026-11-03').className).not.toMatch(/recurring/); // Tuesday
  });
});
