/**
 * The Bank Holidays and Company Events rows at the bottom of the staff panel:
 * counts, expansion, ICS export, Settings-hub shortcuts for editors and the
 * confirm-then-delete flow that reloads the site's calendar.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BankHolidaysRow } from '../BankHolidaysRow';
import { CompanyEventsRow } from '../CompanyEventsRow';
import { resetAllStores, useAppStore, useUIStore } from '@/stores';
import {
  deleteCustomHoliday,
  getBankHolidays,
  deleteCompanyEvent,
  getCompanyEvents,
} from '@/api';
import { downloadICS } from '@/utils/ics';
import { makeSite, makeUser } from '@/test/factories';
import type { BankHoliday, CompanyEvent } from '@/types';

vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api')>()),
  deleteCustomHoliday: vi.fn(),
  getBankHolidays: vi.fn(),
  deleteCompanyEvent: vi.fn(),
  getCompanyEvents: vi.fn(),
}));

vi.mock('@/utils/ics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/ics')>()),
  downloadICS: vi.fn(),
}));

const holidays: BankHoliday[] = [
  { id: 1, site_id: 1, date: '2026-08-01', name: 'National Day', is_custom: false },
  { id: 2, site_id: 1, date: '2027-12-24', end_date: '2027-12-26', name: 'Lab shutdown', is_custom: true },
];

const events: CompanyEvent[] = [
  { id: 11, site_id: 1, site_ids: [1], date: '2026-05-04', name: 'Audit', counts_as_unavailable: false },
  {
    id: 12,
    site_id: 1,
    site_ids: [1, 2],
    date: '2026-12-28',
    end_date: '2026-12-31',
    name: 'Year-end closure',
    counts_as_unavailable: true,
  },
];

function seed(role: 'admin' | 'superuser' | 'user') {
  useAppStore.setState({
    currentSite: makeSite({ id: 1, name: 'Basel' }),
    currentUser: makeUser({ role }),
    bankHolidays: holidays,
    companyEvents: events,
  });
}

beforeEach(() => {
  resetAllStores();
  vi.mocked(deleteCustomHoliday).mockReset();
  vi.mocked(getBankHolidays).mockReset();
  vi.mocked(deleteCompanyEvent).mockReset();
  vi.mocked(getCompanyEvents).mockReset();
  vi.mocked(downloadICS).mockReset();
});

describe('BankHolidaysRow', () => {
  it('summarises the site and toggles via the row', () => {
    seed('user');
    const onToggle = vi.fn();
    render(<BankHolidaysRow isExpanded={false} onToggle={onToggle} />);
    expect(screen.getByText('Basel')).toBeInTheDocument();
    expect(screen.getByText('2 holidays')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Bank Holidays'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('National Day')).not.toBeInTheDocument();
  });

  it('is read-only for plain users when expanded', () => {
    seed('user');
    render(<BankHolidaysRow isExpanded />);
    expect(screen.getByText('National Day')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.getByText('Holiday')).toBeInTheDocument();
    expect(screen.queryByTitle('Add custom holiday')).not.toBeInTheDocument();
    expect(screen.queryByText('Add custom holiday')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('National Day'));
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('exports every holiday to an ICS file named after the site', () => {
    seed('user');
    render(<BankHolidaysRow isExpanded={false} />);
    fireEvent.click(screen.getByTitle('Export to Outlook'));
    expect(downloadICS).toHaveBeenCalledTimes(1);
    const [content, filename] = vi.mocked(downloadICS).mock.calls[0];
    expect(filename).toBe('bank-holidays-Basel.ics');
    expect(content).toContain('SUMMARY:National Day');
    expect(content).toContain('SUMMARY:Lab shutdown');
  });

  it('does not export an empty calendar and says nothing is loaded', () => {
    useAppStore.setState({ currentSite: makeSite(), currentUser: makeUser(), bankHolidays: [] });
    render(<BankHolidaysRow isExpanded />);
    fireEvent.click(screen.getByTitle('Export to Outlook'));
    expect(downloadICS).not.toHaveBeenCalled();
    expect(screen.getByText('No holidays loaded')).toBeInTheDocument();
  });

  it('opens the Settings hub to add or edit a holiday', () => {
    seed('superuser');
    render(<BankHolidaysRow isExpanded />);

    fireEvent.click(screen.getByTitle('Add custom holiday'));
    expect(useUIStore.getState().settingsSection).toBe('bank-holidays');
    expect(useUIStore.getState().settingsIntent).toEqual({ type: 'add', siteId: 1 });

    fireEvent.click(screen.getByText('Lab shutdown'));
    expect(useUIStore.getState().settingsIntent).toEqual({ type: 'edit', id: 2, siteId: 1 });
  });

  it('deletes a holiday after confirmation and reloads the calendar', async () => {
    seed('admin');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deleteCustomHoliday).mockResolvedValue(undefined as never);
    vi.mocked(getBankHolidays).mockResolvedValue([holidays[0]]);
    render(<BankHolidaysRow isExpanded />);

    fireEvent.click(screen.getByTitle('Delete holiday (returns on the next Nager refresh)'));
    expect(confirm.mock.calls[0][0]).toMatch(/public holiday/);
    await waitFor(() => expect(useAppStore.getState().bankHolidays).toEqual([holidays[0]]));
    expect(deleteCustomHoliday).toHaveBeenCalledWith(1, 1);
    expect(useAppStore.getState().bankHolidayDates.has('2026-08-01')).toBe(true);
    // the click on the delete button does not open the editor
    expect(useUIStore.getState().settingsSection).toBeNull();
    confirm.mockRestore();
  });

  it('does nothing when the deletion is not confirmed, and shows the failure in the row', async () => {
    seed('admin');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<BankHolidaysRow isExpanded />);

    fireEvent.click(screen.getByTitle('Delete custom holiday'));
    expect(confirm.mock.calls[0][0]).toBe('Delete this custom holiday?');
    expect(deleteCustomHoliday).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    vi.mocked(deleteCustomHoliday).mockRejectedValue(new Error('nope'));
    fireEvent.click(screen.getByTitle('Delete custom holiday'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to delete holiday');
    expect(useAppStore.getState().bankHolidays).toHaveLength(2);
    confirm.mockRestore();
    err.mockRestore();
  });
});

describe('CompanyEventsRow', () => {
  it('summarises, toggles and labels closures', () => {
    seed('user');
    const onToggle = vi.fn();
    const { rerender } = render(<CompanyEventsRow isExpanded={false} onToggle={onToggle} />);
    expect(screen.getByText('2 events')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Company Events'));
    expect(onToggle).toHaveBeenCalled();

    rerender(<CompanyEventsRow isExpanded onToggle={onToggle} />);
    expect(screen.getByText('Event')).toBeInTheDocument();
    expect(screen.getByText('Closure')).toHaveAttribute(
      'title',
      'Site closure: staff on this site are unavailable'
    );
    expect(screen.queryByText('Add company event')).not.toBeInTheDocument();
  });

  it('uses the singular for one event and shows the empty state', () => {
    useAppStore.setState({ currentSite: makeSite(), currentUser: makeUser(), companyEvents: [events[0]] });
    const { unmount } = render(<CompanyEventsRow isExpanded={false} />);
    expect(screen.getByText('1 event')).toBeInTheDocument();
    unmount();

    useAppStore.setState({ companyEvents: [] });
    render(<CompanyEventsRow isExpanded />);
    expect(screen.getByText('No company events')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Export to Outlook'));
    expect(downloadICS).not.toHaveBeenCalled();
  });

  it('exports closures as busy out-of-office time', () => {
    seed('user');
    render(<CompanyEventsRow isExpanded={false} />);
    fireEvent.click(screen.getByTitle('Export to Outlook'));
    const [content, filename] = vi.mocked(downloadICS).mock.calls[0];
    expect(filename).toBe('company-events-Basel.ics');
    expect(content).toContain('SUMMARY:Year-end closure');
    expect(content).toContain('TRANSP:OPAQUE');
    expect(content).toContain('TRANSP:TRANSPARENT');
  });

  it('opens the Settings hub to add or edit an event', () => {
    seed('admin');
    render(<CompanyEventsRow isExpanded />);
    fireEvent.click(screen.getByText('Add company event'));
    expect(useUIStore.getState().settingsSection).toBe('company-events');
    expect(useUIStore.getState().settingsIntent).toEqual({ type: 'add', siteId: 1 });

    fireEvent.click(screen.getByText('Audit'));
    expect(useUIStore.getState().settingsIntent).toEqual({ type: 'edit', id: 11, siteId: 1 });
  });

  it('removes a shared event from this site only after confirmation', async () => {
    seed('admin');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deleteCompanyEvent).mockResolvedValue(undefined as never);
    vi.mocked(getCompanyEvents).mockResolvedValue([events[0]]);
    render(<CompanyEventsRow isExpanded />);

    fireEvent.click(screen.getByTitle('Remove from this site'));
    expect(confirm.mock.calls[0][0]).toMatch(/shared by 2 sites\. Remove it from Basel only\?/);
    await waitFor(() => expect(useAppStore.getState().companyEvents).toEqual([events[0]]));
    expect(deleteCompanyEvent).toHaveBeenCalledWith(1, 12);
    confirm.mockRestore();
  });

  it('asks a simple question for a single-site event and shows the failure in the row', async () => {
    seed('superuser');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<CompanyEventsRow isExpanded />);

    fireEvent.click(screen.getByTitle('Delete company event'));
    expect(confirm).toHaveBeenCalledWith('Delete this company event?');
    expect(deleteCompanyEvent).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    vi.mocked(deleteCompanyEvent).mockRejectedValue(new Error('nope'));
    fireEvent.click(screen.getByTitle('Delete company event'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to delete company event');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    confirm.mockRestore();
    err.mockRestore();
  });
});
