/**
 * DashboardDialog: New hands the values (and the targets' names) back
 * without a request; Share… has no name field and saves the dashboard's
 * name and description with the new sharing, without a `widgets` key; the
 * targets block (roles, sites, teams, people) shows only for *Shared with…*
 * and needs one target; the people load when the dialog opens (loading /
 * failure); targets no longer pickable are kept; the server's refusal shows
 * in a Notice, and one save runs at a time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@/api/client';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { useAppStore } from '@/stores/appStore';
import { resetAllStores } from '@/stores';
import { makeRole, makeSite, makeSystemRoles, makeTeam, makeUser } from '@/test/factories';
import { openPicker, optionLabel, pickOption, pickerOptions, pickerTrigger } from '@/test/searchableSelect';
import type { Dashboard, ShareableUser, SharedWith } from '@/types';
import { DashboardDialog, KEPT_HINT, NAME_REQUIRED, PEOPLE_FAILED, PEOPLE_LOADING, TARGET_REQUIRED } from '../DashboardDialog';
import type { DashboardMeta } from '../widgetDraft';

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

const api = vi.mocked(dashboardsApi);

const ROLES = makeSystemRoles(makeRole({ id: 4, key: 'team_lead', name: 'Team Lead', sort_order: 3 }));
const SITES = [makeSite({ id: 1, name: 'Winterthur' }), makeSite({ id: 2, name: 'Frankfurt' }), makeSite({ id: 3, name: 'Basel' })];
const TEAMS = [
  makeTeam({ id: 10, site_id: 1, name: 'QA & Compliance', color: '#10b981' }),
  makeTeam({ id: 11, site_id: 2, name: 'Lab', active: false }),
  makeTeam({ id: 12, site_id: 3, name: 'Elsewhere' }),
];
const PEOPLE: ShareableUser[] = [
  { id: 5, name: 'Charlie Chen', job_title: 'Chemist', site_names: ['Winterthur'] },
  { id: 6, name: 'Diana Doe', job_title: null, site_names: ['Frankfurt', 'Winterthur'] },
  { id: 7, name: 'Ivy Admin', job_title: null, site_names: [] },
];

const NO_ONE: SharedWith = { roles: [], sites: [], teams: [], users: [] };

const saved: Dashboard = {
  id: 7,
  name: 'Plan',
  description: null,
  visibility: 'everyone',
  role_ids: [],
  site_ids: [],
  team_ids: [],
  user_ids: [],
  shared_with: NO_ONE,
  owner_id: 1,
  owner_name: 'Ada',
  is_default: false,
  widget_count: 2,
  can_edit: true,
  updated_at: '2026-10-23T10:00:00.000Z',
  widgets: [],
};

const EMPTY: DashboardMeta = {
  name: '',
  description: null,
  visibility: 'private',
  role_ids: [],
  site_ids: [],
  team_ids: [],
  user_ids: [],
};

const meta = (extra: Partial<DashboardMeta> = {}): DashboardMeta => ({ ...EMPTY, name: 'Plan', ...extra });

function renderDialog(props: Partial<Parameters<typeof DashboardDialog>[0]> = {}) {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(<DashboardDialog mode="new" initial={EMPTY} onClose={onClose} onDone={onDone} {...props} />);
  return { onDone, onClose };
}

/** Wait for the people to land (the picker turns enabled). */
async function peopleLoaded() {
  await waitFor(() => expect(pickerTrigger(/^People/)).not.toBeDisabled());
}

async function share(extra: Partial<DashboardMeta> = {}, sharedWith?: SharedWith) {
  const result = renderDialog({ mode: 'share', dashboardId: 7, initial: meta(extra), sharedWith });
  if ((extra.visibility ?? 'private') === 'shared') await peopleLoaded();
  return result;
}

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  useAppStore.setState({
    roles: ROLES,
    sites: SITES,
    teams: TEAMS,
    currentUser: makeUser({ id: 1, role: 'superuser', site_ids: [1, 2] }),
  });
  api.list.mockResolvedValue([]);
  api.shareableUsers.mockResolvedValue(PEOPLE);
  api.data.mockResolvedValue({ widgets: {}, loaded_at: '2026-10-23T10:00:00.000Z' });
  api.update.mockResolvedValue(saved);
});

describe('DashboardDialog — New', () => {
  it('hands the values of a new dashboard back, without a request', async () => {
    const { onDone } = renderDialog();
    expect(screen.getByRole('dialog', { name: 'New dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Roles that see this dashboard' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: '  Capacity  ' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: ' Per team ' } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'everyone' } });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    expect(onDone).toHaveBeenCalledWith(
      {
        name: 'Capacity',
        description: 'Per team',
        visibility: 'everyone',
        role_ids: [],
        site_ids: [],
        team_ids: [],
        user_ids: [],
      },
      NO_ONE
    );
    expect(api.create).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  });

  it('requires a name', async () => {
    const { onDone } = renderDialog();
    await act(async () => {});
    fireEvent.submit(screen.getByLabelText('Name *').closest('form')!);
    expect(screen.getByText(NAME_REQUIRED)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'A' } });
    expect(screen.queryByText(NAME_REQUIRED)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name *')).toHaveAttribute('maxLength', '100');
    expect(screen.getByLabelText('Description')).toHaveAttribute('maxLength', '2000');
  });

  it('requires one target when shared, and hands back every kind with its names', async () => {
    const { onDone } = renderDialog({ initial: { ...EMPTY, name: 'Leads' } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'shared' } });
    expect(screen.getByLabelText('Visibility')).toHaveAccessibleDescription(/in one of these teams or named here/);
    await peopleLoaded();
    const group = screen.getByRole('group', { name: 'Roles that see this dashboard' });
    expect(within(group).getByRole('checkbox', { name: /Admin/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    expect(screen.getByRole('alert')).toHaveTextContent(TARGET_REQUIRED);
    expect(TARGET_REQUIRED).toBe('Choose at least one role, site, team or person');
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(within(group).getByRole('checkbox', { name: 'Team Lead' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    pickOption(/^Sites/, 'Frankfurt');
    pickOption(/^Teams/, 'QA & Compliance');
    pickOption(/^People/, 'Diana Doe');
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    expect(onDone).toHaveBeenCalledWith(
      {
        name: 'Leads',
        description: null,
        visibility: 'shared',
        role_ids: [4],
        site_ids: [2],
        team_ids: [10],
        user_ids: [6],
      },
      {
        roles: [{ id: 4, name: 'Team Lead' }],
        sites: [{ id: 2, name: 'Frankfurt' }],
        teams: [{ id: 10, name: 'QA & Compliance', site_name: 'Winterthur' }],
        users: [{ id: 6, name: 'Diana Doe' }],
      }
    );
  });

  it('accepts a single site, team or person as the one target', async () => {
    const { onDone } = renderDialog({ initial: { ...EMPTY, name: 'One', visibility: 'shared' } });
    await peopleLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    expect(screen.getByRole('alert')).toHaveTextContent(TARGET_REQUIRED);
    pickOption(/^People/, 'Ivy Admin');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    expect(onDone.mock.calls[0][0]).toMatchObject({ visibility: 'shared', user_ids: [7], role_ids: [], site_ids: [] });
  });
});

describe('DashboardDialog — the targets', () => {
  it('shows the targets only while Shared with… is chosen', async () => {
    await share({ visibility: 'everyone' });
    expect(screen.getByLabelText('Visibility')).toHaveValue('everyone');
    expect(screen.queryByRole('group', { name: 'Roles that see this dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Sites/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'shared' } });
    expect(screen.getByRole('group', { name: 'Roles that see this dashboard' })).toBeInTheDocument();
    expect(pickerTrigger(/^Sites/)).toBeInTheDocument();
    expect(pickerTrigger(/^Teams/)).toBeInTheDocument();
    expect(pickerTrigger(/^People/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'private' } });
    expect(screen.queryByRole('button', { name: /^Teams/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Visibility')).toHaveAccessibleDescription('Only you (and administrators) see it.');
  });

  it('offers the visible sites, their teams (inactive marked) and the shareable people', async () => {
    await share({ visibility: 'shared', role_ids: [2] });
    expect(pickerOptions(/^Sites/).map(optionLabel)).toEqual(['Winterthur', 'Frankfurt']);
    const teams = pickerOptions(/^Teams/);
    expect(teams.map(optionLabel)).toEqual(['QA & Compliance', 'Lab']);
    expect(teams[0]).toHaveTextContent('Winterthur');
    expect(teams[1]).toHaveTextContent('Frankfurt (inactive)');
    const people = pickerOptions(/^People/);
    expect(people.map(optionLabel)).toEqual(['Charlie Chen', 'Diana Doe', 'Ivy Admin']);
    expect(people[0]).toHaveTextContent('Chemist · Winterthur');
    expect(people[1]).toHaveTextContent('Frankfurt, Winterthur');
    expect(api.shareableUsers).toHaveBeenCalledTimes(1);
  });

  it('offers every site to a user who sees them all', async () => {
    useAppStore.setState({ currentUser: makeUser({ id: 1, role: 'admin' }) });
    await share({ visibility: 'shared', role_ids: [2] });
    expect(pickerOptions(/^Sites/).map(optionLabel)).toEqual(['Winterthur', 'Frankfurt', 'Basel']);
    expect(pickerOptions(/^Teams/).map(optionLabel)).toContain('Elsewhere');
  });

  it('says the people are loading, then lists them', async () => {
    let release!: (users: ShareableUser[]) => void;
    api.shareableUsers.mockReturnValueOnce(new Promise((r) => (release = r)));
    renderDialog({ initial: { ...EMPTY, name: 'P', visibility: 'shared' } });
    expect(pickerTrigger(/^People/)).toBeDisabled();
    expect(pickerTrigger(/^People/)).toHaveTextContent(PEOPLE_LOADING);
    expect(PEOPLE_LOADING).toBe('Loading people…');
    await act(async () => release(PEOPLE));
    expect(pickerTrigger(/^People/)).not.toBeDisabled();
    expect(pickerTrigger(/^People/)).toHaveTextContent('None');
  });

  it('says when the people could not be loaded, and still shares with the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.shareableUsers.mockRejectedValueOnce(new Error('down'));
    const { onDone } = renderDialog({ initial: { ...EMPTY, name: 'P', visibility: 'shared' } });
    expect(await screen.findByText(PEOPLE_FAILED)).toBeInTheDocument();
    expect(PEOPLE_FAILED).toBe('People could not be loaded');
    expect(pickerTrigger(/^People/)).toBeDisabled();
    pickOption(/^Sites/, 'Winterthur');
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    expect(onDone.mock.calls[0][0]).toMatchObject({ site_ids: [1], user_ids: [] });
  });

  it('ignores the people when the dialog closed before they landed', async () => {
    let release!: (users: ShareableUser[]) => void;
    api.shareableUsers.mockReturnValueOnce(new Promise((r) => (release = r)));
    const { unmount } = render(
      <DashboardDialog mode="new" initial={EMPTY} onClose={vi.fn()} onDone={vi.fn()} />
    );
    unmount();
    await act(async () => release(PEOPLE));
    let fail!: (err: Error) => void;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.shareableUsers.mockReturnValueOnce(new Promise((_, r) => (fail = r)));
    const second = render(<DashboardDialog mode="new" initial={EMPTY} onClose={vi.fn()} onDone={vi.fn()} />);
    second.unmount();
    await act(async () => fail(new Error('late')));
    expect(screen.queryByText(PEOPLE_FAILED)).not.toBeInTheDocument();
  });

  it('keeps targets already on the dashboard that the user could not pick now', async () => {
    const kept: SharedWith = {
      roles: [],
      sites: [{ id: 3, name: 'Basel' }],
      teams: [{ id: 12, name: 'Elsewhere', site_name: 'Basel' }],
      users: [{ id: 9, name: 'Edward Gone' }],
    };
    await share({ visibility: 'shared', site_ids: [3], team_ids: [12], user_ids: [9] }, kept);
    expect(pickerTrigger(/^Sites/)).toHaveTextContent('Basel');
    expect(pickerTrigger(/^Teams/)).toHaveTextContent('Elsewhere');
    expect(pickerTrigger(/^People/)).toHaveTextContent('Edward Gone');
    expect(pickerOptions(/^Teams/).find((o) => optionLabel(o) === 'Elsewhere')).toHaveTextContent('Basel');
    pickOption(/^Sites/, 'Winterthur');
    await save();
    expect(api.update).toHaveBeenCalledWith(7, expect.objectContaining({ site_ids: [1, 3], team_ids: [12], user_ids: [9] }));
  });

  it('marks the kept targets, a kept team the app knows with its colour and inactive mark', async () => {
    useAppStore.setState({ currentUser: makeUser({ id: 1, role: 'superuser', site_ids: [1] }) });
    const kept: SharedWith = {
      roles: [],
      sites: [{ id: 2, name: 'Frankfurt' }],
      teams: [
        { id: 11, name: 'Lab', site_name: 'Frankfurt' },
        { id: 99, name: 'Deleted team', site_name: 'Basel' },
      ],
      users: [
        { id: 5, name: 'Charlie Chen' },
        { id: 9, name: 'Edward Gone' },
      ],
    };
    await share({ visibility: 'shared', site_ids: [2], team_ids: [11, 99], user_ids: [5, 9] }, kept);
    const sites = pickerOptions(/^Sites/);
    expect(sites.map(optionLabel)).toEqual(['Winterthur', 'Frankfurt']);
    expect(sites[0]).not.toHaveTextContent(KEPT_HINT);
    expect(sites[1]).toHaveTextContent(KEPT_HINT);
    expect(KEPT_HINT).toBe('No longer among your choices');
    const teams = pickerOptions(/^Teams/);
    expect(teams.map(optionLabel)).toEqual(['QA & Compliance', 'Lab', 'Deleted team']);
    // Lab is still in appStore.teams: its colour, its site and "(inactive)"
    expect(teams[1]).toHaveTextContent(`Frankfurt (inactive) · ${KEPT_HINT}`);
    expect(teams[1].querySelector('span[style*="background"]')).toHaveStyle({ backgroundColor: '#3b82f6' });
    // A team the app no longer knows: the name and site the server sent
    expect(teams[2]).toHaveTextContent(`Basel · ${KEPT_HINT}`);
    expect(teams[2].querySelector('span[style*="background"]')).toBeNull();
    const people = pickerOptions(/^People/);
    expect(people.map(optionLabel)).toEqual(['Charlie Chen', 'Diana Doe', 'Ivy Admin', 'Edward Gone']);
    // Charlie is pickable: his own hint, not the kept one
    expect(people[0]).toHaveTextContent('Chemist · Winterthur');
    expect(people[0]).not.toHaveTextContent(KEPT_HINT);
    expect(people[3]).toHaveTextContent(KEPT_HINT);
  });
});

describe('DashboardDialog — Share…', () => {
  it('has no name or description field, and sends them unchanged with the sharing, without widgets', async () => {
    const onDone = vi.fn();
    render(
      <DashboardDialog
        mode="share"
        dashboardId={7}
        initial={meta({ description: 'Old', visibility: 'shared', role_ids: [2], user_ids: [5] })}
        sharedWith={{ ...NO_ONE, roles: [{ id: 2, name: 'Superuser' }], users: [{ id: 5, name: 'Charlie Chen' }] }}
        onClose={vi.fn()}
        onDone={onDone}
      />
    );
    await peopleLoaded();
    expect(screen.getByRole('dialog', { name: 'Share dashboard' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Name *')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Superuser' })).toBeChecked();
    expect(pickerTrigger(/^People/)).toHaveTextContent('Charlie Chen');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Team Lead' }));
    pickOption(/^Teams/, 'Lab');
    pickOption(/^People/, 'Charlie Chen');
    const updated = { ...saved, visibility: 'shared' as const, shared_with: { ...NO_ONE, teams: [{ id: 11, name: 'Lab', site_name: 'Frankfurt' }] } };
    api.update.mockResolvedValueOnce(updated);
    await save();
    expect(api.update).toHaveBeenCalledWith(7, {
      name: 'Plan',
      description: 'Old',
      visibility: 'shared',
      role_ids: [2, 4],
      site_ids: [],
      team_ids: [11],
      user_ids: [],
    });
    expect(api.update.mock.calls[0][1]).not.toHaveProperty('widgets');
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'shared' }), updated.shared_with);
  });

  it('drops every target of a dashboard no longer shared', async () => {
    await share({ visibility: 'shared', role_ids: [2], site_ids: [1], team_ids: [10], user_ids: [5] });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'private' } });
    await save();
    expect(api.update).toHaveBeenCalledWith(7, {
      name: 'Plan',
      description: null,
      visibility: 'private',
      role_ids: [],
      site_ids: [],
      team_ids: [],
      user_ids: [],
    });
  });

  it('shows the server’s refusal and stays open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.update.mockRejectedValueOnce(new ApiError('Person not found', 404));
    const { onDone } = await share({ visibility: 'shared', user_ids: [6] });
    await save();
    expect(screen.getByRole('alert')).toHaveTextContent('Person not found');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Share dashboard' })).toBeInTheDocument();
  });

  it('says plainly when an unknown failure has no words', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.update.mockRejectedValueOnce('nope');
    await share({ visibility: 'everyone' });
    await save();
    expect(screen.getByRole('alert')).toHaveTextContent('The dashboard could not be saved.');
  });

  it('saves once on a double click', async () => {
    let release!: (d: Dashboard) => void;
    api.update.mockReturnValueOnce(new Promise<Dashboard>((r) => (release = r)));
    await share({ visibility: 'everyone' });
    await act(async () => {});
    const button = screen.getByRole('button', { name: 'Save Changes' });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-busy', 'true');
    await act(async () => release(saved));
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'));
  });

  it('closes on Cancel', async () => {
    const { onClose } = renderDialog();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the people picker over its search box', async () => {
    await share({ visibility: 'shared', site_ids: [1] });
    const list = openPicker(/^People/);
    expect(list).toHaveAttribute('aria-multiselectable', 'true');
  });
});
