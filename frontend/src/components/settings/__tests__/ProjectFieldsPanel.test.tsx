/**
 * Settings › Project fields:
 * - Built-in fields: a label and a "Shown" switch per field; Confirmed cannot
 *   be hidden; Volume has a Format (volume_decimals, default 1.0); Save writes
 *   the settings in their canonical form and applies them to the store.
 * - Custom fields: listed in order with their type, added with a type,
 *   renamed in the row's edit form, reordered by drag, deleted after a confirm
 *   naming how many projects lose a value.
 * - Number fields: a Format picker (As typed / 1 / 1.0 / 1.00 / 1.000) with a
 *   live preview, in the add row and the row's edit form (saved with its
 *   Save); the type pill names the format.
 * - Items of a dropdown field: added, edited (colour, sites, teams — the tag
 *   edit row's controls), reordered and deleted.
 * - One dirty flag for the hub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { FORMAT_AS_TYPED_PREVIEW, FORMAT_EXISTING_NOTE, ProjectFieldsPanel } from '../panels/ProjectFieldsPanel';
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

beforeEach(() => {
  for (const fn of Object.values(projectFieldsApi)) fn.mockReset();
  api.getInstanceSettings.mockReset().mockResolvedValue({
    project_field_labels: '{"customer":"Client"}',
    project_fields_hidden: '["sales_pm"]',
  });
  api.updateSetting.mockReset().mockResolvedValue({});
  projectFieldsApi.getAll.mockResolvedValue(FIELDS);
  useAppStore.setState({ sites: SITES, teams: [], projectFields: [], instanceSettings: { instance_title: 'Lab' } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderPanel(onDirtyChange = vi.fn()) {
  render(<ProjectFieldsPanel onDirtyChange={onDirtyChange} />);
  await screen.findByText('Project type');
  return onDirtyChange;
}

/** Drag `from` onto `to`; jsdom rects are all zero, so clientY 1 drops after `to` */
function dragOnto(from: HTMLElement, to: HTMLElement, clientY = 1) {
  const dataTransfer = { effectAllowed: '', setData: vi.fn() };
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragOver(to, { clientY, dataTransfer });
  fireEvent.drop(to, { dataTransfer });
}

describe('ProjectFieldsPanel — built-in fields', () => {
  it('shows a label and a Shown switch per built-in field from the settings; Confirmed cannot be hidden', async () => {
    await renderPanel();

    expect(screen.getByLabelText('Label of Customer')).toHaveValue('Client');
    expect(screen.getByLabelText('Label of Customer')).toHaveAttribute('placeholder', 'Customer');
    expect(screen.getByLabelText('Label of Sales PM')).toHaveValue('');
    expect(screen.getByRole('switch', { name: 'Show Customer' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Show Sales PM' })).not.toBeChecked();

    const confirmed = screen.getByRole('switch', { name: 'Show Confirmed' });
    expect(confirmed).toBeChecked();
    expect(confirmed).toBeDisabled();
    expect(confirmed).toHaveAccessibleDescription('Confirmed drives the project status, ordering and counts');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('saves the changed labels and hidden fields in canonical form, into the store too', async () => {
    const onDirtyChange = await renderPanel();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(screen.getByLabelText('Label of Confirmed'), { target: { value: ' Won ' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Show Volume' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Show Sales PM' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await screen.findByText('Built-in fields saved');
    expect(api.updateSetting).toHaveBeenCalledWith('project_field_labels', '{"customer":"Client","confirmed":"Won"}');
    expect(api.updateSetting).toHaveBeenCalledWith('project_fields_hidden', '["volume"]');
    expect(useAppStore.getState().instanceSettings).toEqual({
      instance_title: 'Lab',
      project_field_labels: '{"customer":"Client","confirmed":"Won"}',
      project_fields_hidden: '["volume"]',
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('writes only the setting that changed; an emptied label falls back to the default', async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Label of Customer'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await screen.findByText('Built-in fields saved');
    expect(api.updateSetting).toHaveBeenCalledTimes(1);
    expect(api.updateSetting).toHaveBeenCalledWith('project_field_labels', '{}');
  });

  it('shows a failed save inline and keeps what already reached the server', async () => {
    api.updateSetting.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Invalid value for project_fields_hidden'));
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Label of Volume'), { target: { value: 'Budget (EUR)' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Show Customer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid value for project_fields_hidden');
    expect(useAppStore.getState().instanceSettings?.project_field_labels).toBe(
      '{"customer":"Client","volume":"Budget (EUR)"}'
    );
    expect(useAppStore.getState().instanceSettings?.project_fields_hidden).toBeUndefined();
    // The hidden change is still unsaved
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
  });

  it('resets the unsaved built-in edits', async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText('Label of Customer'), { target: { value: 'Account' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('Label of Customer')).toHaveValue('Client');
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
  });

  it('shows a load failure', async () => {
    api.getInstanceSettings.mockRejectedValue(new Error('Settings unavailable'));
    render(<ProjectFieldsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings unavailable');
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

  it('saves a changed format with the built-in fields, into the store too', async () => {
    const onDirtyChange = await renderPanel();

    fireEvent.change(screen.getByRole('combobox', { name: 'Format of Volume' }), { target: { value: '2' } });
    expect(
      within(volumeRow()).getByText(`12.345 is saved and shown as 12.35. ${FORMAT_EXISTING_NOTE}`)
    ).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(api.updateSetting).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await screen.findByText('Built-in fields saved');
    expect(api.updateSetting).toHaveBeenCalledTimes(1);
    expect(api.updateSetting).toHaveBeenCalledWith('volume_decimals', '2');
    expect(useAppStore.getState().instanceSettings).toEqual({ instance_title: 'Lab', volume_decimals: '2' });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('saves As typed as "any"', async () => {
    await renderPanel();
    fireEvent.change(screen.getByRole('combobox', { name: 'Format of Volume' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await screen.findByText('Built-in fields saved');
    expect(api.updateSetting).toHaveBeenCalledWith('volume_decimals', 'any');
  });

  it('resets an unsaved format', async () => {
    await renderPanel();
    const picker = screen.getByRole('combobox', { name: 'Format of Volume' });
    fireEvent.change(picker, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(picker).toHaveValue('1');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
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
    await screen.findByText('Project type');

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
    await screen.findByText('Project type');
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
    await screen.findByText('Project type');
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
    await screen.findByText('Project type');
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
