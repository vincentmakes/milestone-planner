/**
 * Settings › Bank holidays and Company events.
 *
 * - Company-event import: the server links an existing event to the selected
 *   sites it is missing, so the preview only flags a row as "Exists" when the
 *   event is already on EVERY selected site (same rule as holidays).
 * - Deletes: a second click while the first DELETE is still running must not
 *   send another one (it would 404 and show an error for a delete that worked).
 * - The add/edit forms report unsaved input to the Settings hub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { BankHolidaysPanel } from '../panels/BankHolidaysPanel';
import { CompanyEventsPanel } from '../panels/CompanyEventsPanel';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import type { BankHoliday, CompanyEvent, Site, User } from '@/types';

const api = vi.hoisted(() => ({
  getBankHolidays: vi.fn(),
  createBankHoliday: vi.fn(),
  updateBankHoliday: vi.fn(),
  deleteBankHoliday: vi.fn(),
  importBankHolidays: vi.fn(),
  refreshBankHolidays: vi.fn(),
  getCompanyEvents: vi.fn(),
  createCompanyEventMultiSite: vi.fn(),
  updateCompanyEvent: vi.fn(),
  deleteCompanyEventById: vi.fn(),
  deleteCompanyEvent: vi.fn(),
  importCompanyEvents: vi.fn(),
  buildHolidayDateSet: vi.fn(() => new Set()),
  buildEventDateSet: vi.fn(() => new Set()),
}));
vi.mock('@/api', () => api);

const siteA: Site = { id: 1, name: 'Basel' };
const siteB: Site = { id: 2, name: 'Zurich' };

const admin: User = {
  id: 1,
  email: 'admin@demo.local',
  first_name: 'Ada',
  last_name: 'Admin',
  name: 'Ada Admin',
  role: 'admin',
  active: true,
  site_ids: [1, 2],
};

/** An audit already on Basel only */
const audit: CompanyEvent = {
  id: 5,
  name: 'ISO Audit',
  date: '2026-05-12',
  end_date: null,
  color: '#3b82f6',
  site_id: 1,
  site_ids: [1],
} as CompanyEvent;

const holiday: BankHoliday = {
  id: 9,
  site_id: 1,
  name: 'Company Day',
  date: '2026-05-12',
  end_date: null,
  is_custom: 1,
} as unknown as BankHoliday;

const AUDIT_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260512',
  'SUMMARY:ISO Audit',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.buildHolidayDateSet.mockReturnValue(new Set());
  api.buildEventDateSet.mockReturnValue(new Set());
  api.getBankHolidays.mockResolvedValue([holiday]);
  api.getCompanyEvents.mockImplementation(async (siteId: number) => (siteId === 1 ? [audit] : []));
  useAppStore.setState({ currentUser: admin, sites: [siteA, siteB], currentSite: null });
  useWhatIfStore.setState({ whatIfMode: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CompanyEventsPanel import preview', () => {
  it('flags an event as existing only while it is on every selected site', async () => {
    render(<CompanyEventsPanel />);
    await screen.findByText('ISO Audit');

    fireEvent.click(screen.getByRole('button', { name: /Import .ics/ }));
    const file = new File([AUDIT_ICS], 'audits.ics', { type: 'text/calendar' });
    fireEvent.change(screen.getByLabelText('Choose .ics file'), { target: { files: [file] } });

    // Import into Basel only: the audit is already there
    const box = (await screen.findByLabelText(/^Select ISO Audit/)) as HTMLInputElement;
    expect(screen.getByText('Exists')).toBeInTheDocument();
    expect(box.checked).toBe(false);

    // Basel + Zurich: the import would link it to Zurich, so it is not a duplicate
    const targets = screen.getByRole('group', { name: 'Import into sites' });
    fireEvent.click(within(targets).getByLabelText('Zurich'));
    await waitFor(() => expect(screen.queryByText('Exists')).not.toBeInTheDocument());
    expect((screen.getByLabelText(/^Select ISO Audit/) as HTMLInputElement).checked).toBe(true);
  });
});

describe('Calendar deletes', () => {
  it('sends one DELETE for an event when Delete is clicked again while it runs', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const pending = deferred();
    api.deleteCompanyEventById.mockReturnValue(pending.promise);
    render(<CompanyEventsPanel />);
    const del = await screen.findByRole('button', { name: 'Delete ISO Audit' });

    fireEvent.click(del);
    fireEvent.click(del);
    expect(api.deleteCompanyEventById).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve());
    await waitFor(() => expect(del).toBeEnabled());
    expect(api.deleteCompanyEventById).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends one DELETE for a holiday when Delete is clicked again while it runs', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const pending = deferred();
    api.deleteBankHoliday.mockReturnValue(pending.promise);
    render(<BankHolidaysPanel />);
    const del = await screen.findByRole('button', { name: 'Delete Company Day' });

    fireEvent.click(del);
    fireEvent.click(del);
    expect(api.deleteBankHoliday).toHaveBeenCalledTimes(1);
    expect(api.deleteBankHoliday).toHaveBeenCalledWith(1, 9);

    await act(async () => pending.resolve());
    await waitFor(() => expect(del).toBeEnabled());
    expect(api.deleteBankHoliday).toHaveBeenCalledTimes(1);
  });
});

describe('Calendar forms report unsaved input', () => {
  it('holiday form', async () => {
    const onDirtyChange = vi.fn();
    render(<BankHolidaysPanel onDirtyChange={onDirtyChange} />);
    await screen.findByText('Company Day');

    fireEvent.click(screen.getByRole('button', { name: /Add holiday/ }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Founders Day' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('holiday form submitted twice sends one create', async () => {
    const pending = deferred();
    api.createBankHoliday.mockReturnValue(pending.promise);
    render(<BankHolidaysPanel />);
    await screen.findByText('Company Day');

    fireEvent.click(screen.getByRole('button', { name: /Add holiday/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Founders Day' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-06-01' } });
    const form = screen.getByLabelText('Name').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(api.createBankHoliday).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
  });

  it('event form (an edit that is changed back is clean again)', async () => {
    const onDirtyChange = vi.fn();
    render(<CompanyEventsPanel onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit ISO Audit' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'ISO 9001 Audit' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(name, { target: { value: 'ISO Audit' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    // Adding a site is a change too
    fireEvent.click(within(screen.getByRole('group', { name: 'Event sites' })).getByLabelText('Zurich'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });
});
