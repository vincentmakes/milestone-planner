/**
 * ProjectModal project fields:
 * - every custom field renders with its control (text, number, switch,
 *   dropdown, multi-select) after Teams, preloaded from the project;
 * - only the fields that changed go out as `field_values` (cleared as null /
 *   []), and the store shows them at once;
 * - dropdowns offer only the items applying to the project's site and teams,
 *   and items no longer applying are dropped on save;
 * - built-in fields take their custom label; a hidden one is neither shown
 *   nor sent (Confirmed is never hidden);
 * - "Manage fields…" (project_fields.manage) leads to Settings → Project fields.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { ProjectModal } from '../ProjectModal';
import { MANAGE_FIELDS_CONFIRM } from '../ProjectFieldInputs';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { createProject, updateProject } from '@/api/endpoints/projects';
import { stubConfirm } from '@/test/confirmDialog';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { makeProject, makeProjectField, makeProjectFieldOption, makeTeam, makeUser } from '@/test/factories';
import type { Project, ProjectField, Site } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createProject: vi.fn().mockResolvedValue({}),
  updateProject: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn(async () => (await import('@/stores/appStore')).useAppStore.getState().projects),
}));
vi.mock('@/api/endpoints/settings', () => ({ getPredefinedPhases: vi.fn(async () => []) }));

const analytics = makeTeam({ id: 1, site_id: 1, name: 'Analytics' });
const processTeam = makeTeam({ id: 2, site_id: 1, name: 'Process' });

const internal = makeProjectFieldOption({ id: 11, name: 'Internal', sort_order: 0 });
const customerItem = makeProjectFieldOption({ id: 12, name: 'Customer', sort_order: 1 });
const zurichOnly = makeProjectFieldOption({ id: 13, name: 'Zurich only', all_sites: false, site_ids: [2], sort_order: 2 });
const processArea = makeProjectFieldOption({ id: 21, name: 'Process', color: '#f97316', sort_order: 0 });
const qa = makeProjectFieldOption({ id: 22, name: 'QA', color: '#10b981', sort_order: 1 });
const analyticsArea = makeProjectFieldOption({ id: 23, name: 'Analytics', team_ids: [1], sort_order: 2 });

const FIELDS: ProjectField[] = [
  makeProjectField({ id: 1, name: 'Project type', field_type: 'select', sort_order: 0, options: [internal, customerItem, zurichOnly] }),
  makeProjectField({ id: 2, name: 'Area', field_type: 'multiselect', sort_order: 1, options: [processArea, qa, analyticsArea] }),
  makeProjectField({ id: 3, name: 'Budget', field_type: 'number', sort_order: 2 }),
  makeProjectField({ id: 4, name: 'Regulated', field_type: 'toggle', sort_order: 3 }),
  makeProjectField({ id: 5, name: 'Reference', field_type: 'text', sort_order: 4 }),
];

const project: Project = makeProject({
  id: 9,
  name: 'Bioprocess Scale-Up',
  site_id: 1,
  customer: 'Acme',
  sales_pm: 'Sam',
  volume: 1000,
  confirmed: false,
  start_date: '2026-09-01',
  end_date: '2026-10-01',
  team_ids: [1],
  field_values: { 1: 11, 2: [23, 21], 3: 1250, 5: 'PO-1' },
});

const sent = (fn: typeof createProject | typeof updateProject) => {
  const calls = vi.mocked(fn).mock.calls;
  const last = calls[calls.length - 1];
  return (fn === createProject ? last[0] : last[1]) as Record<string, unknown>;
};

const save = async (name = 'Save Changes') => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

beforeEach(() => {
  vi.mocked(createProject).mockClear();
  vi.mocked(updateProject).mockClear();
  useAppStore.setState({
    currentSite: { id: 1, name: 'Basel' } as Site,
    currentUser: makeUser({ id: 1, name: 'Ada Admin', role: 'admin' }),
    staff: [],
    projects: [project],
    tags: [],
    teams: [analytics, processTeam],
    projectFields: FIELDS,
    instanceSettings: null,
  });
});

afterEach(async () => {
  if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
  useUIStore.getState().closeModal();
  useViewStore.setState({ teamFilters: {} });
  vi.restoreAllMocks();
});

describe('ProjectModal project fields', () => {
  it('renders every field with its control, preloaded from the project', () => {
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);

    expect(screen.getByLabelText('Project type')).toHaveValue('11');
    expect(screen.getByLabelText('Budget')).toHaveValue(1250);
    expect(screen.getByRole('switch', { name: 'Regulated' })).not.toBeChecked();
    expect(screen.getByLabelText('Reference')).toHaveValue('PO-1');
    // Multi-select: pills in item order
    const area = screen.getByRole('combobox', { name: 'Area' });
    expect(area).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Process')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Analytics')).toBeInTheDocument();
  });

  it('sends only the fields that changed, and shows them in the store at once', async () => {
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);

    fireEvent.change(screen.getByLabelText('Budget'), { target: { value: '99.5' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Regulated' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Area' }));
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Area' })).getByRole('option', { name: 'QA' }));
    await save();

    expect(sent(updateProject).field_values).toEqual({ 2: [21, 22, 23], 3: 99.5, 4: true });
    expect(useAppStore.getState().projects[0].field_values).toEqual({
      1: 11,
      2: [21, 22, 23],
      3: 99.5,
      4: true,
      5: 'PO-1',
    });
  });

  it('clears fields: null for a value, [] for a multi-select; the store drops them', async () => {
    act(() => useUIStore.getState().openProjectModal({ ...project, field_values: { ...project.field_values, 4: true } }));
    render(<ProjectModal />);

    fireEvent.change(screen.getByLabelText('Project type'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Reference'), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('Budget'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Regulated' }));
    fireEvent.click(screen.getByLabelText('Remove Process'));
    fireEvent.click(screen.getByLabelText('Remove Analytics'));
    await save();

    expect(sent(updateProject).field_values).toEqual({ 1: null, 2: [], 3: null, 4: null, 5: null });
    expect(useAppStore.getState().projects[0].field_values).toEqual({});
  });

  it('sends no field_values when nothing changed', async () => {
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);
    await save();
    expect(sent(updateProject)).not.toHaveProperty('field_values');
  });

  it('sends the filled fields of a new project only', async () => {
    act(() => useUIStore.getState().openProjectModal());
    render(<ProjectModal />);
    fireEvent.change(screen.getByLabelText('Project Name *'), { target: { value: 'New study' } });
    fireEvent.change(screen.getByLabelText('Project type'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Reference'), { target: { value: ' PO-7 ' } });
    await save('Create Project');
    expect(sent(createProject).field_values).toEqual({ 1: 12, 5: 'PO-7' });
  });

  it("offers only the items applying to the project's site and teams, and drops the others on save", async () => {
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);

    // A Zurich-only item is not offered at Basel
    const type = screen.getByLabelText('Project type') as HTMLSelectElement;
    expect(Array.from(type.options).map((o) => o.text)).toEqual(['None', 'Internal', 'Customer']);

    // "Analytics" is limited to the Analytics team: unticking the team drops it
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    expect(screen.queryByLabelText('Remove Analytics')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: 'Area' }));
    const options = within(screen.getByRole('listbox', { name: 'Area' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Process', 'QA']);
    await save();
    expect(sent(updateProject).field_values).toEqual({ 2: [21] });
  });

  it('reads an item that no longer applies as none in a dropdown', () => {
    act(() => useUIStore.getState().openProjectModal({ ...project, field_values: { 1: 13 } }));
    render(<ProjectModal />);
    expect(screen.getByLabelText('Project type')).toHaveValue('');
  });

  it('a field created while the dialog is open starts empty', async () => {
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);
    act(() =>
      useAppStore.setState({
        projectFields: [...FIELDS, makeProjectField({ id: 6, name: 'Notes', field_type: 'text', sort_order: 5 })],
      })
    );
    expect(screen.getByLabelText('Notes')).toHaveValue('');
    await save();
    expect(sent(updateProject)).not.toHaveProperty('field_values');
  });
});

describe('ProjectModal built-in field labels and hidden fields', () => {
  it('labels the built-in fields with the custom labels', () => {
    useAppStore.setState({
      instanceSettings: { project_field_labels: '{"customer":"Client","sales_pm":"Account","volume":"Budget (EUR)","confirmed":"Won"}' },
    });
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);
    expect(screen.getByLabelText('Client')).toHaveValue('Acme');
    expect(screen.getByLabelText('Account')).toHaveValue('Sam');
    expect(screen.getByLabelText('Budget (EUR)')).toHaveValue(1000);
    expect(screen.getByRole('switch', { name: 'Won' })).not.toBeChecked();
    expect(screen.queryByLabelText('Customer')).not.toBeInTheDocument();
  });

  it('neither shows nor sends a hidden built-in field, and keeps its value', async () => {
    useAppStore.setState({ instanceSettings: { project_fields_hidden: '["customer","sales_pm","volume"]' } });
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);
    expect(screen.queryByLabelText('Customer')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Sales PM')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Project Volume (CHF)')).not.toBeInTheDocument();
    // Confirmed cannot be hidden
    expect(screen.getByRole('switch', { name: 'Project Confirmed' })).toBeInTheDocument();

    await save();
    const data = sent(updateProject);
    expect(data).not.toHaveProperty('customer');
    expect(data).not.toHaveProperty('sales_pm');
    expect(data).not.toHaveProperty('volume');
    const stored = useAppStore.getState().projects[0];
    expect([stored.customer, stored.sales_pm, stored.volume]).toEqual(['Acme', 'Sam', 1000]);
  });

  it('hides Sales PM alone and keeps Volume beside it', async () => {
    useAppStore.setState({ instanceSettings: { project_fields_hidden: '["sales_pm"]' } });
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);
    expect(screen.queryByLabelText('Sales PM')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Project Volume (CHF)'), { target: { value: '2000' } });
    await save();
    expect(sent(updateProject)).toMatchObject({ customer: 'Acme', volume: 2000 });
    expect(sent(updateProject)).not.toHaveProperty('sales_pm');
  });
});

describe('ProjectModal "Manage fields…"', () => {
  it('is shown to holders of project_fields.manage only', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 2, name: 'Sue', role: 'superuser' }) });
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);
    expect(screen.queryByRole('button', { name: 'Manage fields…' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Budget')).toBeInTheDocument();
  });

  it('shows nothing to others when no field exists, and a hint with the link to managers', () => {
    useAppStore.setState({ projectFields: [], currentUser: makeUser({ id: 2, name: 'Sue', role: 'superuser' }) });
    act(() => useUIStore.getState().openProjectModal(project));
    const { unmount } = render(<ProjectModal />);
    expect(screen.queryByText('No project fields yet.')).not.toBeInTheDocument();
    unmount();

    useAppStore.setState({ currentUser: makeUser({ id: 1, name: 'Ada Admin', role: 'admin' }) });
    render(<ProjectModal />);
    expect(screen.getByText('No project fields yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage fields…' })).toBeEnabled();
  });

  it('closes the dialog and opens Settings → Project fields after confirming', async () => {
    let answer = false;
    const confirm = stubConfirm(() => answer);
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);
    const link = screen.getByRole('button', { name: 'Manage fields…' });

    fireEvent.click(link);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith({
      title: 'Manage project fields',
      message: MANAGE_FIELDS_CONFIRM,
      confirmLabel: 'Open settings',
    });
    expect(useUIStore.getState().activeModal).toBe('project');

    answer = true;
    fireEvent.click(link);
    await waitFor(() => expect(useUIStore.getState().activeModal).toBe('settingsHub'));
    expect(useUIStore.getState().settingsSection).toBe('project-fields');
  });

  it('is disabled with the What-If hint while What-If is active', () => {
    const confirm = stubConfirm(true);
    act(() => useUIStore.getState().openProjectModal(project));
    useWhatIfStore.getState().enterWhatIfMode([]);
    render(<ProjectModal />);
    const link = screen.getByRole('button', { name: 'Manage fields…' });
    expect(link).toBeDisabled();
    expect(link).toHaveAttribute('title', whatIfUnavailableMessage('Managing project fields'));
    fireEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();
    // Filling the fields is a plan edit and stays available
    expect(screen.getByLabelText('Budget')).toBeEnabled();
  });

  it('locks the fields and the link while the save is in flight', async () => {
    let resolve: (v: unknown) => void = () => {};
    vi.mocked(updateProject).mockImplementationOnce(() => new Promise((r) => { resolve = r; }) as never);
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(screen.getByRole('button', { name: 'Manage fields…' })).toBeDisabled();
    expect(screen.getByLabelText('Budget')).toBeDisabled();
    expect(screen.getByLabelText('Project type')).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Regulated' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Area' })).toBeDisabled();
    await act(async () => resolve({}));
  });
});
