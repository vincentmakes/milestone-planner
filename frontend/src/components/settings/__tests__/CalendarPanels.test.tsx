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
import { stubConfirm } from '@/test/confirmDialog';
import { dateValue, dayButton, openDateField, pickDate, pickEnd, showMonth } from '@/test/datePicker';
import type { BankHoliday, CompanyEvent, Site, User } from '@/types';
import { makeTeam } from '@/test/factories';

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
  is_resource: false,
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
  useAppStore.setState({ currentUser: admin, sites: [siteA, siteB], currentSite: null, teams: [] });
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
    stubConfirm(true);
    const pending = deferred();
    api.deleteCompanyEventById.mockReturnValue(pending.promise);
    render(<CompanyEventsPanel />);
    const del = await screen.findByRole('button', { name: 'Delete ISO Audit' });

    fireEvent.click(del);
    fireEvent.click(del);
    await waitFor(() => expect(api.deleteCompanyEventById).toHaveBeenCalledTimes(1));

    await act(async () => pending.resolve());
    await waitFor(() => expect(del).toBeEnabled());
    expect(api.deleteCompanyEventById).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends one DELETE for a holiday when Delete is clicked again while it runs', async () => {
    stubConfirm(true);
    const pending = deferred();
    api.deleteBankHoliday.mockReturnValue(pending.promise);
    render(<BankHolidaysPanel />);
    const del = await screen.findByRole('button', { name: 'Delete Company Day' });

    fireEvent.click(del);
    fireEvent.click(del);
    await waitFor(() => expect(api.deleteBankHoliday).toHaveBeenCalledTimes(1));
    expect(api.deleteBankHoliday).toHaveBeenCalledWith(1, 9);

    await act(async () => pending.resolve());
    await waitFor(() => expect(del).toBeEnabled());
    expect(api.deleteBankHoliday).toHaveBeenCalledTimes(1);
  });
});

describe('Calendar delete confirmations', () => {
  it('asks before deleting an event and deletes only once the confirmation resolves true', async () => {
    let answer!: (ok: boolean) => void;
    const confirm = stubConfirm(false);
    api.deleteCompanyEventById.mockResolvedValue(undefined);
    render(<CompanyEventsPanel />);
    const del = await screen.findByRole('button', { name: 'Delete ISO Audit' });

    await act(async () => {
      fireEvent.click(del);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Delete the event "ISO Audit"?', destructive: true })
    );
    expect(api.deleteCompanyEventById).not.toHaveBeenCalled();

    // Confirm first, then the guarded write: nothing runs while the dialog is open
    confirm.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
    fireEvent.click(del);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(api.deleteCompanyEventById).not.toHaveBeenCalled();
    expect(del).toBeEnabled();
    await act(async () => answer(true));
    await waitFor(() => expect(api.deleteCompanyEventById).toHaveBeenCalledWith(5));
  });

  it('removes a shared event from the superuser\'s own sites only after confirmation', async () => {
    const shared = { ...audit, site_ids: [1, 2] } as CompanyEvent;
    api.getCompanyEvents.mockImplementation(async (siteId: number) => (siteId === 1 ? [shared] : []));
    api.deleteCompanyEvent.mockResolvedValue(undefined);
    useAppStore.setState({ currentUser: { ...admin, role: 'superuser', site_ids: [1] } });
    const confirm = stubConfirm(false);
    render(<CompanyEventsPanel />);
    const remove = await screen.findByRole('button', { name: 'Remove ISO Audit from my sites' });

    await act(async () => {
      fireEvent.click(remove);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Remove the event "ISO Audit" from Basel?\n\nIt stays on the other sites it is linked to.',
        confirmLabel: 'Remove',
        destructive: true,
      })
    );
    expect(api.deleteCompanyEvent).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(remove);
    });
    await waitFor(() => expect(api.deleteCompanyEvent).toHaveBeenCalledWith(1, 5));
    expect(api.deleteCompanyEvent).toHaveBeenCalledTimes(1);
  });

  it('deletes a holiday only after the confirmation resolves true', async () => {
    let answer!: (ok: boolean) => void;
    const confirm = stubConfirm(false);
    api.deleteBankHoliday.mockResolvedValue(undefined);
    render(<BankHolidaysPanel />);
    const del = await screen.findByRole('button', { name: 'Delete Company Day' });

    await act(async () => {
      fireEvent.click(del);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Delete the holiday "Company Day"?', destructive: true })
    );
    expect(api.deleteBankHoliday).not.toHaveBeenCalled();

    confirm.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
    fireEvent.click(del);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(api.deleteBankHoliday).not.toHaveBeenCalled();
    await act(async () => answer(true));
    await waitFor(() => expect(api.deleteBankHoliday).toHaveBeenCalledWith(1, 9));
  });
});

describe('CompanyEventsPanel dates', () => {
  it("does not mark the header site's holidays and closures in its calendar", async () => {
    render(<CompanyEventsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit ISO Audit' }));
    act(() =>
      useAppStore.setState({
        bankHolidays: [holiday],
        bankHolidayDates: new Set(['2026-05-12', '2026-05-14']),
        closureIndex: new Map([['2026-05-15', [audit]]]),
      })
    );
    const panel = openDateField('Start date');
    showMonth(panel, '2026-05-01');
    expect(dayButton(panel, '2026-05-12')).toBeInTheDocument();
    expect(panel.querySelector('[class*="holiday"], [class*="closure"]')).toBeNull();
  });

  // The rule itself is proven in dateRangeLogic.test; this guards the form's payload wiring
  it('never lets the end precede the start', async () => {
    api.updateCompanyEvent.mockResolvedValue({});
    render(<CompanyEventsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit ISO Audit' }));
    expect(dateValue('Start date')).toBe('2026-05-12');
    expect(dateValue('End date (optional)')).toBe('');

    // An end picked before the start becomes the new start; the end is still to pick
    pickEnd('End date (optional)', '2026-05-01');
    expect(dateValue('Start date')).toBe('2026-05-01');
    expect(dateValue('End date (optional)')).toBe('');
    pickEnd('End date (optional)', '2026-05-03');
    expect(dateValue('End date (optional)')).toBe('2026-05-03');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.updateCompanyEvent).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ date: '2026-05-01', end_date: '2026-05-03' })
      )
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
    pickDate('Date', '2026-06-01');
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

    // The closure flag is a real switch
    const closure = screen.getByRole('switch', { name: /Site closure/ });
    const wasClosure = (closure as HTMLInputElement).checked;
    fireEvent.click(closure);
    expect((closure as HTMLInputElement).checked).toBe(!wasClosure);
    fireEvent.click(closure);

    // Adding a site is a change too
    fireEvent.click(within(screen.getByRole('group', { name: 'Event sites' })).getByLabelText('Zurich'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });
});

describe('CompanyEventsPanel filters and form fields', () => {
  it('filters by site and year, and the end date cannot precede the start', async () => {
    render(<CompanyEventsPanel />);
    await screen.findByRole('button', { name: 'Edit ISO Audit' });

    const site = screen.getByLabelText('Site');
    fireEvent.change(site, { target: { value: '2' } });
    expect(site).toHaveValue('2');
    expect(screen.queryByText('ISO Audit')).not.toBeInTheDocument();
    fireEvent.change(site, { target: { value: 'all' } });
    expect(site).toHaveValue('all');
    expect(screen.getByText('ISO Audit')).toBeInTheDocument();

    const year = screen.getByLabelText('Year');
    fireEvent.change(year, { target: { value: '2026' } });
    expect(year).toHaveValue('2026');
    expect(screen.getByText('ISO Audit')).toBeInTheDocument();
    fireEvent.change(year, { target: { value: 'all' } });
    expect(year).toHaveValue('all');

    fireEvent.click(screen.getByRole('button', { name: /Add event/ }));
    expect(screen.getByLabelText('End date (optional)')).toHaveAttribute('placeholder', 'Same day');
    pickDate('Start date', '2026-07-01');
    expect(dateValue('Start date')).toBe('2026-07-01');
    pickEnd('End date (optional)', '2026-06-29');
    expect(dateValue('Start date')).toBe('2026-06-29');
    expect(dateValue('End date (optional)')).toBe('');
  });

  it('sends the teams a closure is limited to and explains who is unavailable', async () => {
    api.createCompanyEventMultiSite.mockResolvedValue({});
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1, name: 'Analytics' }), makeTeam({ id: 3, site_id: 2, name: 'Line B' })],
    });
    render(<CompanyEventsPanel />);
    await screen.findByText('ISO Audit');
    fireEvent.click(screen.getByRole('button', { name: /Add event/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team offsite' } });
    pickDate('Start date', '2026-07-01');
    fireEvent.click(screen.getByRole('switch', { name: /Site closure/ }));

    const hint = /Only members of the ticked teams lose their capacity; everyone else on these sites is unaffected\./;
    fireEvent.click(screen.getByRole('switch', { name: 'Whole site' }));
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
    // No team ticked: the label speaks of every member of the sites
    expect(screen.getByRole('switch', { name: 'Site closure — staff on these sites are unavailable' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    expect(screen.getByText(hint)).toBeInTheDocument();
    // Teams ticked: the label itself carries the scope
    expect(
      screen.getByRole('switch', {
        name: 'Site closure — staff of the selected teams on these sites are unavailable',
      })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    expect(screen.getByRole('switch', { name: 'Site closure — staff on these sites are unavailable' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));

    fireEvent.click(within(screen.getByLabelText('Name').closest('form')!).getByRole('button', { name: 'Add event' }));
    await waitFor(() =>
      expect(api.createCompanyEventMultiSite).toHaveBeenCalledWith(
        expect.objectContaining({ site_ids: [1], counts_as_unavailable: true, team_ids: [1] })
      )
    );
  });
});

describe('CompanyEventsPanel teams column', () => {
  it('shows the teams an event is limited to, and "Whole site" for the others', async () => {
    const offsite = {
      ...audit,
      id: 6,
      name: 'Formulation offsite',
      site_id: 2,
      site_ids: [2],
      team_ids: [7],
    } as CompanyEvent;
    api.getCompanyEvents.mockImplementation(async (siteId: number) => (siteId === 1 ? [audit] : [offsite]));
    useAppStore.setState({
      teams: [makeTeam({ id: 7, site_id: 2, name: 'Formulation', color: '#10b981' })],
    });
    render(<CompanyEventsPanel />);

    expect(await screen.findByRole('columnheader', { name: 'Teams' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Site'), { target: { value: 'all' } });
    const offsiteRow = (await screen.findByText('Formulation offsite')).closest('tr')!;
    const chip = within(offsiteRow).getByText('Formulation');
    expect(chip.closest('[title]')).toHaveAttribute('title', 'Formulation · Zurich');
    expect(within(offsiteRow).queryByText('Whole site')).not.toBeInTheDocument();

    const auditRow = screen.getByText('ISO Audit').closest('tr')!;
    expect(within(auditRow).getByText('Whole site')).toBeInTheDocument();
  });

  it("says in the Closure badge's title whether the closure is limited to teams", async () => {
    api.getCompanyEvents.mockImplementation(async (siteId: number) =>
      siteId === 1
        ? [
            { ...audit, counts_as_unavailable: true, team_ids: [40] } as CompanyEvent,
            { ...audit, id: 6, name: 'Whole closure', counts_as_unavailable: true, team_ids: [] } as CompanyEvent,
          ]
        : []
    );
    render(<CompanyEventsPanel />);
    const limited = (await screen.findByText('ISO Audit')).closest('tr')!;
    expect(within(limited).getByText('Closure')).toHaveAttribute(
      'title',
      "Staff of the selected teams on the event's sites are unavailable"
    );
    const whole = screen.getByText('Whole closure').closest('tr')!;
    expect(within(whole).getByText('Closure')).toHaveAttribute('title', "Staff on the event's sites are unavailable");
  });

  it('counts the teams when none of them is loaded', async () => {
    api.getCompanyEvents.mockImplementation(async (siteId: number) =>
      siteId === 1 ? [{ ...audit, team_ids: [40, 41] } as CompanyEvent] : []
    );
    render(<CompanyEventsPanel />);
    const row = (await screen.findByText('ISO Audit')).closest('tr')!;
    expect(within(row).getByText('2 teams')).toBeInTheDocument();
    expect(within(row).queryByText('Whole site')).not.toBeInTheDocument();
  });
});
