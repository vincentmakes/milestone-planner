/**
 * Settings › Bank holidays, day-to-day flows: per-site, per-year list with
 * sources, add / edit (a Nager holiday becomes custom) with validation,
 * delete (custom vs Nager wording), refresh from Nager, .ics export,
 * intents from other views (add / edit a given holiday), site switching,
 * the import view with its target sites, and a superuser's site scope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { BankHolidaysPanel } from '../panels/BankHolidaysPanel';
import { resetAllStores, useAppStore, useUIStore, useWhatIfStore } from '@/stores';
import { downloadICS } from '@/utils/ics';
import { makeSite, makeUser } from '@/test/factories';
import type { BankHoliday } from '@/types';

const api = vi.hoisted(() => ({
  getBankHolidays: vi.fn(),
  createBankHoliday: vi.fn(),
  updateBankHoliday: vi.fn(),
  deleteBankHoliday: vi.fn(),
  importBankHolidays: vi.fn(),
  refreshBankHolidays: vi.fn(),
  buildHolidayDateSet: vi.fn(() => new Set<string>()),
}));
vi.mock('@/api', () => api);
vi.mock('@/utils/ics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/ics')>()),
  downloadICS: vi.fn(),
}));

const YEAR = new Date().getFullYear();
const basel = makeSite({ id: 1, name: 'Basel', country_code: 'CH' });
const zurich = makeSite({ id: 2, name: 'Zurich', country_code: null as never });

const nationalDay: BankHoliday = { id: 1, site_id: 1, date: `${YEAR}-08-01`, name: 'National Day', is_custom: false };
const shutdown: BankHoliday = {
  id: 2,
  site_id: 1,
  date: `${YEAR}-12-24`,
  end_date: `${YEAR}-12-31`,
  name: 'Lab shutdown',
  is_custom: true,
};
const oldOne: BankHoliday = { id: 3, site_id: 1, date: `${YEAR - 1}-05-01`, name: 'Labour Day', is_custom: false };

const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

beforeEach(() => {
  resetAllStores();
  for (const fn of Object.values(api)) fn.mockReset();
  api.buildHolidayDateSet.mockReturnValue(new Set());
  api.getBankHolidays.mockImplementation(async (siteId: number) =>
    siteId === 1 ? [shutdown, nationalDay, oldOne] : []
  );
  vi.mocked(downloadICS).mockReset();
  useAppStore.setState({
    currentUser: makeUser({ role: 'admin' }),
    sites: [basel, zurich],
    currentSite: basel,
  });
});

async function renderPanel() {
  const utils = render(<BankHolidaysPanel />);
  await screen.findByText('National Day');
  return utils;
}

describe('BankHolidaysPanel list', () => {
  it("shows this year's holidays sorted, with their source and multi-day end", async () => {
    await renderPanel();
    const names = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[2].textContent);
    expect(names).toEqual(['National Day', 'Lab shutdown']);
    expect(within(rowOf('National Day')).getByText('Nager')).toBeInTheDocument();
    expect(within(rowOf('Lab shutdown')).getByText('Custom')).toBeInTheDocument();
    expect(within(rowOf('National Day')).getAllByRole('cell')[1]).toHaveTextContent('—');
    expect(within(rowOf('Lab shutdown')).getAllByRole('cell')[1]).not.toHaveTextContent('—');

    fireEvent.change(screen.getByLabelText('Year'), { target: { value: 'all' } });
    expect(screen.getByText('Labour Day')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: String(YEAR - 1) } });
    expect(screen.queryByText('National Day')).not.toBeInTheDocument();
  });

  it('switches site, showing the empty state and disabling Nager without a country', async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Site'), { target: { value: '2' } });
    expect(
      await screen.findByText('No holidays for this site yet. Add one, import an .ics file or refresh from Nager.')
    ).toBeInTheDocument();
    expect(api.getBankHolidays).toHaveBeenLastCalledWith(2);
    const refresh = screen.getByRole('button', { name: /Refresh from Nager/ });
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAttribute('title', "Set the site's country in Sites first");
    expect(screen.getByRole('button', { name: /Export .ics/ })).toBeDisabled();
  });

  it('reports a failed load', async () => {
    api.getBankHolidays.mockRejectedValue(new Error('Forbidden'));
    render(<BankHolidaysPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden');
  });

  it('only offers a superuser their own sites', async () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'superuser', site_ids: [2] }), currentSite: basel });
    render(<BankHolidaysPanel />);
    await waitFor(() => expect(api.getBankHolidays).toHaveBeenCalledWith(2));
    const options = within(screen.getByLabelText('Site')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Zurich']);
  });

  it('picks a site once the sites arrive after opening', async () => {
    useAppStore.setState({ sites: [] });
    render(<BankHolidaysPanel />);
    expect(screen.getByText('You are not assigned to any site.')).toBeInTheDocument();

    act(() => useAppStore.setState({ sites: [basel, zurich] }));
    await screen.findByText('National Day');
    expect(screen.getByLabelText('Site')).toHaveValue('1');
  });

  it('says so when the user manages no site', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'superuser', site_ids: [] }) });
    render(<BankHolidaysPanel />);
    expect(screen.getByText('You are not assigned to any site.')).toBeInTheDocument();
  });

  it('shows the What-If notice', async () => {
    useWhatIfStore.setState({ whatIfMode: true });
    await renderPanel();
    expect(screen.getByText(/What-If mode is active: holiday changes are queued/)).toBeInTheDocument();
  });
});

describe('BankHolidaysPanel add and edit', () => {
  it('validates and adds a multi-day holiday, then reloads the site and the store', async () => {
    api.createBankHoliday.mockResolvedValue({});
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add holiday' }));
    expect(screen.getByText('Add a holiday to Basel')).toBeInTheDocument();
    const submit = () =>
      fireEvent.click(
        within(screen.getByText('Add a holiday to Basel').closest('form')!).getByRole('button', { name: 'Add holiday' })
      );

    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a name');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Company Day ' } });
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('Please select a date');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: `${YEAR}-06-10` } });
    fireEvent.change(screen.getByLabelText('End date (optional)'), { target: { value: `${YEAR}-06-01` } });
    // noValidate: the button reaches the panel's own check despite the end input's min
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent('End date must be on or after the start date');

    fireEvent.change(screen.getByLabelText('End date (optional)'), { target: { value: `${YEAR}-06-11` } });
    submit();
    await waitFor(() =>
      expect(api.createBankHoliday).toHaveBeenCalledWith(1, {
        name: 'Company Day',
        date: `${YEAR}-06-10`,
        end_date: `${YEAR}-06-11`,
      })
    );
    await waitFor(() => expect(screen.queryByText('Add a holiday to Basel')).not.toBeInTheDocument());
    // panel list + current-site store refresh
    expect(api.getBankHolidays.mock.calls.filter(([id]) => id === 1).length).toBeGreaterThanOrEqual(3);
  });

  it('edits a Nager holiday, explaining it becomes custom, and clears its end date', async () => {
    api.updateBankHoliday.mockResolvedValue({});
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Edit National Day' }));
    expect(screen.getByText(/This holiday comes from Nager/)).toBeInTheDocument();
    expect(rowOf('National Day').className).toMatch(/highlight/);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Swiss National Day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.updateBankHoliday).toHaveBeenCalledWith(1, 1, {
        name: 'Swiss National Day',
        date: `${YEAR}-08-01`,
        end_date: null,
      })
    );
  });

  it('shows a save error and can be cancelled', async () => {
    api.updateBankHoliday.mockRejectedValue(new Error('Duplicate'));
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lab shutdown' }));
    expect(screen.getByLabelText('End date (optional)')).toHaveValue(`${YEAR}-12-31`);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Duplicate')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Edit holiday')).not.toBeInTheDocument();
  });

  it('opens the add form from an intent', async () => {
    useUIStore.setState({ settingsIntent: { type: 'add', siteId: 2 } });
    render(<BankHolidaysPanel />);
    expect(await screen.findByText('Add a holiday to Zurich')).toBeInTheDocument();
    expect(useUIStore.getState().settingsIntent).toBeNull();
  });

  it('opens the edit form for a holiday from an intent, on its year', async () => {
    useUIStore.setState({ settingsIntent: { type: 'edit', id: 3, siteId: 1 } });
    render(<BankHolidaysPanel />);
    expect(await screen.findByText('Edit holiday')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Labour Day');
    expect(screen.getByLabelText('Year')).toHaveValue(String(YEAR - 1));
  });
});

describe('BankHolidaysPanel delete, refresh, export', () => {
  it('words the delete by source and does nothing when cancelled', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Delete National Day' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toMatch(/comes from Nager, so it will return/);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Lab shutdown' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[1][0]).toBe('Delete the holiday "Lab shutdown"?');
    expect(api.deleteBankHoliday).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('deletes, closing the form of that holiday, and reports failures', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.deleteBankHoliday.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Gone'));
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lab shutdown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Lab shutdown' }));
    await waitFor(() => expect(api.deleteBankHoliday).toHaveBeenCalledWith(1, 2));
    await waitFor(() => expect(screen.queryByText('Edit holiday')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete National Day' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Gone');
    confirm.mockRestore();
  });

  it('refreshes from Nager after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    api.refreshBankHolidays.mockResolvedValueOnce([nationalDay]).mockRejectedValueOnce(new Error('Nager down'));
    await renderPanel();
    const refresh = screen.getByRole('button', { name: /Refresh from Nager/ });

    fireEvent.click(refresh);
    expect(api.refreshBankHolidays).not.toHaveBeenCalled();

    fireEvent.click(refresh);
    expect(await screen.findByText('Holidays refreshed from Nager (1 in total).')).toBeInTheDocument();
    expect(screen.queryByText('Lab shutdown')).not.toBeInTheDocument();

    fireEvent.click(refresh);
    expect(await screen.findByRole('alert')).toHaveTextContent('Nager down');
    confirm.mockRestore();
  });

  it('exports the visible year as .ics', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Export .ics/ }));
    const [content, filename] = vi.mocked(downloadICS).mock.calls[0];
    expect(filename).toBe(`bank-holidays-Basel-${YEAR}.ics`);
    expect(content).toContain('SUMMARY:National Day');
    expect(content).not.toContain('Labour Day');

    fireEvent.change(screen.getByLabelText('Year'), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: /Export .ics/ }));
    expect(vi.mocked(downloadICS).mock.calls[1][1]).toBe('bank-holidays-Basel.ics');
  });
});

describe('BankHolidaysPanel import view', () => {
  it('targets the shown site, loads other targets for duplicate checks and goes back', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Import .ics/ }));
    expect(screen.getByText('Import holidays into Basel')).toBeInTheDocument();

    const zurichBox = screen.getByRole('checkbox', { name: 'Zurich' });
    fireEvent.click(zurichBox);
    await waitFor(() => expect(api.getBankHolidays).toHaveBeenCalledWith(2));
    expect(screen.getByText('Import holidays into Basel, Zurich')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Basel' }));
    fireEvent.click(zurichBox);
    expect(screen.getByText('Import holidays')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Back to holidays/ }));
    expect(screen.getByText('National Day')).toBeInTheDocument();
  });
});
