/**
 * DashboardsView, edit mode, over the real dashboardStore with a mocked API
 * (the grid is a fake that exposes its edit hooks): the toolbar per key,
 * dashboard and screen; New (dialog first, nothing sent until Save),
 * Duplicate, Share… (sharing only), Delete; edit mode with Add widget / Save /
 * Cancel, the inline name and description (Save asks for a name), whom the
 * dashboard is shared with; the
 * dirty guard on a dashboard switch and on leaving the view; a draft that
 * survives a live dashboard reload; nothing of the builder during What-If.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@/api/client';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { useDashboardStore, LIVE_RELOAD_DELAY_MS } from '@/stores/dashboardStore';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { resetAllStores } from '@/stores';
import { makeRole, makeSystemRoles, makeUser } from '@/test/factories';
import { stubConfirm } from '@/test/confirmDialog';
import { pickOption, pickerTrigger } from '@/test/searchableSelect';
import { viewLeaveGuard } from '@/utils/viewLeaveGuard';
import type { Dashboard, DashboardSummary, DashboardWidget, WidgetLayout } from '@/types';
import { DashboardsView, DELETED_TEXT, FIRST_WIDGET_TEXT, NAME_REQUIRED_TEXT } from '../DashboardsView';
import { NO_TARGET_TEXT } from '../SharedWithLine';

vi.mock('@/api/endpoints/dashboards', () => ({
  dashboardsApi: {
    list: vi.fn(),
    shareableUsers: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    query: vi.fn(),
    data: vi.fn(),
  },
}));

interface FakeGridProps {
  widgets: DashboardWidget[];
  editing: boolean;
  onLayoutChange?: (layouts: Record<number, WidgetLayout>) => void;
  onEditWidget?: (id: number) => void;
  onRemoveWidget?: (id: number) => void;
}

vi.mock('../DashboardGrid', () => ({
  DashboardGrid: ({ widgets, editing, onLayoutChange, onEditWidget, onRemoveWidget }: FakeGridProps) => (
    <div data-testid="grid" data-editing={String(editing)}>
      {widgets.map((w) => (
        <div key={w.id} data-testid={`widget-${w.id}`}>
          <p>{w.title}</p>
          {onEditWidget && <button onClick={() => onEditWidget(w.id)}>{`Edit ${w.title}`}</button>}
          {onRemoveWidget && <button onClick={() => onRemoveWidget(w.id)}>{`Remove ${w.title}`}</button>}
        </div>
      ))}
      {onLayoutChange && (
        <button
          onClick={() =>
            onLayoutChange(
              Object.fromEntries(
                widgets.map((w) => [w.id, { ...w.layout, lg: { ...w.layout.lg, x: w.layout.lg.x + 1 } }])
              )
            )
          }
        >
          Move widgets
        </button>
      )}
    </div>
  ),
}));

vi.mock('../charts/EChart', () => ({ EChart: () => <div data-testid="echart" /> }));

const api = vi.mocked(dashboardsApi);

const layout = (y: number): WidgetLayout => ({
  lg: { x: 0, y, w: 6, h: 5 },
  md: { x: 0, y, w: 4, h: 5 },
  sm: { x: 0, y, w: 4, h: 5 },
});

const summary = (id: number, name: string, extra: Partial<DashboardSummary> = {}): DashboardSummary => ({
  id,
  name,
  description: null,
  visibility: 'everyone',
  role_ids: [],
  site_ids: [],
  team_ids: [],
  user_ids: [],
  shared_with: { roles: [], sites: [], teams: [], users: [] },
  owner_id: 1,
  owner_name: 'Ada Admin',
  is_default: false,
  widget_count: 2,
  can_edit: true,
  updated_at: '2026-10-23T10:00:00.000Z',
  ...extra,
});

const LIST = [
  summary(1, 'Overview', { is_default: true, owner_id: null, owner_name: null }),
  summary(2, 'Mine'),
  summary(3, 'Theirs', { owner_id: 9, owner_name: 'Bob Brown', can_edit: false }),
];

const widget = (id: number, title: string, y = 0): DashboardWidget => ({
  id,
  kind: 'bar',
  title,
  query: { measure: 'booked_weeks', filters: { period: { relative: 'this_year' } } },
  options: {},
  layout: layout(y),
  sort_order: 0,
});

const detail = (id: number, extra: Partial<Dashboard> = {}): Dashboard => ({
  ...(LIST.find((d) => d.id === id) ?? summary(id, `Dashboard ${id}`)),
  widgets: [widget(id * 10, `First of ${id}`), widget(id * 10 + 1, `Second of ${id}`, 5)],
  ...extra,
});

const button = (name: string) => screen.queryByRole('button', { name });
const toolbarButtons = () =>
  within(document.querySelector('[data-slot="builder-actions"]') as HTMLElement)
    .getAllByRole('button')
    .map((b) => b.textContent);

function signIn(role: string) {
  useAppStore.setState({ currentUser: makeUser({ id: 1, role, site_ids: [1] }) });
}

async function renderOn(id: number) {
  useViewStore.setState({ lastDashboardId: { '': id } });
  render(<DashboardsView />);
  await screen.findByText(`First of ${id}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  useViewStore.setState({ lastDashboardId: {}, currentView: 'dashboards' });
  signIn('superuser');
  useAppStore.setState({ roles: makeSystemRoles(makeRole({ id: 4, key: 'team_lead', name: 'Team Lead' })) });
  api.list.mockResolvedValue(LIST);
  api.get.mockImplementation(async (id: number) => detail(id));
  api.data.mockResolvedValue({ widgets: {}, loaded_at: '2026-10-23T10:00:00.000Z' });
  api.shareableUsers.mockResolvedValue([
    { id: 6, name: 'Diana Doe', job_title: null, site_names: ['Winterthur'] },
  ]);
  api.query.mockResolvedValue({
    unit: 'weeks',
    dimensions: [],
    rows: [{ keys: [], value: 3 }],
    total: 3,
    truncated: false,
    warnings: [],
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
});

describe('DashboardsView — toolbar', () => {
  it('offers New, Duplicate, Edit, Share… and Delete on a dashboard the user may edit', async () => {
    await renderOn(2);
    expect(toolbarButtons()).toEqual(['New', 'Duplicate', 'Edit', 'Share…', 'Delete']);
  });

  it('offers only New and Duplicate on a dashboard someone else owns', async () => {
    await renderOn(3);
    expect(toolbarButtons()).toEqual(['New', 'Duplicate']);
  });

  it('keeps Delete of the default dashboard to administrators', async () => {
    await renderOn(1);
    expect(toolbarButtons()).toEqual(['New', 'Duplicate', 'Edit', 'Share…']);
  });

  it('lets an administrator delete the default dashboard', async () => {
    signIn('admin');
    await renderOn(1);
    expect(toolbarButtons()).toEqual(['New', 'Duplicate', 'Edit', 'Share…', 'Delete']);
  });

  it('offers New alone when nothing is open', async () => {
    api.list.mockResolvedValue([]);
    render(<DashboardsView />);
    await screen.findByText('No dashboard is shared with you yet.');
    expect(toolbarButtons()).toEqual(['New']);
  });

  it('shows no builder without dashboards.manage', async () => {
    signIn('user');
    await renderOn(2);
    expect(button('New')).not.toBeInTheDocument();
    expect(button('Edit')).not.toBeInTheDocument();
  });

  it('shows no builder on a phone', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }))
    );
    await renderOn(2);
    expect(button('New')).not.toBeInTheDocument();
  });

  it('is out of reach during What-If, and shows no builder if it ever renders then', async () => {
    useViewStore.setState({ currentView: 'gantt' });
    useWhatIfStore.getState().enterWhatIfMode([]);
    useViewStore.getState().setCurrentView('dashboards');
    expect(useViewStore.getState().currentView).toBe('gantt');
    await renderOn(2);
    expect(button('New')).not.toBeInTheDocument();
    expect(button('Edit')).not.toBeInTheDocument();
  });

  it('says a shared dashboard has no one left', async () => {
    const stranded = summary(4, 'Stranded', { visibility: 'shared' });
    api.list.mockResolvedValue([...LIST, stranded]);
    api.get.mockResolvedValue({ ...stranded, widgets: [widget(40, 'First of 4')] });
    await renderOn(4);
    expect(screen.getByText(NO_TARGET_TEXT)).toBeInTheDocument();
    expect(pickerTrigger(/^Dashboard/)).toHaveTextContent('Stranded');
  });
});

describe('DashboardsView — New, Duplicate, Share…, Delete', () => {
  it('creates a dashboard through the dialog, an empty draft until Save', async () => {
    await renderOn(2);
    fireEvent.click(button('New')!);
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Capacity' } });
    fireEvent.click(button('Create dashboard')!);
    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getByText(FIRST_WIDGET_TEXT)).toBeInTheDocument();
    expect(toolbarButtons()).toEqual(['Add widget', 'Save', 'Cancel']);
    expect(screen.getByRole('button', { name: /^Dashboard/ })).toHaveTextContent('Capacity');
    expect(screen.getByLabelText('Name *')).toHaveValue('Capacity');
    expect(screen.getByText('Only you (and administrators)')).toBeInTheDocument();
    expect(useDashboardStore.getState().editing).toBe(true);

    // The first widget, from the empty state
    const addButtons = screen.getAllByRole('button', { name: 'Add widget' });
    fireEvent.click(addButtons[addButtons.length - 1]);
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Weeks' } });
    await waitFor(() => expect(api.query).toHaveBeenCalled(), { timeout: 2000 });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add widget' })).getByRole('button', { name: 'Add widget' }));
    expect(screen.getByText('Weeks')).toBeInTheDocument();

    const created = detail(8, { name: 'Capacity', visibility: 'private', widgets: [widget(81, 'Weeks')] });
    api.create.mockResolvedValue(created);
    api.list.mockResolvedValue([...LIST, summary(8, 'Capacity', { visibility: 'private' })]);
    await act(async () => {
      fireEvent.click(button('Save')!);
    });
    expect(api.create).toHaveBeenCalledWith({
      name: 'Capacity',
      description: null,
      visibility: 'private',
      role_ids: [],
      site_ids: [],
      team_ids: [],
      user_ids: [],
      widgets: [
        {
          kind: 'bar',
          title: 'Weeks',
          query: { measure: 'booked_weeks', filters: { period: { relative: 'this_year' } } },
          options: {},
          layout: layout(0),
          sort_order: 0,
        },
      ],
    });
    expect(toolbarButtons()).toEqual(['New', 'Duplicate', 'Edit', 'Share…', 'Delete']);
    expect(useDashboardStore.getState().current?.id).toBe(8);
    expect(useDashboardStore.getState().editing).toBe(false);
  });

  it('closes the New dialog on Cancel without a draft', async () => {
    await renderOn(2);
    fireEvent.click(button('New')!);
    fireEvent.click(button('Cancel')!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button('Edit')).toBeInTheDocument();
  });

  it('duplicates into "Copy of …" and opens the copy in edit mode', async () => {
    api.create.mockResolvedValue(detail(9, { name: 'Copy of Theirs', owner_id: 1, can_edit: true }));
    await renderOn(3);
    await act(async () => {
      fireEvent.click(button('Duplicate')!);
    });
    expect(api.create).toHaveBeenCalledWith({
      name: 'Copy of Theirs',
      visibility: 'private',
      role_ids: [],
      site_ids: [],
      team_ids: [],
      user_ids: [],
      source_id: 3,
    });
    expect(toolbarButtons()).toEqual(['Add widget', 'Save', 'Cancel']);
    expect(screen.getByText('First of 9')).toBeInTheDocument();
  });

  it('says so when a copy fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.create.mockRejectedValue(new Error('Server down'));
    await renderOn(3);
    await act(async () => {
      fireEvent.click(button('Duplicate')!);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Server down');
  });

  it('shares the open dashboard with a PUT that keeps its name, description and widgets', async () => {
    const shared = detail(2, {
      description: 'Per team',
      visibility: 'shared',
      role_ids: [4],
      user_ids: [6],
      shared_with: { roles: [{ id: 4, name: 'Team Lead' }], sites: [], teams: [], users: [{ id: 6, name: 'Diana Doe' }] },
    });
    api.get.mockImplementation(async (id: number) => detail(id, { description: 'Per team' }));
    api.update.mockResolvedValue(shared);
    await renderOn(2);
    fireEvent.click(button('Share…')!);
    expect(screen.getByRole('dialog', { name: 'Share dashboard' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Name *')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'shared' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Team Lead' }));
    await waitFor(() => expect(pickerTrigger(/^People/)).not.toBeDisabled());
    pickOption(/^People/, 'Diana Doe');
    await act(async () => {
      fireEvent.click(button('Save Changes')!);
    });
    expect(api.update).toHaveBeenCalledWith(2, {
      name: 'Mine',
      description: 'Per team',
      visibility: 'shared',
      role_ids: [4],
      site_ids: [],
      team_ids: [],
      user_ids: [6],
    });
    expect(api.update.mock.calls[0][1]).not.toHaveProperty('widgets');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const chips = within(screen.getByRole('list', { name: 'Shared with' }));
    expect(chips.getByText('Team Lead')).toBeInTheDocument();
    expect(chips.getByText('Diana Doe')).toBeInTheDocument();
  });

  it('closes the Share… dialog on Cancel without a request', async () => {
    await renderOn(2);
    fireEvent.click(button('Share…')!);
    await act(async () => {});
    fireEvent.click(button('Cancel')!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.update).not.toHaveBeenCalled();
  });

  it('shows a new shared draft’s targets from the dialog until it is saved', async () => {
    await renderOn(2);
    fireEvent.click(button('New')!);
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Leads' } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'shared' } });
    await waitFor(() => expect(pickerTrigger(/^People/)).not.toBeDisabled());
    pickOption(/^People/, 'Diana Doe');
    fireEvent.click(button('Create dashboard')!);
    expect(within(screen.getByRole('list', { name: 'Shared with' })).getByText('Diana Doe')).toBeInTheDocument();
  });

  it('deletes after a confirm naming the dashboard, then opens the next one', async () => {
    const confirm = stubConfirm(false);
    api.remove.mockResolvedValue(undefined);
    await renderOn(2);
    await act(async () => {
      fireEvent.click(button('Delete')!);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Delete dashboard "Mine"? Its widgets are deleted with it. This cannot be undone.',
        destructive: true,
      })
    );
    expect(api.remove).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    api.list.mockResolvedValue(LIST.filter((d) => d.id !== 2));
    await act(async () => {
      fireEvent.click(button('Delete')!);
    });
    expect(api.remove).toHaveBeenCalledWith(2);
    expect(await screen.findByText('First of 1')).toBeInTheDocument();
    expect(useUIStore.getState().flashNotice).toMatchObject({ message: DELETED_TEXT, tone: 'info' });
    expect(DELETED_TEXT).toBe('Dashboard deleted');
  });

  it('says so when a delete fails', async () => {
    stubConfirm(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.remove.mockRejectedValue(new ApiError('Only an administrator can delete the default dashboard', 403));
    await renderOn(2);
    await act(async () => {
      fireEvent.click(button('Delete')!);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Only an administrator can delete the default dashboard');
  });
});

describe('DashboardsView — edit mode', () => {
  async function editing(id = 2) {
    await renderOn(id);
    fireEvent.click(button('Edit')!);
    expect(screen.getByTestId('grid')).toHaveAttribute('data-editing', 'true');
  }

  it('edits a widget, removes one, moves them and saves the whole dashboard', async () => {
    api.update.mockResolvedValue(detail(2, { widgets: [widget(30, 'Renamed')] }));
    await editing();
    expect(screen.getByRole('status')).toHaveTextContent(/^Editing$/);
    expect(button('Refresh')).not.toBeInTheDocument();

    fireEvent.click(button('Edit First of 2')!);
    const dialog = screen.getByRole('dialog', { name: 'Edit widget' });
    fireEvent.change(within(dialog).getByLabelText('Title *'), { target: { value: 'Renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    expect(screen.getByText('Renamed')).toBeInTheDocument();

    fireEvent.click(button('Remove Second of 2')!);
    expect(screen.queryByText('Second of 2')).not.toBeInTheDocument();
    fireEvent.click(button('Move widgets')!);
    expect(screen.getByRole('status')).toHaveTextContent('Editing — unsaved changes');

    await act(async () => {
      fireEvent.click(button('Save')!);
    });
    const [id, body] = api.update.mock.calls[0];
    expect(id).toBe(2);
    expect(body.widgets).toEqual([
      expect.objectContaining({ title: 'Renamed', layout: { ...layout(0), lg: { x: 1, y: 0, w: 6, h: 5 } } }),
    ]);
    expect(screen.getByText('Renamed')).toBeInTheDocument();
    expect(screen.getByTestId('grid')).toHaveAttribute('data-editing', 'false');
  });

  it('edits the name and description inline, and saves them with the sharing kept', async () => {
    const shared = {
      visibility: 'shared' as const,
      site_ids: [1],
      team_ids: [10],
      shared_with: {
        roles: [],
        sites: [{ id: 1, name: 'Winterthur' }],
        teams: [{ id: 10, name: 'QA & Compliance', site_name: 'Winterthur' }],
        users: [],
      },
    };
    api.get.mockImplementation(async (id: number) => detail(id, { description: 'Old words', ...shared }));
    api.update.mockResolvedValue(detail(2, { name: 'Renamed', description: 'New words', ...shared }));
    await editing();
    expect(screen.queryByText('Old words', { selector: 'p' })).not.toBeInTheDocument();
    const name = screen.getByLabelText('Name *');
    const description = screen.getByLabelText('Description');
    expect(name).toHaveValue('Mine');
    expect(name).toHaveAttribute('maxLength', '100');
    expect(description).toHaveValue('Old words');
    expect(description).toHaveAttribute('maxLength', '2000');
    // Whom it is shared with stays in sight while editing
    expect(within(screen.getByRole('list', { name: 'Shared with' })).getByText('QA & Compliance')).toBeInTheDocument();

    fireEvent.change(name, { target: { value: ' Renamed ' } });
    expect(screen.getByRole('status')).toHaveTextContent('Editing — unsaved changes');
    fireEvent.change(description, { target: { value: '' } });
    fireEvent.change(description, { target: { value: 'New words ' } });
    await act(async () => {
      fireEvent.click(button('Save')!);
    });
    expect(api.update.mock.calls[0][1]).toMatchObject({
      name: 'Renamed',
      description: 'New words',
      visibility: 'shared',
      role_ids: [],
      site_ids: [1],
      team_ids: [10],
      user_ids: [],
    });
    expect(button('Edit')).toBeInTheDocument();
    expect(screen.getByText('New words')).toBeInTheDocument();
  });

  it('is unchanged again once the description is cleared back to none', async () => {
    await editing();
    const description = screen.getByLabelText('Description');
    fireEvent.change(description, { target: { value: 'x' } });
    expect(screen.getByRole('status')).toHaveTextContent('Editing — unsaved changes');
    fireEvent.change(description, { target: { value: '' } });
    expect(screen.getByRole('status')).toHaveTextContent(/^Editing$/);
  });

  it('asks for a name before saving, and sends nothing without one', async () => {
    await editing();
    const name = screen.getByLabelText('Name *');
    fireEvent.change(name, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.click(button('Save')!);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(NAME_REQUIRED_TEXT);
    expect(NAME_REQUIRED_TEXT).toBe('Enter a name');
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(api.update).not.toHaveBeenCalled();
    expect(toolbarButtons()).toEqual(['Add widget', 'Save', 'Cancel']);
    fireEvent.change(name, { target: { value: 'Back' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('forgets the name warning when edit mode ends', async () => {
    stubConfirm(true);
    await editing();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(button('Save')!);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(NAME_REQUIRED_TEXT);
    await act(async () => {
      fireEvent.click(button('Cancel')!);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Name *')).not.toBeInTheDocument();
    fireEvent.click(button('Edit')!);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name *')).toHaveValue('Mine');
  });

  it('closes the widget editor on Cancel', async () => {
    await editing();
    fireEvent.click(button('Add widget')!);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add widget' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays in edit mode with the server’s words when the save fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.update.mockRejectedValue(new ApiError('body: "Pie": A pie chart needs one dimension', 422));
    await editing();
    await act(async () => {
      fireEvent.click(button('Save')!);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('"Pie": A pie chart needs one dimension');
    expect(toolbarButtons()).toEqual(['Add widget', 'Save', 'Cancel']);
  });

  it('leaves at once when nothing changed, and asks when something did', async () => {
    const confirm = stubConfirm(false);
    await editing();
    await act(async () => {
      fireEvent.click(button('Cancel')!);
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(button('Edit')).toBeInTheDocument();

    fireEvent.click(button('Edit')!);
    fireEvent.click(button('Remove First of 2')!);
    await act(async () => {
      fireEvent.click(button('Cancel')!);
    });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Discard the changes to this dashboard?' }));
    expect(screen.queryByText('First of 2')).not.toBeInTheDocument();
    confirm.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(button('Cancel')!);
    });
    expect(screen.getByText('First of 2')).toBeInTheDocument();
  });

  it('asks before switching dashboard with unsaved changes, and opens nothing under the draft', async () => {
    const confirm = stubConfirm(false);
    await editing();
    fireEvent.click(button('Remove First of 2')!);
    pickOption(/^Dashboard/, 'Overview');
    await act(async () => {});
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('grid')).toHaveAttribute('data-editing', 'true');
    confirm.mockResolvedValue(true);
    pickOption(/^Dashboard/, 'Overview');
    await act(async () => {});
    expect(await screen.findByText('First of 1')).toBeInTheDocument();
    expect(useDashboardStore.getState().editing).toBe(false);
    expect(screen.getByTestId('grid')).toHaveAttribute('data-editing', 'false');
  });

  it('switches at once when the draft is unchanged', async () => {
    const confirm = stubConfirm(false);
    await editing();
    pickOption(/^Dashboard/, 'Overview');
    await act(async () => {});
    expect(confirm).not.toHaveBeenCalled();
    expect(await screen.findByText('First of 1')).toBeInTheDocument();
  });

  it('keeps the draft through a live dashboard reload, and reloads once editing ends', async () => {
    stubConfirm(true);
    await editing();
    fireEvent.click(button('Remove Second of 2')!);
    vi.useFakeTimers();
    api.get.mockResolvedValue(detail(2, { widgets: [widget(50, 'Remote change')] }));
    // What the WebSocket provider does on change:dashboard
    await act(async () => {
      await useDashboardStore.getState().refreshList();
      useDashboardStore.getState().refreshCurrent();
      await vi.advanceTimersByTimeAsync(LIVE_RELOAD_DELAY_MS);
    });
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(screen.getByText('First of 2')).toBeInTheDocument();
    expect(screen.queryByText('Second of 2')).not.toBeInTheDocument();
    expect(screen.queryByText('Remote change')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(button('Cancel')!);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Remote change')).toBeInTheDocument();
  });

  it('guards leaving the view while editing', async () => {
    const confirm = stubConfirm(false);
    await editing();
    expect(viewLeaveGuard()).not.toBeNull();
    fireEvent.click(button('Remove First of 2')!);
    await expect(viewLeaveGuard()!()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('keeps Save and Cancel when the screen narrows to a phone mid-edit', async () => {
    const listeners = new Set<() => void>();
    const list = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => list));
    await editing();
    act(() => {
      list.matches = true;
      listeners.forEach((fn) => fn());
    });
    expect(toolbarButtons()).toEqual(['Add widget', 'Save', 'Cancel']);
  });

  it('caps a dashboard at 50 widgets', async () => {
    api.get.mockImplementation(async (id: number) =>
      detail(id, { widgets: Array.from({ length: 50 }, (_, i) => widget(100 + i, `W${i}`, i * 5)) })
    );
    useViewStore.setState({ lastDashboardId: { '': 2 } });
    render(<DashboardsView />);
    await screen.findByText('W0');
    fireEvent.click(button('Edit')!);
    expect(button('Add widget')).toBeDisabled();
    expect(button('Add widget')).toHaveAttribute('title', 'A dashboard holds at most 50 widgets');
  });
});
