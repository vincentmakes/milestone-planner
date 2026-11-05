/**
 * Settings › General › Audit log: the rows of GET /audit-log, every filter's
 * request parameter (and the reset to page 1), numbered paging, Refresh, the
 * CSV export through downloadFile, the retention chip and the Entry detail
 * dialog. The API client is mocked at its edge, so the URLs are the real ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as client from '@/api/client';
import { useAppStore } from '@/stores/appStore';
import { makeUser } from '@/test/factories';
import { pickDate } from '@/test/datePicker';
import { optionLabel, pickerOptions, pickOption } from '@/test/searchableSelect';
import { formatDateISO, formatDateTime } from '@/utils/date';
import type { AuditLogEntry, AuditLogPage } from '@/types';
import { AuditLogPanel } from '../AuditLogPanel';

vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  apiGet: vi.fn(),
  downloadFile: vi.fn(),
}));

const apiGet = vi.mocked(client.apiGet);
const downloadFile = vi.mocked(client.downloadFile);

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 1,
    created_at: '2026-11-03T08:00:00.000Z',
    category: 'auth',
    action: 'auth.login.failed',
    outcome: 'failure',
    actor_user_id: 7,
    actor_email: 'grace@demo.local',
    actor_name: 'Grace Hopper',
    subject_email: 'grace@demo.local',
    target_type: null,
    target_id: null,
    target_label: null,
    project_id: null,
    project_name: null,
    ip: '203.0.113.7',
    user_agent: 'Mozilla/5.0',
    origin: 'web',
    details: { reason: 'bad_password' },
    ...overrides,
  };
}

const LOGIN_FAILED = entry();
const USER_UPDATED = entry({
  id: 2,
  category: 'admin',
  action: 'admin.user.updated',
  outcome: 'success',
  subject_email: null,
  target_type: 'user',
  target_id: '9',
  target_label: 'Bob Brown',
  ip: null,
  details: {
    changes: {
      role: { old: 'user', new: 'superuser' },
      client_secret: { old: '***', new: '***' },
      header_logo_dark: { old: null, new: { changed: true, length: 250 } },
    },
    context: { sessions_revoked: true },
  },
});
const BOOKING_DELETED = entry({
  id: 3,
  category: 'change',
  action: 'staff_assignment.deleted',
  outcome: 'success',
  actor_user_id: null,
  actor_email: null,
  actor_name: null,
  subject_email: null,
  target_type: 'staff_assignment',
  target_id: '12',
  target_label: null,
  ip: null,
  user_agent: null,
  origin: 'system',
  details: null,
});

let page: AuditLogPage;
let actions: string[];
let listError: Error | null;

function respond(url: string): Promise<unknown> {
  if (url === '/api/audit-log/actions') return Promise.resolve({ actions });
  if (url.startsWith('/api/users')) {
    return Promise.resolve({
      items: [makeUser({ id: 11, first_name: 'Ada', last_name: 'Admin', name: 'Ada Admin' })],
    });
  }
  if (url.startsWith('/api/audit-log')) return listError ? Promise.reject(listError) : Promise.resolve(page);
  return Promise.reject(new Error(`unexpected ${url}`));
}

const listUrls = () =>
  apiGet.mock.calls.map(([url]) => url as string).filter((url) => /^\/api\/audit-log(\?|$)/.test(url));

/** The parameters of the last list request. */
function lastParams(): Record<string, string> {
  const urls = listUrls();
  const url = urls[urls.length - 1] ?? '';
  return Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? ''));
}

async function renderPanel() {
  render(<AuditLogPanel />);
  await waitFor(() => expect(listUrls().length).toBeGreaterThan(0));
  await screen.findByRole('navigation', { name: 'Pagination' });
}

/** Render with 120 entries and go to page 2, so a reset to page 1 shows. */
async function renderOnPageTwo() {
  page = { items: [LOGIN_FAILED, USER_UPDATED], total: 120, page: 1, page_size: 50 };
  await renderPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await waitFor(() => expect(lastParams().page).toBe('2'));
}

describe('AuditLogPanel', () => {
  beforeEach(() => {
    page = { items: [LOGIN_FAILED, USER_UPDATED, BOOKING_DELETED], total: 3, page: 1, page_size: 50 };
    actions = ['admin.user.updated', 'auth.login.failed', 'staff_assignment.deleted'];
    listError = null;
    apiGet.mockReset().mockImplementation((url: string) => respond(url) as never);
    downloadFile.mockReset().mockResolvedValue(undefined);
    useAppStore.setState({
      currentUser: makeUser({ role: 'admin' }),
      users: [],
      instanceSettings: { audit_log_retention_days: '365' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the rows of the first page with their labels, chips and counts', async () => {
    await renderPanel();

    expect(
      screen.getByText(/^Sign-ins and sign-outs, failed and locked-out attempts, user and settings changes/)
    ).toBeInTheDocument();
    expect(lastParams()).toEqual({ page: '1', page_size: '50' });
    expect(screen.getByText('1–3 of 3')).toBeInTheDocument();

    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual([
      'When',
      'Category',
      'Action',
      'Outcome',
      'Actor',
      'Account',
      'Target',
      'IP address',
    ]);
    // Eight columns, fixed widths: the origin is in the entry detail only.
    expect(table.querySelectorAll('colgroup col')).toHaveLength(8);
    const [, failedRow, updatedRow, bookingRow] = within(table).getAllByRole('row');
    expect(within(failedRow).getByText('Sign-in failed')).toHaveAttribute('title', 'auth.login.failed');
    expect(within(failedRow).getByText('Authentication')).toBeInTheDocument();
    expect(within(failedRow).getByText('Failure')).toBeInTheDocument();
    expect(within(failedRow).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(failedRow).getByText('203.0.113.7').tagName).toBe('CODE');
    expect(within(failedRow).queryByText('Web')).not.toBeInTheDocument();
    // When, without seconds; the free-text cells carry their full text as a title.
    expect(within(failedRow).getByText(formatDateTime(LOGIN_FAILED.created_at))).toBeInTheDocument();
    expect(within(failedRow).getByTitle('Grace Hopper')).toHaveTextContent('Grace Hopper');
    expect(within(failedRow).getByTitle('203.0.113.7')).toBeInTheDocument();
    expect(within(updatedRow).getByText('User updated')).toBeInTheDocument();
    expect(within(updatedRow).getByText('Administration')).toBeInTheDocument();
    expect(within(updatedRow).getByText('User · Bob Brown')).toBeInTheDocument();
    expect(within(bookingRow).getByText('Booking deleted')).toBeInTheDocument();
    expect(within(bookingRow).getByText('Changes')).toBeInTheDocument();
    expect(within(bookingRow).getByText('Booking · #12')).toBeInTheDocument();
    expect(within(bookingRow).queryByText('System')).not.toBeInTheDocument();
    expect(within(bookingRow).getAllByText('—')).toHaveLength(3); // actor, account, IP
  });

  it('shows the retention window from the settings: 365 days, or indefinitely for 0', async () => {
    await renderPanel();
    const chip = screen.getByText('Kept 365 days');
    expect(chip).toHaveAttribute(
      'title',
      'Entries older than the retention window are deleted. Change the window under Settings → General.'
    );

    act(() => useAppStore.setState({ instanceSettings: { audit_log_retention_days: '0' } }));
    expect(screen.getByText('Kept indefinitely')).toBeInTheDocument();
    expect(screen.queryByText('Kept 365 days')).not.toBeInTheDocument();

    act(() => useAppStore.setState({ instanceSettings: null }));
    expect(screen.getByText('Kept 365 days')).toBeInTheDocument();
  });

  it('reads "No entries" and "Nothing recorded yet." for an empty log', async () => {
    page = { items: [], total: 0, page: 1, page_size: 50 };
    actions = [];
    await renderPanel();
    expect(screen.getByText('No entries')).toBeInTheDocument();
    expect(screen.getByText('Nothing recorded yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeDisabled();
    expect(pickerOptions(/^Action/).map(optionLabel)).toEqual(['Any action']);
    expect(screen.getByRole('status')).toHaveTextContent('Nothing recorded yet');
  });

  it('shows the load error in a Notice', async () => {
    listError = new Error('Permission required: system.audit_log');
    render(<AuditLogPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission required: system.audit_log');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('falls back to a fixed message for an error without one', async () => {
    listError = new Error('');
    render(<AuditLogPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the audit log.');
  });

  it('pages with First / Previous / Next / Last and the per-page select', async () => {
    page = { items: [LOGIN_FAILED, USER_UPDATED], total: 120, page: 1, page_size: 50 };
    await renderPanel();
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toHaveTextContent('Page 1 of 3');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    await waitFor(() => expect(lastParams().page).toBe('3'));
    expect(screen.getByText('101–102 of 120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(lastParams().page).toBe('2'));
    fireEvent.click(screen.getByRole('button', { name: 'First page' }));
    await waitFor(() => expect(lastParams().page).toBe('1'));

    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    await waitFor(() => expect(lastParams().page).toBe('3'));
    fireEvent.change(screen.getByLabelText('Per page'), { target: { value: '25' } });
    await waitFor(() => expect(lastParams()).toEqual({ page: '1', page_size: '25' }));
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toHaveTextContent('Page 1 of 5');
  });

  it('goes back to the last page when the total shrinks below the current one', async () => {
    page = { items: [LOGIN_FAILED], total: 120, page: 1, page_size: 50 };
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    await waitFor(() => expect(lastParams().page).toBe('3'));
    page = { items: [], total: 60, page: 3, page_size: 50 };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(lastParams().page).toBe('2'));
  });

  it('goes back to "Page 1 of 1" when every entry is gone', async () => {
    page = { items: [LOGIN_FAILED], total: 120, page: 1, page_size: 50 };
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    await waitFor(() => expect(lastParams().page).toBe('3'));
    page = { items: [], total: 0, page: 3, page_size: 50 };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(lastParams().page).toBe('1'));
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toHaveTextContent('Page 1 of 1');
  });

  it('filters by category and outcome, back on page 1', async () => {
    await renderOnPageTwo();
    fireEvent.click(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'Authentication' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ category: 'auth', page: '1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastParams().page).toBe('2'));
    fireEvent.click(within(screen.getByRole('group', { name: 'Outcome' })).getByRole('button', { name: 'Failure' }));
    await waitFor(() => expect(lastParams()).toMatchObject({ category: 'auth', outcome: 'failure', page: '1' }));

    fireEvent.click(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'All' }));
    await waitFor(() => expect(lastParams().category).toBeUndefined());
  });

  it('filters by action and actor through their pickers', async () => {
    await renderOnPageTwo();
    expect(pickerOptions(/^Action/).map(optionLabel)).toEqual([
      'Any action',
      'User updated',
      'Sign-in failed',
      'Booking deleted',
    ]);
    pickOption(/^Action/, 'Sign-in failed');
    await waitFor(() => expect(lastParams()).toMatchObject({ action: 'auth.login.failed', page: '1' }));

    // The accounts (users.view) and the actors of the rows held.
    await waitFor(() => expect(pickerOptions(/^Actor/).map(optionLabel)).toContain('Ada Admin'));
    expect(pickerOptions(/^Actor/).map(optionLabel)).toEqual(['Anyone', 'Ada Admin', 'Grace Hopper']);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastParams().page).toBe('2'));
    pickOption(/^Actor/, 'Grace Hopper');
    await waitFor(() => expect(lastParams()).toMatchObject({ actor_user_id: '7', page: '1' }));

    pickOption(/^Action/, 'Any action');
    await waitFor(() => expect(lastParams().action).toBeUndefined());
  });

  it('debounces the search and IP address fields', async () => {
    await renderOnPageTwo();
    const before = listUrls().length;
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'grace' } });
    expect(screen.getByLabelText('Search')).toHaveAttribute('placeholder', 'Email, name or target…');
    expect(listUrls()).toHaveLength(before);
    await waitFor(() => expect(lastParams()).toMatchObject({ q: 'grace', page: '1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastParams().page).toBe('2'));
    fireEvent.change(screen.getByLabelText('IP address'), { target: { value: ' 203.0.113.7 ' } });
    expect(screen.getByLabelText('IP address')).toHaveAttribute('placeholder', 'e.g. 203.0.113.7');
    await waitFor(() => expect(lastParams()).toMatchObject({ q: 'grace', ip: '203.0.113.7', page: '1' }));
  });

  it('ignores a change of surrounding spaces only, and caps the two fields at the server limits', async () => {
    await renderOnPageTwo();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'grace' } });
    await waitFor(() => expect(lastParams()).toMatchObject({ q: 'grace', page: '1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastParams().page).toBe('2'));
    const before = listUrls().length;

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'grace  ' } });
    fireEvent.change(screen.getByLabelText('IP address'), { target: { value: '   ' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400)); // past the debounce
    });
    expect(listUrls()).toHaveLength(before); // no reload, still on page 2
    expect(lastParams().page).toBe('2');

    expect(screen.getByLabelText('Search')).toHaveAttribute('maxlength', '200');
    expect(screen.getByLabelText('IP address')).toHaveAttribute('maxlength', '45');
  });

  it('filters From / To days, and Clear filters resets everything', async () => {
    const today = formatDateISO(new Date());
    await renderOnPageTwo();
    pickDate('From', today);
    await waitFor(() => expect(lastParams()).toMatchObject({ since: today, page: '1' }));
    pickDate('To', today);
    await waitFor(() => expect(lastParams()).toMatchObject({ since: today, until: today }));

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'bob' } });
    await waitFor(() => expect(lastParams().q).toBe('bob'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(lastParams()).toEqual({ page: '1', page_size: '50' }));
    expect(screen.getByLabelText('Search')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeDisabled();
  });

  it('says when no entry matches the filters', async () => {
    await renderPanel();
    page = { items: [], total: 0, page: 1, page_size: 50 };
    fireEvent.click(within(screen.getByRole('group', { name: 'Outcome' })).getByRole('button', { name: 'Success' }));
    expect(await screen.findByText('No entries match the current filters.')).toBeInTheDocument();
    expect(screen.getByText('No entries')).toBeInTheDocument();
  });

  it('re-fetches the page and the actions on Refresh', async () => {
    await renderPanel();
    const lists = listUrls().length;
    const actionCalls = () => apiGet.mock.calls.filter(([url]) => url === '/api/audit-log/actions').length;
    const actionsBefore = actionCalls();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(listUrls().length).toBe(lists + 1));
    expect(actionCalls()).toBe(actionsBefore + 1);
  });

  it('exports the current filters through downloadFile, "Exporting…" meanwhile', async () => {
    let finish: () => void = () => {};
    downloadFile.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    await renderOnPageTwo();
    fireEvent.click(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'Administration' }));
    await waitFor(() => expect(lastParams().category).toBe('admin'));
    const lists = listUrls().length;

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const busy = await screen.findByRole('button', { name: 'Exporting…' });
    expect(busy).toBeDisabled();
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(downloadFile).toHaveBeenCalledWith('/api/audit-log/export?category=admin', 'audit-log.csv');

    await act(async () => finish());
    expect(await screen.findByRole('button', { name: 'Export CSV' })).toBeEnabled();
    // The export is recorded: the list reloads to show it.
    await waitFor(() => expect(listUrls().length).toBe(lists + 1));
    expect(screen.queryByText('Export failed.')).not.toBeInTheDocument();
  });

  it('shows "Export failed." when the download fails, dismissable', async () => {
    downloadFile.mockRejectedValue(new Error('HTTP 500'));
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Export failed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('Export failed.')).not.toBeInTheDocument();
  });

  it('opens the entry detail on a row click: label, raw key, chips and reason', async () => {
    await renderPanel();
    fireEvent.click(screen.getByText('Sign-in failed'));

    const dialog = screen.getByRole('dialog', { name: 'Entry detail' });
    expect(within(dialog).getByText('Sign-in failed')).toBeInTheDocument();
    expect(within(dialog).getByText('auth.login.failed').tagName).toBe('CODE');
    expect(within(dialog).getByText('Authentication')).toBeInTheDocument();
    expect(within(dialog).getByText('Failure')).toBeInTheDocument();
    expect(within(dialog).getByText('Web')).toBeInTheDocument();
    expect(within(dialog).getByText('Wrong password (bad_password)')).toBeInTheDocument();
    expect(within(dialog).getByText('Mozilla/5.0')).toBeInTheDocument();
    expect(within(dialog).getByText('No further details recorded.')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Entry detail' })).not.toBeInTheDocument();
  });

  it('shows the changes with a masked and a long value, and the context, from the row button', async () => {
    await renderPanel();
    const row = screen.getByText('User updated').closest('tr') as HTMLElement;
    // The keyboard path: a native button (Enter and Space press it), named for the dialog it opens.
    const open = within(row).getByRole('button', {
      name: `Open entry detail: User updated, ${formatDateTime(USER_UPDATED.created_at)}`,
    });
    expect(open.tagName).toBe('BUTTON');
    expect(open).toHaveAttribute('aria-haspopup', 'dialog');
    expect(row).not.toHaveAttribute('tabindex'); // one tab stop per row: the button
    open.focus();
    fireEvent.click(open);

    const dialog = screen.getByRole('dialog', { name: 'Entry detail' });
    expect(within(dialog).getByText('admin.user.updated')).toBeInTheDocument();
    expect(within(dialog).getByText('User · Bob Brown')).toBeInTheDocument();
    expect(within(dialog).queryByText(/^Reason$/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Details' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Changes' })).toBeInTheDocument();

    const changes = within(dialog).getAllByRole('table')[0];
    expect(within(changes).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Field',
      'Before',
      'After',
    ]);
    const [, roleRow, secretRow, logoRow] = within(changes).getAllByRole('row');
    expect(roleRow).toHaveTextContent('Roleusersuperuser');
    expect(within(secretRow).getByText('Client secret')).toHaveAttribute('title', 'client_secret');
    expect(within(secretRow).getAllByText('Secret value')).toHaveLength(2);
    expect(within(logoRow).getByText('—')).toBeInTheDocument();
    expect(within(logoRow).getByText('changed (250 characters)')).toBeInTheDocument();

    expect(within(dialog).getByRole('heading', { name: 'Context' })).toBeInTheDocument();
    expect(within(dialog).getByText('Sessions revoked')).toBeInTheDocument();
    expect(within(dialog).getByText('Yes')).toBeInTheDocument();
    expect(within(dialog).queryByText('No further details recorded.')).not.toBeInTheDocument();

    // Escape closes; one click (the button's, bubbling to the row) opened one dialog.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Entry detail' })).not.toBeInTheDocument();
  });

  it('shows a project, items and an actor without a name in the entry detail', async () => {
    page = {
      items: [
        entry({
          id: 5,
          category: 'access',
          action: 'access.export.csv',
          outcome: 'success',
          actor_name: null,
          actor_email: 'robot@demo.local',
          subject_email: null,
          target_type: 'project',
          target_id: '4',
          target_label: 'Alpha',
          project_id: 4,
          project_name: null,
          ip: null,
          user_agent: null,
          details: { items: [{ name: 'Task A', rows: 2 }], context: { rows: 2 } },
        }),
      ],
      total: 1,
      page: 1,
      page_size: 50,
    };
    await renderPanel();
    fireEvent.click(screen.getByText('CSV exported'));
    const dialog = screen.getByRole('dialog', { name: 'Entry detail' });
    expect(within(dialog).getByText('Data access')).toBeInTheDocument();
    expect(within(dialog).getByText('robot@demo.local')).toBeInTheDocument();
    expect(within(dialog).getByText('#4')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Items' })).toBeInTheDocument();
    expect(within(dialog).getByText('Name: Task A · Rows: 2')).toBeInTheDocument();
  });

  it('ignores an answer overtaken by a newer request', async () => {
    let first: (value: AuditLogPage) => void = () => {};
    apiGet.mockImplementation((url: string) => {
      if (/^\/api\/audit-log\?/.test(url) && !url.includes('outcome')) {
        return new Promise((resolve) => (first = resolve)) as never;
      }
      return respond(url) as never;
    });
    render(<AuditLogPanel />);
    await waitFor(() => expect(listUrls().length).toBe(1));
    fireEvent.click(within(screen.getByRole('group', { name: 'Outcome' })).getByRole('button', { name: 'Success' }));
    expect(await screen.findByText('1–3 of 3')).toBeInTheDocument();
    await act(async () => first({ items: [], total: 0, page: 1, page_size: 50 }));
    expect(screen.getByText('1–3 of 3')).toBeInTheDocument();
  });

  it('keeps the actors of the rows when the accounts cannot be listed', async () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'x', permissions: ['system.audit_log'] }) });
    await renderPanel();
    expect(apiGet.mock.calls.some(([url]) => (url as string).startsWith('/api/users'))).toBe(false);
    expect(pickerOptions(/^Actor/).map(optionLabel)).toEqual(['Anyone', 'Grace Hopper']);
  });

  it('uses the users already in the store', async () => {
    useAppStore.setState({ users: [makeUser({ id: 21, name: 'Store Person', first_name: 'Store', last_name: 'Person' })] });
    await renderPanel();
    expect(apiGet.mock.calls.some(([url]) => (url as string).startsWith('/api/users'))).toBe(false);
    expect(pickerOptions(/^Actor/).map(optionLabel)).toEqual(['Anyone', 'Grace Hopper', 'Store Person']);
  });
});
