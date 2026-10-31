/**
 * Settings › Project fields:
 * - One list with two switch columns under a header, "In project dialog" and
 *   "In Gantt details": the four built-in fields (a label each, Volume a
 *   Format; Confirmed always in the dialog), then the rows that are only in
 *   the Gantt details (PM and Tags always in the dialog, the others not
 *   dialog fields), then the custom fields (always in the dialog).
 * - Every switch, the Format and a label (on blur or Enter; Escape reverts)
 *   apply at once: the store first, then one PUT per setting at a time in
 *   canonical form, "Saving…" then "Saved" in the status. Hiding a field
 *   also takes it out of the Gantt details. A failure shows inline and
 *   reloads the settings.
 * - Custom fields: listed in order with their type, added with a type,
 *   renamed in the row's edit form, reordered by drag, deleted after a confirm
 *   naming how many projects lose a value.
 * - Number fields: a Format picker (As typed / 1 / 1.0 / 1.00 / 1.000) with a
 *   live preview, in the add row and the row's edit form (saved with its
 *   Save); the type pill names the format.
 * - Items of a dropdown field: added, edited (colour, sites, teams — the tag
 *   edit row's controls), reordered and deleted.
 * - One dirty flag for the hub: only unfinished adds and edits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import {
  CONFIRMED_HINT,
  CUSTOM_ALWAYS_HINT,
  FORMAT_AS_TYPED_PREVIEW,
  FORMAT_EXISTING_NOTE,
  HIDDEN_DETAILS_HINT,
  ProjectFieldsPanel,
} from '../panels/ProjectFieldsPanel';
import { useAppStore } from '@/stores/appStore';
import { stubConfirm } from '@/test/confirmDialog';
import { makeProjectField, makeProjectFieldOption, makeSite, makeTeam } from '@/test/factories';
import type { ProjectField } from '@/types';

const api = vi.hoisted(() => ({
  projectFieldsApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
    usage: vi.fn(),
    createOption: vi.fn(),
    updateOption: vi.fn(),
    removeOption: vi.fn(),
    reorderOptions: vi.fn(),
  },
  getInstanceSettings: vi.fn(),
  updateSetting: vi.fn(),
}));
vi.mock('@/api/endpoints/projectFields', () => ({ projectFieldsApi: api.projectFieldsApi }));
vi.mock('@/api/endpoints/settings', () => ({
  getInstanceSettings: api.getInstanceSettings,
  updateSetting: api.updateSetting,
}));
const { projectFieldsApi } = api;

const internal = makeProjectFieldOption({ id: 11, name: 'Internal', color: '#6366f1', sort_order: 0 });
const customer = makeProjectFieldOption({
  id: 12,
  name: 'Customer',
  color: '#0ea5e9',
  sort_order: 1,
  all_sites: false,
  site_ids: [2],
});
const FIELDS: ProjectField[] = [
  // Deliberately out of order: the panel sorts by sort_order
  makeProjectField({ id: 2, name: 'Budget', field_type: 'number', sort_order: 1 }),
  makeProjectField({ id: 1, name: 'Project type', field_type: 'select', sort_order: 0, options: [customer, internal] }),
  makeProjectField({ id: 3, name: 'Regulated', field_type: 'toggle', sort_order: 2 }),
];

const SITES = [makeSite({ id: 1, name: 'Basel' }), makeSite({ id: 2, name: 'Zurich' })];

/** What the server holds when the panel opens */
const SERVER_SETTINGS = {
  project_field_labels: '{"customer":"Client"}',
  project_fields_hidden: '["sales_pm"]',
};

beforeEach(() => {
  for (const fn of Object.values(projectFieldsApi)) fn.mockReset();
  api.getInstanceSettings.mockReset().mockResolvedValue(SERVER_SETTINGS);
  api.updateSetting.mockReset().mockResolvedValue({});
  projectFieldsApi.getAll.mockResolvedValue(FIELDS);
  useAppStore.setState({ sites: SITES, teams: [], projectFields: [], instanceSettings: { instance_title: 'Lab' } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function renderPanel(onDirtyChange = vi.fn()) {
  render(<ProjectFieldsPanel onDirtyChange={onDirtyChange} />);
  await screen.findByTestId('field-1');
  return onDirtyChange;
}

/** Drag `from` onto `to`; jsdom rects are all zero, so clientY 1 drops after `to` */
function dragOnto(from: HTMLElement, to: HTMLElement, clientY = 1) {
  const dataTransfer = { effectAllowed: '', setData: vi.fn() };
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragOver(to, { clientY, dataTransfer });
  fireEvent.drop(to, { dataTransfer });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const dialogSwitch = (name: string) => screen.getByRole('switch', { name: `Show ${name} in project dialog` });
const ganttSwitch = (name: string) => screen.getByRole('switch', { name: `Show ${name} in Gantt details` });
const stored = () => useAppStore.getState().instanceSettings;

describe('ProjectFieldsPanel — the list', () => {
  it('puts a header over the two switch columns, describing the switches under it', async () => {
    await renderPanel();
    const header = screen.getByTestId('pf-column-header');
    expect([...header.children].map((c) => c.textContent)).toEqual(['Field', 'In project dialog', 'In Gantt details', '']);
    expect(dialogSwitch('Customer')).toHaveAccessibleDescription('In project dialog');
    expect(ganttSwitch('Customer')).toHaveAccessibleDescription('In Gantt details');
    expect(ganttSwitch('Budget')).toHaveAccessibleDescription('In Gantt details');
    // The captions for phones are there, hidden by the stylesheet above 640 px
    expect(within(screen.getByTestId('builtin-customer')).getByText('Dialog')).toBeInTheDocument();
    expect(within(screen.getByTestId('builtin-customer')).getByText('Gantt')).toBeInTheDocument();
  });

  it('fills the store from the server on mount', async () => {
    await renderPanel();
    expect(stored()).toEqual(SERVER_SETTINGS);
  });

  it('shows the four fields, then the seven Gantt rows, each with its controls', async () => {
    await renderPanel();
    const builtIn = screen.getAllByTestId(/^builtin-/);
    expect(builtIn.map((r) => r.dataset.testid)).toEqual([
      'builtin-customer',
      'builtin-sales_pm',
      'builtin-volume',
      'builtin-confirmed',
    ]);
    const ganttOnly = screen.getAllByTestId(/^gantt-only-/);
    expect(ganttOnly.map((r) => r.dataset.testid)).toEqual([
      'gantt-only-pm',
      'gantt-only-tags',
      'gantt-only-period',
      'gantt-only-completion',
      'gantt-only-work_days',
      'gantt-only-total_days',
      'gantt-only-staff',
    ]);
    expect(screen.getByText('Also in the Gantt details')).toBeInTheDocument();
    // Labels on the four fields only; the Format on Volume only
    for (const row of builtIn) expect(within(row).getAllByRole('textbox')).toHaveLength(1);
    for (const row of ganttOnly) expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(builtIn[2]).getByRole('combobox', { name: 'Format of Volume' })).toBeInTheDocument();
    expect(screen.getAllByRole('combobox', { name: /^Format of/ })).toHaveLength(1);

    // Two switches on the hideable fields, Confirmed always in the dialog
    for (const row of builtIn.slice(0, 3)) expect(within(row).getAllByRole('switch')).toHaveLength(2);
    const confirmed = builtIn[3];
    expect(within(confirmed).getAllByRole('switch')).toHaveLength(1);
    expect(within(confirmed).getByText('Always').parentElement).toHaveAttribute('title', CONFIRMED_HINT);
    expect(within(confirmed).getByText(`in the project dialog. ${CONFIRMED_HINT}`)).toHaveClass('sr-only');

    // The Gantt rows: one switch; PM and Tags always in the dialog, the others not dialog fields
    const slot = (row: HTMLElement) => within(row).getByText(/^(Always|—)$/).textContent;
    expect(ganttOnly.map(slot)).toEqual(['Always', 'Always', '—', '—', '—', '—', '—']);
    expect(within(ganttOnly[2]).getByText('Not a dialog field')).toHaveClass('sr-only');
    for (const row of ganttOnly) expect(within(row).getAllByRole('switch')).toHaveLength(1);
    expect(ganttSwitch('Assigned staff')).toBeChecked();
    expect(ganttSwitch('Period')).toBeChecked();
  });

  it('reads the labels, the shown fields and the Gantt rows from the settings', async () => {
    await renderPanel();
    expect(screen.getByLabelText('Label of Customer')).toHaveValue('Client');
    expect(screen.getByLabelText('Label of Customer')).toHaveAttribute('placeholder', 'Customer');
    expect(screen.getByLabelText('Label of Sales PM')).toHaveValue('');
    expect(dialogSwitch('Customer')).toBeChecked();
    expect(dialogSwitch('Sales PM')).not.toBeChecked();
    expect(ganttSwitch('Customer')).toBeChecked();
    expect(ganttSwitch('Volume')).not.toBeChecked();
    expect(ganttSwitch('Confirmed')).toBeChecked();
    // Hidden in the dialog: off and locked in the Gantt details
    expect(ganttSwitch('Sales PM')).not.toBeChecked();
    expect(ganttSwitch('Sales PM')).toBeDisabled();
    expect(ganttSwitch('Sales PM')).toHaveAccessibleDescription(HIDDEN_DETAILS_HINT);
    // No Save or Reset: changes apply at once
    expect(screen.queryByRole('button', { name: /Save Changes|Reset/ })).not.toBeInTheDocument();
  });

  it('shows a load failure', async () => {
    api.getInstanceSettings.mockRejectedValue(new Error('Settings unavailable'));
    render(<ProjectFieldsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings unavailable');
  });
});

describe('ProjectFieldsPanel — immediate saves', () => {
  it('writes a switch at once in canonical form; the store holds it before the server answers', async () => {
    const put = deferred<{ value: string }>();
    api.updateSetting.mockReturnValueOnce(put.promise);
    await renderPanel();

    fireEvent.click(ganttSwitch('Volume'));
    const value = '["customer","pm","volume","confirmed","tags","period","completion","work_days","total_days","staff"]';
    expect(api.updateSetting).toHaveBeenCalledWith('project_tooltip_rows', value);
    expect(stored()?.project_tooltip_rows).toBe(value);
    expect(ganttSwitch('Volume')).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');

    await act(async () => put.resolve({ value }));
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('clears "Saved" after two seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderPanel();
    fireEvent.click(ganttSwitch('Tags'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it("re-asserts the server's value over a stale refetch", async () => {
    const put = deferred<{ value: string }>();
    api.updateSetting.mockReturnValueOnce(put.promise);
    await renderPanel();

    fireEvent.click(dialogSwitch('Sales PM'));
    // Another admin's change:settings refetch lands with the old value
    act(() => useAppStore.setState({ instanceSettings: { ...SERVER_SETTINGS } }));
    expect(dialogSwitch('Sales PM')).not.toBeChecked();
    await act(async () => put.resolve({ value: '[]' }));
    expect(stored()?.project_fields_hidden).toBe('[]');
    expect(dialogSwitch('Sales PM')).toBeChecked();
  });

  it('shows a failed save inline and reloads the settings from the server', async () => {
    api.updateSetting.mockRejectedValueOnce(new Error('Invalid value for project_tooltip_rows'));
    await renderPanel();
    fireEvent.click(ganttSwitch('Assigned staff'));
    expect(ganttSwitch('Assigned staff')).not.toBeChecked();

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid value for project_tooltip_rows');
    await waitFor(() => expect(api.getInstanceSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ganttSwitch('Assigned staff')).toBeChecked());
    expect(stored()).toEqual(SERVER_SETTINGS);
  });

  it('coalesces a burst of clicks: one PUT in flight, then the last value', async () => {
    const first = deferred<{ value: string }>();
    api.updateSetting.mockReturnValueOnce(first.promise);
    await renderPanel();

    fireEvent.click(ganttSwitch('Tags'));
    fireEvent.click(ganttSwitch('Tags'));
    fireEvent.click(ganttSwitch('Tags'));
    const withoutTags = '["customer","pm","confirmed","period","completion","work_days","total_days","staff"]';
    expect(api.updateSetting).toHaveBeenCalledTimes(1);
    expect(api.updateSetting).toHaveBeenLastCalledWith('project_tooltip_rows', withoutTags);
    expect(stored()?.project_tooltip_rows).toBe(withoutTags);
    expect(ganttSwitch('Tags')).not.toBeChecked();

    await act(async () => first.resolve({ value: withoutTags }));
    await waitFor(() => expect(api.updateSetting).toHaveBeenCalledTimes(2));
    expect(api.updateSetting).toHaveBeenLastCalledWith('project_tooltip_rows', withoutTags);
    expect(stored()?.project_tooltip_rows).toBe(withoutTags);
    expect(ganttSwitch('Tags')).not.toBeChecked();
  });

  it('hides a field in both: the dialog setting and the Gantt rows, locked off until shown and ticked again', async () => {
    await renderPanel();
    fireEvent.click(dialogSwitch('Customer'));
    expect(api.updateSetting).toHaveBeenCalledWith('project_fields_hidden', '["customer","sales_pm"]');
    expect(api.updateSetting).toHaveBeenCalledWith(
      'project_tooltip_rows',
      '["pm","confirmed","tags","period","completion","work_days","total_days","staff"]'
    );
    expect(ganttSwitch('Customer')).not.toBeChecked();
    expect(ganttSwitch('Customer')).toBeDisabled();
    expect(ganttSwitch('Customer')).toHaveAccessibleDescription(HIDDEN_DETAILS_HINT);
    expect(within(screen.getByTestId('builtin-customer')).getByText(HIDDEN_DETAILS_HINT)).toBeInTheDocument();

    fireEvent.click(dialogSwitch('Customer'));
    // Sent once the first write of the key has landed
    await waitFor(() => expect(api.updateSetting).toHaveBeenLastCalledWith('project_fields_hidden', '["sales_pm"]'));
    expect(ganttSwitch('Customer')).toBeEnabled();
    expect(ganttSwitch('Customer')).not.toBeChecked();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));

    // Hiding a field the Gantt rows do not list writes the dialog setting only
    api.updateSetting.mockClear();
    fireEvent.click(dialogSwitch('Volume'));
    expect(api.updateSetting).toHaveBeenCalledTimes(1);
    expect(api.updateSetting).toHaveBeenCalledWith('project_fields_hidden', '["sales_pm","volume"]');
  });

  it('writes a custom field id from its Gantt switch, dropping the ids of deleted fields', async () => {
    api.getInstanceSettings.mockResolvedValue({ project_tooltip_rows: '["pm",1,77]' });
    await renderPanel();
    const regulated = screen.getByTestId('field-3');
    expect(within(regulated).getByText('Always').parentElement).toHaveAttribute('title', CUSTOM_ALWAYS_HINT);
    expect(ganttSwitch('Project type')).toBeChecked();
    expect(ganttSwitch('Regulated')).not.toBeChecked();

    fireEvent.click(ganttSwitch('Regulated'));
    expect(api.updateSetting).toHaveBeenCalledWith('project_tooltip_rows', '["pm",1,3]');
    expect(ganttSwitch('Regulated')).toBeChecked();
  });

  it('keeps the ids it cannot check when the fields failed to load', async () => {
    projectFieldsApi.getAll.mockRejectedValue(new Error('Server down'));
    api.getInstanceSettings.mockResolvedValue({ project_tooltip_rows: '["pm",77]' });
    render(<ProjectFieldsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server down');
    fireEvent.click(ganttSwitch('Tags'));
    expect(api.updateSetting).toHaveBeenCalledWith('project_tooltip_rows', '["pm","tags",77]');
  });

  it('never reports a switch as unsaved, only an unfinished add', async () => {
    const onDirtyChange = await renderPanel();
    fireEvent.click(ganttSwitch('Tags'));
    fireEvent.click(dialogSwitch('Volume'));
    fireEvent.change(screen.getByLabelText('Label of Volume'), { target: { value: 'Budget' } });
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    fireEvent.change(screen.getByLabelText('New field name'), { target: { value: 'Area' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });
});

describe('ProjectFieldsPanel — labels', () => {
  it('writes a label on blur, trimmed, and nothing while typing', async () => {
    await renderPanel();
    const label = screen.getByLabelText('Label of Confirmed');
    fireEvent.change(label, { target: { value: ' Won ' } });
    expect(label).toHaveValue(' Won ');
    expect(api.updateSetting).not.toHaveBeenCalled();

    fireEvent.blur(label);
    expect(api.updateSetting).toHaveBeenCalledTimes(1);
    expect(api.updateSetting).toHaveBeenCalledWith('project_field_labels', '{"customer":"Client","confirmed":"Won"}');
    expect(stored()?.project_field_labels).toBe('{"customer":"Client","confirmed":"Won"}');
    expect(label).toHaveValue('Won');
  });

  it('writes once on Enter then blur; an emptied label falls back to the default', async () => {
    await renderPanel();
    const label = screen.getByLabelText('Label of Customer');
    fireEvent.change(label, { target: { value: '' } });
    fireEvent.keyDown(label, { key: 'Enter' });
    fireEvent.blur(label);
    expect(api.updateSetting).toHaveBeenCalledTimes(1);
    expect(api.updateSetting).toHaveBeenCalledWith('project_field_labels', '{}');
    expect(label).toHaveValue('');
  });

  it('writes nothing for an unchanged label', async () => {
    await renderPanel();
    const label = screen.getByLabelText('Label of Customer');
    fireEvent.change(label, { target: { value: ' Client ' } });
    fireEvent.blur(label);
    fireEvent.blur(screen.getByLabelText('Label of Volume'));
    expect(api.updateSetting).not.toHaveBeenCalled();
  });

  it('reverts a changed draft on Escape without closing the hub; an unchanged one lets Escape through', async () => {
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <ProjectFieldsPanel />
      </div>
    );
    await screen.findByTestId('field-1');
    const label = screen.getByLabelText('Label of Customer');

    fireEvent.change(label, { target: { value: 'Account' } });
    fireEvent.keyDown(label, { key: 'Escape' });
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(label).toHaveValue('Client');
    fireEvent.blur(label);
    expect(api.updateSetting).not.toHaveBeenCalled();

    fireEvent.change(label, { target: { value: 'Client' } });
    fireEvent.keyDown(label, { key: 'Escape' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    // No draft at all: Escape goes through as well
    fireEvent.keyDown(label, { key: 'Escape' });
    expect(onKeyDown).toHaveBeenCalledTimes(2);
    // Other keys type as usual
    fireEvent.keyDown(label, { key: 'a' });
    expect(api.updateSetting).not.toHaveBeenCalled();
  });
});

describe('ProjectFieldsPanel — Volume format', () => {
  const volumeRow = () => screen.getByTestId('builtin-volume');

  it('shows the Format picker on the Volume row only, 1.0 by default, with its preview', async () => {
    await renderPanel();

    const picker = within(volumeRow()).getByRole('combobox', { name: 'Format of Volume' });
    expect(picker).toHaveValue('1');
    expect(within(volumeRow()).getByText('Format', { selector: 'label' })).toBeInTheDocument();
    expect(
      within(volumeRow()).getByText(`12.345 is saved and shown as 12.3. ${FORMAT_EXISTING_NOTE}`)
    ).toBeInTheDocument();
    for (const key of ['customer', 'sales_pm', 'confirmed']) {
      expect(within(screen.getByTestId(`builtin-${key}`)).queryByRole('combobox')).not.toBeInTheDocument();
    }
  });

  it('reads the stored format, As typed included', async () => {
    api.getInstanceSettings.mockResolvedValue({ volume_decimals: 'any' });
    await renderPanel();

    expect(screen.getByRole('combobox', { name: 'Format of Volume' })).toHaveValue('');
    expect(within(volumeRow()).getByText(FORMAT_AS_TYPED_PREVIEW)).toBeInTheDocument();
  });

  it('saves a changed format at once, into the store too', async () => {
    const onDirtyChange = await renderPanel();

    fireEvent.change(screen.getByRole('combobox', { name: 'Format of Volume' }), { target: { value: '2' } });
    expect(
      within(volumeRow()).getByText(`12.345 is saved and shown as 12.35. ${FORMAT_EXISTING_NOTE}`)
    ).toBeInTheDocument();
    expect(api.updateSetting).toHaveBeenCalledTimes(1);
    expect(api.updateSetting).toHaveBeenCalledWith('volume_decimals', '2');
    expect(stored()).toEqual({ ...SERVER_SETTINGS, volume_decimals: '2' });
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it('saves As typed as "any"', async () => {
    await renderPanel();
    fireEvent.change(screen.getByRole('combobox', { name: 'Format of Volume' }), { target: { value: '' } });
    expect(api.updateSetting).toHaveBeenCalledWith('volume_decimals', 'any');
  });
});

describe('ProjectFieldsPanel — custom fields', () => {
  it('lists the fields in order with their type and item count, and fills the store', async () => {
    await renderPanel();
    const rows = screen.getAllByTestId(/^field-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(['field-1', 'field-2', 'field-3']);
    expect(within(rows[0]).getByText('Dropdown')).toBeInTheDocument();
    expect(within(rows[0]).getByText('2 items')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Number')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Switch')).toBeInTheDocument();
    // Only dropdowns have items
    expect(within(rows[1]).queryByRole('button', { name: /^Items of/ })).not.toBeInTheDocument();
    // Items sorted inside each field, fields in order
    expect(useAppStore.getState().projectFields.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(useAppStore.getState().projectFields[0].options.map((o) => o.id)).toEqual([11, 12]);
  });

  it('says so when there is no field yet, and when the list fails to load', async () => {
    projectFieldsApi.getAll.mockResolvedValueOnce([]);
    const { unmount } = render(<ProjectFieldsPanel />);
    expect(await screen.findByText('No custom fields yet. Add one below.')).toBeInTheDocument();
    unmount();

    projectFieldsApi.getAll.mockRejectedValueOnce(new Error('Server down'));
    render(<ProjectFieldsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server down');
  });

  it('adds a field of the chosen type once, even on a double submit; a dropdown opens on its items', async () => {
    const created = makeProjectField({ id: 9, name: 'Area', field_type: 'multiselect', sort_order: 3 });
    let finish!: (f: ProjectField) => void;
    projectFieldsApi.create.mockReturnValue(new Promise((r) => (finish = r)));
    const onDirtyChange = await renderPanel();

    fireEvent.change(screen.getByLabelText('New field name'), { target: { value: '  Area ' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'multiselect' } });
    const form = screen.getByLabelText('New field name').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(projectFieldsApi.create).toHaveBeenCalledTimes(1);
    expect(projectFieldsApi.create).toHaveBeenCalledWith({ name: 'Area', field_type: 'multiselect' });

    projectFieldsApi.getAll.mockResolvedValue([...FIELDS, created]);
    await act(async () => finish(created));
    expect(await screen.findByRole('group', { name: 'Items of Area' })).toBeInTheDocument();
    expect(screen.getByText('No items yet. Add the first one below.')).toBeInTheDocument();
    expect(screen.getByLabelText('New field name')).toHaveValue('');
  });

  it('puts the name, the type and "Add field" side by side in one add row after the list', async () => {
    await renderPanel();
    const name = screen.getByRole('textbox', { name: 'New field name' });
    expect(name).toHaveAttribute('placeholder', 'New field, e.g. Budget');
    const row = name.closest('form')!.firstElementChild as HTMLElement;
    expect(within(row).getByRole('combobox', { name: 'Type' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Add field' })).toBeDisabled();
    // no visible "New field" / "Type" labels any more: the controls are named by aria-label
    expect(screen.queryByText('New field')).not.toBeInTheDocument();
    // the form comes after the field list
    const list = screen.getByTestId(`field-${FIELDS[0].id}`);
    expect(list.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(name, { target: { value: 'Budget' } });
    expect(within(row).getByRole('button', { name: 'Add field' })).toBeEnabled();
  });

  it('shows a refused add inline (duplicate name)', async () => {
    projectFieldsApi.create.mockRejectedValue(new Error('A project field with this name already exists'));
    await renderPanel();
    fireEvent.change(screen.getByLabelText('New field name'), { target: { value: 'Budget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A project field with this name already exists');
    await waitFor(() => expect(projectFieldsApi.getAll).toHaveBeenCalledTimes(2));
  });

  it('renames in the edit form: Enter saves, Escape cancels without reaching the hub', async () => {
    projectFieldsApi.update.mockResolvedValue({});
    const onKeyDown = vi.fn();
    const onDirtyChange = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <ProjectFieldsPanel onDirtyChange={onDirtyChange} />
      </div>
    );
    await screen.findByTestId('field-1');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Budget' }));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Cost' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Escape' });
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Field name')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Budget' }));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: ' Cost ' } });
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Enter' });
    // A number field sends its format along (as typed here)
    await waitFor(() => expect(projectFieldsApi.update).toHaveBeenCalledWith(2, { name: 'Cost', decimals: null }));

    // The Cancel and Save buttons of the edit form; a switch has no format
    fireEvent.click(screen.getByRole('button', { name: 'Edit Regulated' }));
    fireEvent.click(within(screen.getByTestId('field-3')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Field name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Regulated' }));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'GMP' } });
    fireEvent.click(within(screen.getByTestId('field-3')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(projectFieldsApi.update).toHaveBeenCalledWith(3, { name: 'GMP' }));
  });

  it('asks before deleting a field, naming how many projects lose a value', async () => {
    projectFieldsApi.remove.mockResolvedValue(undefined);
    projectFieldsApi.usage.mockResolvedValue({ projects: 3 });
    const confirm = stubConfirm(false);
    await renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Budget' }));
    });
    expect(projectFieldsApi.usage).toHaveBeenCalledWith(2);
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Delete the field "Budget"? 3 projects hold a value; it will be removed.',
        destructive: true,
      })
    );
    expect(projectFieldsApi.remove).not.toHaveBeenCalled();

    projectFieldsApi.usage.mockResolvedValue({ projects: 1 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Budget' }));
    });
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Delete the field "Budget"? 1 project holds a value; it will be removed.' })
    );

    projectFieldsApi.usage.mockResolvedValue({ projects: 0 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Budget' }));
    });
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: 'Delete the field "Budget"? No project holds a value.' })
    );

    // Usage unknown: a generic warning; confirmed this time
    projectFieldsApi.usage.mockRejectedValue(new Error('x'));
    confirm.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Budget' }));
    await waitFor(() => expect(projectFieldsApi.remove).toHaveBeenCalledWith(2));
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "Delete the field \"Budget\"? Every project's value of it is removed." })
    );
  });

  it('reorders fields by drag and drop and persists the full order', async () => {
    projectFieldsApi.reorder.mockResolvedValue({ success: true });
    await renderPanel();
    dragOnto(screen.getByTestId('field-1'), screen.getByTestId('field-3'));
    await waitFor(() => expect(projectFieldsApi.reorder).toHaveBeenCalledWith([2, 3, 1]));
    // A drop before the target (upper half)
    projectFieldsApi.reorder.mockClear();
    dragOnto(screen.getByTestId('field-3'), screen.getByTestId('field-2'), -1);
    await waitFor(() => expect(projectFieldsApi.reorder).toHaveBeenCalled());
  });
});

describe('ProjectFieldsPanel — number format', () => {
  const FORMAT_LABELS = ['As typed', '1', '1.0', '1.00', '1.000'];
  const FORMAT_VALUES = ['', '0', '1', '2', '3'];
  /** The preview of each format, in option order, for 12.345 */
  const PREVIEWS = [
    FORMAT_AS_TYPED_PREVIEW,
    '12.345 is saved and shown as 12.',
    '12.345 is saved and shown as 12.3.',
    '12.345 is saved and shown as 12.35.',
    '12.345 is saved and shown as 12.345.',
  ];
  /** The custom fields (the built-in Volume row has a Format picker of its own) */
  const custom = () => within(screen.getByRole('region', { name: 'Custom fields' }));

  it('names the format in the type pill: "Number · 1.0", plain "Number" as typed', async () => {
    projectFieldsApi.getAll.mockResolvedValue([
      { ...FIELDS[0], decimals: 1 },
      FIELDS[1],
      FIELDS[2],
      makeProjectField({ id: 4, name: 'Cost', field_type: 'number', sort_order: 3, decimals: null }),
      makeProjectField({ id: 5, name: 'Units', field_type: 'number', sort_order: 4, decimals: 0 }),
    ]);
    await renderPanel();
    expect(within(screen.getByTestId('field-2')).getByText('Number · 1.0')).toBeInTheDocument();
    expect(within(screen.getByTestId('field-4')).getByText('Number')).toBeInTheDocument();
    expect(within(screen.getByTestId('field-5')).getByText('Number · 1')).toBeInTheDocument();
    expect(within(screen.getByTestId('field-3')).getByText('Switch')).toBeInTheDocument();
    // No picker in the rows: the format is changed in the edit form
    expect(custom().queryByRole('combobox', { name: /Format/ })).not.toBeInTheDocument();
  });

  it('offers the Format picker in the add row only while Number is picked, previewing each choice', async () => {
    await renderPanel();
    expect(custom().queryByLabelText('Format')).not.toBeInTheDocument();
    expect(custom().queryByText(FORMAT_AS_TYPED_PREVIEW)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'number' } });
    const picker = custom().getByLabelText('Format');
    // A visible label, beside the select
    expect(custom().getByText('Format', { selector: 'label' })).toBeVisible();
    const options = within(picker).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => o.textContent)).toEqual(FORMAT_LABELS);
    expect(options.map((o) => o.value)).toEqual(FORMAT_VALUES);
    expect(picker).toHaveValue('');
    expect(custom().getByText(FORMAT_AS_TYPED_PREVIEW)).toBeInTheDocument();

    FORMAT_VALUES.forEach((value, i) => {
      fireEvent.change(picker, { target: { value } });
      expect(custom().getByText(PREVIEWS[i])).toBeInTheDocument();
    });
    // A new field has no values yet: no word about existing ones
    expect(custom().queryByText(new RegExp(FORMAT_EXISTING_NOTE))).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'text' } });
    expect(custom().queryByLabelText('Format')).not.toBeInTheDocument();
    expect(custom().queryByText(/is saved and shown as/)).not.toBeInTheDocument();
  });

  it('creates a number field with its format; other types send none', async () => {
    projectFieldsApi.getAll.mockResolvedValue(FIELDS.filter((f) => f.field_type !== 'number'));
    projectFieldsApi.create.mockResolvedValue(makeProjectField({ id: 9, name: 'Cost', field_type: 'number' }));
    await renderPanel();

    fireEvent.change(screen.getByLabelText('New field name'), { target: { value: 'Cost' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'number' } });
    fireEvent.change(custom().getByLabelText('Format'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    await waitFor(() =>
      expect(projectFieldsApi.create).toHaveBeenCalledWith({ name: 'Cost', field_type: 'number', decimals: 2 })
    );
    // The add row starts over on As typed.
    await waitFor(() => expect(custom().getByLabelText('Format')).toHaveValue(''));
    expect(custom().getByText(FORMAT_AS_TYPED_PREVIEW)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New field name'), { target: { value: 'Note' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    await waitFor(() => expect(projectFieldsApi.create).toHaveBeenLastCalledWith({ name: 'Note', field_type: 'text' }));
  });

  it('changes the format in the edit form, saved with its Save; the preview mentions existing values', async () => {
    projectFieldsApi.getAll.mockResolvedValue([{ ...FIELDS[0], decimals: 2 }, FIELDS[1], FIELDS[2]]);
    projectFieldsApi.update.mockResolvedValue({});
    const onDirtyChange = await renderPanel();
    const row = screen.getByTestId('field-2');
    // The switch's edit form has no format
    fireEvent.click(screen.getByRole('button', { name: 'Edit Regulated' }));
    expect(within(screen.getByTestId('field-3')).queryByRole('combobox')).not.toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Edit Budget' }));
    const picker = within(row).getByRole('combobox', { name: 'Format of Budget' });
    expect(within(row).getByText('Format', { selector: 'label' })).toBeInTheDocument();
    expect(picker).toHaveValue('2');
    expect(within(row).getByText(`${PREVIEWS[3]} ${FORMAT_EXISTING_NOTE}`)).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: '1' } });
    expect(within(row).getByText(`${PREVIEWS[2]} ${FORMAT_EXISTING_NOTE}`)).toBeInTheDocument();
    // Nothing is saved on change; the edit is unsaved input for the hub
    expect(projectFieldsApi.update).not.toHaveBeenCalled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(projectFieldsApi.update).toHaveBeenCalledWith(2, { name: 'Budget', decimals: 1 }));
    await waitFor(() => expect(within(row).queryByRole('combobox')).not.toBeInTheDocument());
  });

  it('resets a format to As typed (null), and Escape on the picker cancels without reaching the hub', async () => {
    projectFieldsApi.getAll.mockResolvedValue([{ ...FIELDS[0], decimals: 3 }, FIELDS[1], FIELDS[2]]);
    projectFieldsApi.update.mockResolvedValue({});
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <ProjectFieldsPanel />
      </div>
    );
    await screen.findByTestId('field-1');
    const row = screen.getByTestId('field-2');

    fireEvent.click(within(row).getByRole('button', { name: 'Edit Budget' }));
    fireEvent.change(within(row).getByLabelText('Format of Budget'), { target: { value: '1' } });
    fireEvent.keyDown(within(row).getByLabelText('Format of Budget'), { key: 'Escape' });
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(within(row).queryByLabelText('Format of Budget')).not.toBeInTheDocument();
    // Enter on the select does not save
    fireEvent.click(within(row).getByRole('button', { name: 'Edit Budget' }));
    expect(within(row).getByLabelText('Format of Budget')).toHaveValue('3');
    fireEvent.keyDown(within(row).getByLabelText('Format of Budget'), { key: 'Enter' });
    expect(projectFieldsApi.update).not.toHaveBeenCalled();

    fireEvent.change(within(row).getByLabelText('Format of Budget'), { target: { value: '' } });
    expect(within(row).getByText(FORMAT_AS_TYPED_PREVIEW)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(projectFieldsApi.update).toHaveBeenCalledWith(2, { name: 'Budget', decimals: null }));
  });

  it('shows a refused format change inline', async () => {
    projectFieldsApi.update.mockRejectedValue(new Error('Only number fields have decimals'));
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Budget' }));
    fireEvent.change(screen.getByLabelText('Format of Budget'), { target: { value: '1' } });
    fireEvent.click(within(screen.getByTestId('field-2')).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only number fields have decimals');
  });
});

describe('ProjectFieldsPanel — items', () => {
  async function openItems() {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Items of Project type' }));
    return screen.getByRole('group', { name: 'Items of Project type' });
  }

  it('lists the items in order with their scope, and closes again', async () => {
    const items = await openItems();
    expect(screen.getByRole('button', { name: 'Items of Project type' })).toHaveAttribute('aria-expanded', 'true');
    const rows = within(items).getAllByTestId(/^item-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(['item-11', 'item-12']);
    expect(within(rows[0]).getByText('All sites')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Zurich')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Items of Project type' }));
    expect(screen.queryByRole('group', { name: 'Items of Project type' })).not.toBeInTheDocument();
  });

  it('adds an item with its colour, available at all sites', async () => {
    projectFieldsApi.createOption.mockResolvedValue({});
    const items = await openItems();
    fireEvent.change(within(items).getByLabelText('New item of Project type'), { target: { value: ' Partner ' } });
    fireEvent.click(within(items).getAllByRole('radio')[0]);
    fireEvent.click(within(items).getByRole('button', { name: 'Add item' }));
    await waitFor(() =>
      expect(projectFieldsApi.createOption).toHaveBeenCalledWith(1, {
        name: 'Partner',
        color: expect.stringMatching(/^#/),
        all_sites: true,
      })
    );
    await waitFor(() => expect(within(items).getByLabelText('New item of Project type')).toHaveValue(''));
  });

  it('edits an item: colour, sites and teams, like a tag; reports the unsaved edit', async () => {
    projectFieldsApi.updateOption.mockResolvedValue({});
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1, name: 'Analytics' }), makeTeam({ id: 3, site_id: 2, name: 'Zurich lab' })],
    });
    const onDirtyChange = vi.fn();
    render(<ProjectFieldsPanel onDirtyChange={onDirtyChange} />);
    await screen.findByTestId('field-1');
    fireEvent.click(screen.getByRole('button', { name: 'Items of Project type' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit Internal' }));
    const row = screen.getByTestId('item-11');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(within(row).getByRole('switch', { name: 'All sites' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    // No site picked yet: an item that applies nowhere cannot be saved
    expect(within(row).getByText('Pick at least one site.')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.click(within(row).getByRole('checkbox', { name: 'Basel' }));
    fireEvent.click(within(row).getByRole('switch', { name: 'Whole site' }));
    fireEvent.click(within(row).getByRole('checkbox', { name: 'Analytics' }));
    fireEvent.change(within(row).getByLabelText('Item name'), { target: { value: 'In-house' } });
    const colours = within(row).getByRole('radiogroup', { name: 'Color of Internal' });
    const swatch = within(colours).getAllByRole('radio')[0];
    fireEvent.click(swatch);
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(projectFieldsApi.updateOption).toHaveBeenCalledWith(11, {
        name: 'In-house',
        color: expect.not.stringMatching(/^#6366f1$/),
        all_sites: false,
        site_ids: [1],
        team_ids: [1],
      })
    );
  });

  it('saves an item edit on Enter and cancels it on Escape or Cancel', async () => {
    projectFieldsApi.updateOption.mockResolvedValue({});
    const items = await openItems();
    fireEvent.click(within(items).getByRole('button', { name: 'Edit Customer' }));
    fireEvent.keyDown(within(items).getByLabelText('Item name'), { key: 'Escape' });
    expect(within(items).queryByLabelText('Item name')).not.toBeInTheDocument();

    fireEvent.click(within(items).getByRole('button', { name: 'Edit Customer' }));
    fireEvent.click(within(items).getByRole('button', { name: 'Cancel' }));
    expect(within(items).queryByLabelText('Item name')).not.toBeInTheDocument();

    fireEvent.click(within(items).getByRole('button', { name: 'Edit Customer' }));
    // The edit button toggles the edit off again
    fireEvent.click(within(items).getByRole('button', { name: 'Edit Customer' }));
    expect(within(items).queryByLabelText('Item name')).not.toBeInTheDocument();

    fireEvent.click(within(items).getByRole('button', { name: 'Edit Customer' }));
    fireEvent.keyDown(within(items).getByLabelText('Item name'), { key: 'Enter' });
    await waitFor(() =>
      expect(projectFieldsApi.updateOption).toHaveBeenCalledWith(12, expect.objectContaining({ site_ids: [2] }))
    );
  });

  it('shows a 409 from an item edit inline', async () => {
    projectFieldsApi.updateOption.mockRejectedValue(new Error('1 project at another site uses this item'));
    const items = await openItems();
    fireEvent.click(within(items).getByRole('button', { name: 'Edit Internal' }));
    fireEvent.click(within(items).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 project at another site uses this item');
  });

  it('asks before deleting an item', async () => {
    projectFieldsApi.removeOption.mockResolvedValue(undefined);
    const confirm = stubConfirm(false);
    const items = await openItems();
    await act(async () => {
      fireEvent.click(within(items).getByRole('button', { name: 'Delete Customer' }));
    });
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Delete the item "Customer" of "Project type"? It is removed from every project.',
        destructive: true,
      })
    );
    expect(projectFieldsApi.removeOption).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    fireEvent.click(within(items).getByRole('button', { name: 'Edit Customer' }));
    fireEvent.click(within(items).getByRole('button', { name: 'Delete Customer' }));
    await waitFor(() => expect(projectFieldsApi.removeOption).toHaveBeenCalledWith(12));
  });

  it('drops an edit whose item disappeared (deleted elsewhere) from the dirty flag', async () => {
    projectFieldsApi.removeOption.mockResolvedValue(undefined);
    stubConfirm(true);
    const onDirtyChange = vi.fn();
    render(<ProjectFieldsPanel onDirtyChange={onDirtyChange} />);
    await screen.findByTestId('field-1');
    fireEvent.click(screen.getByRole('button', { name: 'Items of Project type' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Internal' }));
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Changed' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    // A teammate removed Internal meanwhile: the reload after this delete no longer has it
    projectFieldsApi.getAll.mockResolvedValue([{ ...FIELDS[1], options: [] }, FIELDS[0], FIELDS[2]]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Customer' }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it('reorders items within their field', async () => {
    projectFieldsApi.reorderOptions.mockResolvedValue({ success: true });
    const items = await openItems();
    dragOnto(within(items).getByTestId('item-11'), within(items).getByTestId('item-12'));
    // Shown at once, before the server answers
    expect(within(items).getAllByTestId(/^item-/).map((r) => r.dataset.testid)).toEqual(['item-12', 'item-11']);
    await waitFor(() => expect(projectFieldsApi.reorderOptions).toHaveBeenCalledWith(1, [12, 11]));
  });

  it('deleting the open field closes its items', async () => {
    projectFieldsApi.remove.mockResolvedValue(undefined);
    projectFieldsApi.usage.mockResolvedValue({ projects: 0 });
    stubConfirm(true);
    await openItems();
    projectFieldsApi.getAll.mockResolvedValue(FIELDS.filter((f) => f.id !== 1));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Project type' }));
    await waitFor(() => expect(projectFieldsApi.remove).toHaveBeenCalledWith(1));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Items of Project type' })).not.toBeInTheDocument());
  });
});

