/**
 * Settings › Teams.
 *
 * - The list shows the teams of the site picked in the toolbar; superusers
 *   only get the sites they belong to (the backend refuses the others).
 * - Enter pressed twice in "New team name" creates one team.
 * - The edit form preloads the team and saves its members (a searchable
 *   dropdown plus the chosen list); Save shows busy; members the dropdown
 *   does not list are kept; Enter in its search box never submits.
 * - Delete asks first, and the confirm comes before the submit guard.
 * - Typed input is reported to the Settings hub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { TeamsPanel } from '../panels/TeamsPanel';
import { useAppStore } from '@/stores/appStore';
import { stubConfirm } from '@/test/confirmDialog';
import { makeStaff, makeTeam } from '@/test/factories';
import { DEFAULT_TEAM_COLOR } from '@/utils/colorSwatches';
import type { Site, Team, User } from '@/types';
import { asSignedIn } from '@/test/permissionFixtures';
import { optionLabel, pickOption, pickerOptions, pickerSearch, pickerTrigger } from '@/test/searchableSelect';

const api = vi.hoisted(() => ({
  teamsApi: {
    getAll: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('@/api', () => api);

const loader = vi.hoisted(() => ({
  refreshTeams: vi.fn(),
  refreshStaff: vi.fn(),
}));
vi.mock('@/hooks/useDataLoader', () => ({ useDataLoader: () => loader }));

const basel = { id: 1, name: 'Basel', active: true } as Site;
const zurich = { id: 2, name: 'Zurich', active: true } as Site;
const geneva = { id: 3, name: 'Geneva', active: true } as Site;

const analytics = makeTeam({ id: 1, site_id: 1, name: 'Analytics', description: 'Lab analytics', member_ids: [4] });
const processTeam = makeTeam({ id: 2, site_id: 1, name: 'Process', active: false });
const zurichLab = makeTeam({ id: 3, site_id: 2, name: 'Zurich lab' });

const staff = [
  makeStaff({ id: 5, name: 'Carol Chen', role: 'Technician', site_id: 1 }),
  makeStaff({ id: 4, name: 'Bob Brown', role: 'Scientist', site_id: 1 }),
  makeStaff({ id: 6, name: 'Dave Dormant', site_id: 1, active: false }),
  makeStaff({ id: 7, name: 'Zoe Zurich', site_id: 2 }),
];

function user(role: User['role'], siteIds: number[]): User {
  return asSignedIn({
    id: 1,
    email: 'ada@demo.local',
    first_name: 'Ada',
    last_name: 'Admin',
    name: 'Ada Admin',
    role,
    active: true,
    is_resource: role !== 'admin',
    site_ids: siteIds,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const siteSelect = () => screen.getByLabelText('Site') as HTMLSelectElement;
const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

beforeEach(() => {
  for (const fn of Object.values(api.teamsApi)) fn.mockReset();
  loader.refreshTeams.mockReset().mockResolvedValue(undefined);
  loader.refreshStaff.mockReset().mockResolvedValue(undefined);
  api.teamsApi.update.mockImplementation(async (id: number, data: Partial<Team>) => ({ ...analytics, ...data, id }));
  api.teamsApi.delete.mockResolvedValue(undefined);
  useAppStore.setState({
    currentUser: user('admin', [1]),
    sites: [basel, zurich, geneva],
    currentSite: basel,
    teams: [analytics, processTeam, zurichLab],
    staff,
  });
});

describe('TeamsPanel', () => {
  it("lists the selected site's teams only", () => {
    render(<TeamsPanel />);
    expect(siteSelect()).toHaveValue('1');
    expect(screen.getByText('2 teams')).toBeInTheDocument();
    expect(within(rowOf('Analytics')).getByText('Lab analytics')).toBeInTheDocument();
    expect(within(rowOf('Analytics')).getByText('1 member')).toBeInTheDocument();
    expect(within(rowOf('Process')).getByText('Inactive')).toBeInTheDocument();
    expect(within(rowOf('Analytics')).queryByText('Inactive')).not.toBeInTheDocument();
    expect(screen.queryByText('Zurich lab')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Analytics' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Delete Analytics' })).toBeInTheDocument();

    fireEvent.change(siteSelect(), { target: { value: '2' } });
    expect(screen.getByText('Zurich lab')).toBeInTheDocument();
    expect(screen.queryByText('Analytics')).not.toBeInTheDocument();
    expect(screen.getByText('1 team')).toBeInTheDocument();

    fireEvent.change(siteSelect(), { target: { value: '3' } });
    expect(screen.getByText('No teams on this site yet. Add one below.')).toBeInTheDocument();
  });

  it('offers a superuser only the sites they belong to', () => {
    useAppStore.setState({ currentUser: user('superuser', [2]) });
    render(<TeamsPanel />);
    const options = within(siteSelect()).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Zurich']);
    // The current site (Basel) is not theirs, so the panel starts on Zurich.
    expect(siteSelect()).toHaveValue('2');
    expect(screen.getByText('Zurich lab')).toBeInTheDocument();
    expect(screen.queryByText('Analytics')).not.toBeInTheDocument();
  });

  it('creates one team when Enter is pressed twice in the add field', async () => {
    const pending = deferred<Team>();
    api.teamsApi.create.mockReturnValue(pending.promise);
    render(<TeamsPanel />);
    const input = screen.getByLabelText('New team name');
    fireEvent.change(input, { target: { value: '  QA  ' } });

    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(api.teamsApi.create).toHaveBeenCalledTimes(1);
    expect(api.teamsApi.create).toHaveBeenCalledWith({ site_id: 1, name: 'QA', color: DEFAULT_TEAM_COLOR });
    expect(screen.getByRole('button', { name: 'Add team' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => pending.resolve(makeTeam({ id: 9, name: 'QA' })));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(loader.refreshTeams).toHaveBeenCalledTimes(1);
    expect(api.teamsApi.create).toHaveBeenCalledTimes(1);
  });

  it('preloads the edit form and saves the ticked members', async () => {
    const pending = deferred<Team>();
    api.teamsApi.update.mockReturnValue(pending.promise);
    render(<TeamsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Analytics' }));

    expect(screen.getByLabelText('Name *')).toHaveValue('Analytics');
    expect(screen.getByLabelText('Description')).toHaveValue('Lab analytics');
    expect(screen.getByRole('switch', { name: 'Active' })).toBeChecked();
    expect(screen.getByRole('radiogroup', { name: 'Team colour' })).toBeInTheDocument();

    expect(pickerTrigger(/^Members/)).toHaveAccessibleName('Members 1 member');
    expect(
      within(screen.getByRole('list', { name: 'Team members' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['Bob Brown · Scientist']);
    // Active people of the team's site, by name; Dave (inactive, not a member)
    // and Zoe (another site) are not offered.
    const rows = pickerOptions(/^Members/);
    expect(rows.map(optionLabel)).toEqual(['Bob Brown', 'Carol Chen']);
    expect(rows.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(screen.getByRole('combobox', { name: 'Find a person' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    pickOption(/^Members/, 'Carol Chen');
    expect(pickerTrigger(/^Members/)).toHaveAccessibleName('Members 2 members');

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(screen.getByRole('button', { name: 'Save Changes' })).toHaveAttribute('aria-busy', 'true');
    expect(api.teamsApi.update).toHaveBeenCalledWith(1, {
      name: 'Analytics',
      description: 'Lab analytics',
      color: analytics.color,
      active: true,
      member_ids: [4, 5],
    });

    await act(async () => pending.resolve({ ...analytics, member_ids: [4, 5] }));
    await waitFor(() => expect(screen.queryByLabelText('Name *')).not.toBeInTheDocument());
    expect(loader.refreshTeams).toHaveBeenCalled();
    expect(loader.refreshStaff).toHaveBeenCalled();
  });

  it('keeps an inactive member listed so they can be removed', () => {
    useAppStore.setState({ teams: [{ ...analytics, member_ids: [4, 6] }, processTeam, zurichLab] });
    render(<TeamsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Analytics' }));
    expect(screen.getByRole('button', { name: 'Remove Dave Dormant' })).toBeInTheDocument();
    const dave = pickerOptions(/^Members/).find((o) => optionLabel(o) === 'Dave Dormant');
    expect(dave).toHaveAttribute('aria-selected', 'true');
  });

  it('removes a member from the list under the dropdown and finds people by job title', async () => {
    api.teamsApi.update.mockResolvedValue({ ...analytics, member_ids: [5] });
    render(<TeamsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Analytics' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob Brown' }));
    expect(screen.queryByRole('list', { name: 'Team members' })).not.toBeInTheDocument();
    expect(pickerTrigger(/^Members/)).toHaveAccessibleName('Members No members');

    const search = pickerSearch(/^Members/);
    fireEvent.change(search, { target: { value: 'techn' } });
    expect(pickerOptions(/^Members/).map(optionLabel)).toEqual(['Carol Chen']);
    // Enter ticks the active row and never submits the form
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(api.teamsApi.update).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove Carol Chen' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    expect(api.teamsApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ member_ids: [5] }));
  });

  it('keeps member ids the dropdown does not list', async () => {
    // 99 is not among the site's staff (e.g. someone not bookable as a resource)
    useAppStore.setState({ teams: [{ ...analytics, member_ids: [4, 99] }, processTeam, zurichLab] });
    api.teamsApi.update.mockResolvedValue({ ...analytics, member_ids: [4, 5, 99] });
    render(<TeamsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Analytics' }));
    pickOption(/^Members/, 'Carol Chen');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });
    expect(api.teamsApi.update).toHaveBeenCalledWith(1, expect.objectContaining({ member_ids: [4, 5, 99] }));
  });

  it('says when the site has nobody to offer', () => {
    useAppStore.setState({ staff: [] });
    render(<TeamsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Analytics' }));
    fireEvent.click(pickerTrigger(/^Members/));
    expect(screen.getByRole('status')).toHaveTextContent('No people on this site yet.');
  });

  it('shows an error instead of saving a team without a name', () => {
    render(<TeamsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Analytics' }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Team name is required');
    expect(api.teamsApi.update).not.toHaveBeenCalled();
  });

  it('uses the same required-name message when adding a team without a name', () => {
    render(<TeamsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Add team' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Team name is required');
    expect(api.teamsApi.create).not.toHaveBeenCalled();
  });

  it('shows the error when adding a team fails', async () => {
    api.teamsApi.create.mockRejectedValue(new Error('A team with this name already exists'));
    render(<TeamsPanel />);
    fireEvent.change(screen.getByLabelText('New team name'), { target: { value: 'Analytics' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add team' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A team with this name already exists');
    expect(loader.refreshTeams).not.toHaveBeenCalled();
    expect(screen.getByLabelText('New team name')).toHaveValue('Analytics');
  });

  it('says so when the user manages no site', () => {
    useAppStore.setState({ currentUser: user('superuser', []) });
    render(<TeamsPanel />);
    expect(screen.getByText("You don't manage any site yet.")).toBeInTheDocument();
    expect(screen.queryByText('No teams on this site yet. Add one below.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add team' })).toBeDisabled();
  });

  it('deletes a team only after confirmation', async () => {
    const confirm = stubConfirm(false);
    render(<TeamsPanel />);
    const remove = screen.getByRole('button', { name: 'Delete Analytics' });

    await act(async () => {
      fireEvent.click(remove);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Delete team',
        message:
          'Delete team "Analytics"?\n\nIts members, projects, tags, equipment and company events keep working without it. This cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      })
    );
    expect(api.teamsApi.delete).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(remove);
    });
    await waitFor(() => expect(api.teamsApi.delete).toHaveBeenCalledTimes(1));
    expect(api.teamsApi.delete).toHaveBeenCalledWith(1);
    await waitFor(() => expect(loader.refreshStaff).toHaveBeenCalled());
    expect(loader.refreshTeams).toHaveBeenCalled();
  });

  it('reports unsaved input to the hub, from the add field and from the form', () => {
    const onDirtyChange = vi.fn();
    render(<TeamsPanel onDirtyChange={onDirtyChange} />);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(screen.getByLabelText('New team name'), { target: { value: 'QA' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByLabelText('New team name'), { target: { value: '' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Analytics' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    pickOption(/^Members/, 'Carol Chen');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    pickOption(/^Members/, 'Carol Chen'); // unticked again: nothing to save
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    pickOption(/^Members/, 'Carol Chen');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Back to teams' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText('Analytics')).toBeInTheDocument();
  });
});
