/**
 * The Bank Holidays and Company Events rows also render in the Gantt's embedded
 * staff overview. Their Settings-hub shortcuts (Add, click-to-edit) are out of
 * reach during What-If — the hub cannot open then — and so is deleting an
 * entry: holidays and events are not in the What-If snapshot, so a queued
 * DELETE would leave the row on screen and could not be undone by Discard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BankHolidaysRow } from '../BankHolidaysRow';
import { CompanyEventsRow } from '../CompanyEventsRow';
import { resetAllStores, useAppStore, useUIStore } from '@/stores';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { deleteCustomHoliday, deleteCompanyEvent, getCompanyEvents } from '@/api';
import { makeSite, makeUser } from '@/test/factories';
import { stubConfirm } from '@/test/confirmDialog';
import type { BankHoliday, CompanyEvent } from '@/types';

vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api')>()),
  deleteCustomHoliday: vi.fn(),
  getBankHolidays: vi.fn(),
  deleteCompanyEvent: vi.fn(),
  getCompanyEvents: vi.fn(),
}));

const holidays: BankHoliday[] = [
  { id: 1, site_id: 1, date: '2026-08-01', name: 'National Day', is_custom: false },
];

const events: CompanyEvent[] = [
  { id: 11, site_id: 1, site_ids: [1], date: '2026-05-04', name: 'Audit', counts_as_unavailable: false },
];

beforeEach(() => {
  resetAllStores();
  useAppStore.setState({
    currentSite: makeSite({ id: 1, name: 'Basel' }),
    currentUser: makeUser({ role: 'superuser' }),
    bankHolidays: holidays,
    companyEvents: events,
  });
});

afterEach(async () => {
  if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
});

describe.each([
  {
    name: 'BankHolidaysRow',
    renderRow: () => render(<BankHolidaysRow isExpanded />),
    addLabel: 'Add custom holiday',
    addHint: whatIfUnavailableMessage('Adding holidays'),
    editHint: whatIfUnavailableMessage('Editing holidays in Settings'),
    entry: 'National Day',
    deleteTitle: 'Delete holiday (returns on the next Nager refresh)',
    deleteHint: whatIfUnavailableMessage('Deleting holidays'),
    deleteApi: deleteCustomHoliday,
  },
  {
    name: 'CompanyEventsRow',
    renderRow: () => render(<CompanyEventsRow isExpanded />),
    addLabel: 'Add company event',
    addHint: whatIfUnavailableMessage('Adding company events'),
    editHint: whatIfUnavailableMessage('Editing company events in Settings'),
    entry: 'Audit',
    deleteTitle: 'Delete company event',
    deleteHint: whatIfUnavailableMessage('Deleting company events'),
    deleteApi: deleteCompanyEvent,
  },
])('$name during What-If', ({ renderRow, addLabel, addHint, editHint, entry, deleteTitle, deleteHint, deleteApi }) => {
  it('disables Add, the edit shortcut and delete', () => {
    const confirmSpy = stubConfirm(true);
    useWhatIfStore.getState().enterWhatIfMode([]);
    renderRow();

    const add = screen.getByRole('button', { name: addLabel });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', addHint);
    fireEvent.click(add);

    const addRow = screen.getByText(addLabel).parentElement as HTMLElement;
    expect(addRow).toHaveAttribute('aria-disabled', 'true');
    expect(addRow).toHaveAttribute('title', addHint);
    fireEvent.click(addRow);

    const chip = screen.getByText(entry).parentElement as HTMLElement;
    expect(chip).toHaveAttribute('title', editHint);
    fireEvent.click(chip);

    expect(useUIStore.getState().activeModal).toBeNull();

    expect(screen.queryByTitle(deleteTitle)).toBeNull();
    const del = screen.getByTitle(deleteHint);
    expect(del).toBeDisabled();
    fireEvent.click(del);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(deleteApi).not.toHaveBeenCalled();
  });

  it('offers the shortcuts again once What-If ends', () => {
    renderRow();
    const add = screen.getByRole('button', { name: addLabel });
    expect(add).toBeEnabled();
    expect(add).toHaveAttribute('title', addLabel);
    expect(screen.getByText(addLabel).parentElement).not.toHaveAttribute('aria-disabled');
    const chip = screen.getByText(entry).parentElement as HTMLElement;
    expect(chip).toHaveAttribute('title', 'Edit in Settings');
    fireEvent.click(chip);
    expect(useUIStore.getState().activeModal).toBe('settingsHub');
    expect(screen.getByTitle(deleteTitle)).toBeEnabled();
  });
});

describe('CompanyEventsRow outside What-If', () => {
  it('deletes a legacy event without site links as a single-site event', async () => {
    const legacy = { id: 12, site_id: 1, date: '2026-06-01', name: 'Legacy audit', counts_as_unavailable: false } as CompanyEvent;
    useAppStore.setState({ companyEvents: [legacy] });
    vi.mocked(deleteCompanyEvent).mockResolvedValue(undefined as never);
    vi.mocked(getCompanyEvents).mockResolvedValue([]);
    const confirmSpy = stubConfirm(true);
    render(<CompanyEventsRow isExpanded />);

    const del = screen.getByTitle('Delete company event');
    expect(del).toBeEnabled();
    fireEvent.click(del);

    expect(confirmSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Delete this company event?' })
    );
    await waitFor(() => expect(useAppStore.getState().companyEvents).toEqual([]));
    expect(deleteCompanyEvent).toHaveBeenCalledWith(1, 12);
  });
});
