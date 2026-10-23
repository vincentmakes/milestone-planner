/**
 * Settings › Equipment: equipment can be available on several sites. The form
 * sends every selected site as `site_ids` (with the first as the legacy
 * `site_id`), the list shows all of them, and the store is refreshed with the
 * per-site rows of GET /equipment, not the one-row-per-item /all listing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EquipmentPanel } from '../panels/EquipmentPanel';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { stubConfirm } from '@/test/confirmDialog';
import type { Equipment, Site, User } from '@/types';
import { makeTeam } from '@/test/factories';
import { asSignedIn } from '@/test/permissionFixtures';
import { makeUser } from '@/test/factories';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPut = vi.fn();
const apiDelete = vi.fn();
vi.mock('@/api/client', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: (...args: unknown[]) => apiPost(...args),
  apiPut: (...args: unknown[]) => apiPut(...args),
  apiDelete: (...args: unknown[]) => apiDelete(...args),
}));

const getEquipment = vi.fn();
vi.mock('@/api/endpoints/equipment', () => ({
  getEquipment: (...args: unknown[]) => getEquipment(...args),
  getAllEquipment: () => apiGet('/api/equipment/all'),
}));

const sites: Site[] = [
  { id: 1, name: 'Site A' },
  { id: 2, name: 'Site B' },
  { id: 3, name: 'Site C' },
];

const admin: User = {
  id: 1,
  email: 'admin@demo.local',
  first_name: 'Ada',
  last_name: 'Admin',
  name: 'Ada Admin',
  role: 'admin',
  active: true,
  is_resource: false,
  site_ids: [1, 2, 3],
};

/** /equipment/all: one row per item, with the names of every linked site */
const allEquipment: Equipment[] = [
  { id: 1, name: 'HPLC 1', type: 'Analytical Device', site_id: 1, site_ids: [1], site_names: ['Site A'], active: true },
  { id: 2, name: 'Reactor', type: 'Pilot Plant', site_id: 1, site_ids: [1, 2], site_names: ['Site A', 'Site B'], active: true },
];

/** /equipment?includeAllSites=true: one row per equipment-site pair */
const perSiteRows: Equipment[] = [
  { id: 1, name: 'HPLC 1', type: 'Analytical Device', site_id: 1, site_ids: [1], active: true },
  { id: 2, name: 'Reactor', type: 'Pilot Plant', site_id: 1, site_ids: [1, 2], active: true },
  { id: 2, name: 'Reactor', type: 'Pilot Plant', site_id: 2, site_ids: [1, 2], active: true },
];

describe('EquipmentPanel', () => {
  beforeEach(() => {
    apiGet.mockReset().mockResolvedValue(allEquipment);
    apiPost.mockReset().mockResolvedValue({});
    apiPut.mockReset().mockResolvedValue({});
    apiDelete.mockReset().mockResolvedValue(undefined);
    getEquipment.mockReset().mockResolvedValue(perSiteRows);
    useAppStore.setState({ sites, currentUser: asSignedIn(admin), currentSite: sites[0], equipment: [], teams: [] });
  });

  it('lists every site of an item in the Sites column', async () => {
    render(<EquipmentPanel />);
    expect(await screen.findByText('Reactor')).toBeInTheDocument();
    expect(screen.getByText('Site A, Site B')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Sites' })).toBeInTheDocument();
  });

  it('names sites outside a superuser\'s store from the server response', async () => {
    // A superuser's store only holds their own sites
    useAppStore.setState({
      sites: [sites[0]],
      currentUser: asSignedIn({ ...admin, role: 'superuser', site_ids: [1] }),
    });
    render(<EquipmentPanel />);
    await screen.findByText('Reactor');

    expect(screen.getByText('Site A, Site B')).toBeInTheDocument();
    expect(screen.queryByText(/Unknown/)).not.toBeInTheDocument();
  });

  it('falls back to the store, then to the site id, without server names', async () => {
    apiGet.mockResolvedValue([
      { id: 2, name: 'Reactor', type: 'Pilot Plant', site_id: 1, site_ids: [1, 2], active: true },
    ]);
    useAppStore.setState({ sites: [sites[0]] });
    render(<EquipmentPanel />);
    await screen.findByText('Reactor');

    expect(screen.getByText('Site A, Site #2')).toBeInTheDocument();
  });

  it('filters by any of the linked sites', async () => {
    render(<EquipmentPanel />);
    await screen.findByText('Reactor');

    fireEvent.change(screen.getByLabelText('Site'), { target: { value: '2' } });
    expect(screen.getByText('Reactor')).toBeInTheDocument();
    expect(screen.queryByText('HPLC 1')).not.toBeInTheDocument();
  });

  it('hides inactive equipment until the Show inactive switch is on', async () => {
    apiGet.mockResolvedValue([
      ...allEquipment,
      { id: 3, name: 'Old Balance', type: 'Analytical Device', site_id: 1, site_ids: [1], site_names: ['Site A'], active: false },
    ]);
    render(<EquipmentPanel />);
    await screen.findByText('Reactor');
    expect(screen.queryByText('Old Balance')).not.toBeInTheDocument();

    const showInactive = screen.getByRole('switch', { name: 'Show inactive' });
    expect(showInactive).not.toBeChecked();
    fireEvent.click(showInactive);
    expect(screen.getByText('Old Balance')).toBeInTheDocument();
    fireEvent.click(showInactive);
    expect(screen.queryByText('Old Balance')).not.toBeInTheDocument();
  });

  it('creates equipment on several sites and refreshes the store with per-site rows', async () => {
    render(<EquipmentPanel />);
    await screen.findByText('HPLC 1');

    fireEvent.click(screen.getByRole('button', { name: 'Add Equipment' }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Mass Spec 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analytical Device' }));

    // The current site is preselected; add a second one
    const siteA = screen.getByLabelText('Site A') as HTMLInputElement;
    const siteB = screen.getByLabelText('Site B') as HTMLInputElement;
    expect(siteA.checked).toBe(true);
    expect(siteB.checked).toBe(false);
    fireEvent.click(siteB);
    expect(siteB.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Create Equipment' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/api/equipment', {
      name: 'Mass Spec 1',
      type: 'Analytical Device',
      site_id: 1,
      site_ids: [1, 2],
      active: true,
      team_ids: [],
    });
    await waitFor(() => expect(getEquipment).toHaveBeenCalledWith(true));
    await waitFor(() => expect(useAppStore.getState().equipment).toEqual(perSiteRows));
  });

  it('hides the row icon from screen readers and labels the inline type confirm/cancel', async () => {
    render(<EquipmentPanel />);
    const edit = await screen.findByRole('button', { name: 'Edit Reactor' });
    expect(edit.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Add Equipment' }));
    fireEvent.click(screen.getByRole('button', { name: '+ New type' }));
    expect(screen.getByLabelText('New equipment type')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Add type' }).querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel adding a type' }));
    expect(screen.queryByRole('button', { name: 'Add type' })).not.toBeInTheDocument();
  });

  it('offers Active as a switch when editing and sends its new value', async () => {
    render(<EquipmentPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Reactor' }));
    const active = screen.getByRole('switch', { name: 'Active' });
    expect(active).toBeChecked();
    fireEvent.click(active);
    expect(active).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/api/equipment/2', expect.objectContaining({ active: false })));
  });

  it('requires at least one site', async () => {
    render(<EquipmentPanel />);
    await screen.findByText('Reactor');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Reactor' }));
    const siteA = screen.getByLabelText('Site A') as HTMLInputElement;
    const siteB = screen.getByLabelText('Site B') as HTMLInputElement;
    expect(siteA.checked).toBe(true);
    expect(siteB.checked).toBe(true);
    fireEvent.click(siteA);
    fireEvent.click(siteB);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Please select at least one site')).toBeInTheDocument();
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('sends the remaining sites on edit', async () => {
    render(<EquipmentPanel />);
    await screen.findByText('Reactor');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Reactor' }));
    fireEvent.click(screen.getByLabelText('Site A'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut).toHaveBeenCalledWith('/api/equipment/2', {
      name: 'Reactor',
      type: 'Pilot Plant',
      site_id: 2,
      site_ids: [2],
      active: true,
      team_ids: [],
    });
  });

  it('creates equipment limited to some teams of its site', async () => {
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1, name: 'Analytics' }), makeTeam({ id: 3, site_id: 2, name: 'Line B' })],
    });
    render(<EquipmentPanel />);
    await screen.findByText('HPLC 1');
    fireEvent.click(screen.getByRole('button', { name: 'Add Equipment' }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Mass Spec 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analytical Device' }));

    // Only Site A is selected, so its switch does not name the site
    fireEvent.click(screen.getByRole('switch', { name: 'Whole site' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Equipment' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/equipment', expect.objectContaining({ site_ids: [1], team_ids: [1] }))
    );
  });

  it("drops the teams of a site that is unticked from the payload", async () => {
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1, name: 'Analytics' }), makeTeam({ id: 3, site_id: 2, name: 'Line B' })],
    });
    apiGet.mockResolvedValue(allEquipment.map((e) => (e.id === 2 ? { ...e, team_ids: [1, 3] } : e)));
    const onDirtyChange = vi.fn();
    render(<EquipmentPanel onDirtyChange={onDirtyChange} />);
    await screen.findByText('Reactor');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Reactor' }));
    expect(screen.getByRole('switch', { name: 'Whole site — Site A' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Line B' })).toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByLabelText('Site A'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/equipment/2', expect.objectContaining({ site_ids: [2], team_ids: [3] }))
    );
  });

  it('lets a superuser edit only equipment on their own sites', async () => {
    useAppStore.setState({ currentUser: asSignedIn({ ...admin, role: 'superuser', site_ids: [1] }) });
    render(<EquipmentPanel />);
    await screen.findByText('Reactor');

    // HPLC 1 is on Site A only: editable. Reactor is also on Site B: not.
    expect(screen.getByRole('button', { name: 'Edit HPLC 1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Edit Reactor' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit HPLC 1' }));
    // Only the superuser's own sites are offered
    expect(screen.getByLabelText('Site A')).toBeInTheDocument();
    expect(screen.queryByLabelText('Site B')).not.toBeInTheDocument();
  });

  it('reports unsaved input to the hub (name or sites), and clears it on Cancel', async () => {
    const onDirtyChange = vi.fn();
    render(<EquipmentPanel onDirtyChange={onDirtyChange} />);
    await screen.findByText('Reactor');

    fireEvent.click(screen.getByRole('button', { name: 'Add Equipment' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByLabelText('Site B'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByLabelText('Site B'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Mass Spec 1' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('sends one create when the form is submitted twice', async () => {
    let finish!: () => void;
    apiPost.mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<EquipmentPanel />);
    await screen.findByText('Reactor');

    fireEvent.click(screen.getByRole('button', { name: 'Add Equipment' }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Mass Spec 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analytical Device' }));
    const form = screen.getByLabelText('Name *').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(apiPost).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(screen.queryByLabelText('Name *')).not.toBeInTheDocument());
  });
});

describe('EquipmentPanel during What-If', () => {
  beforeEach(() => {
    apiGet.mockReset().mockResolvedValue(allEquipment);
    apiDelete.mockReset().mockResolvedValue(undefined);
    getEquipment.mockReset().mockResolvedValue(perSiteRows);
    useAppStore.setState({ sites, currentUser: asSignedIn(admin), currentSite: sites[0], equipment: [] });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
  });

  it('disables Delete with the What-If hint and never deletes', async () => {
    const confirm = stubConfirm(true);
    useWhatIfStore.getState().enterWhatIfMode([]);
    render(<EquipmentPanel />);
    await screen.findByText('Reactor');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Reactor' }));

    const del = screen.getByRole('button', { name: 'Delete Equipment' });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute('title', whatIfUnavailableMessage('Deleting equipment'));
    fireEvent.click(del);
    expect(confirm).not.toHaveBeenCalled();
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('deletes again once What-If ends', async () => {
    const confirm = stubConfirm(false);
    render(<EquipmentPanel />);
    await screen.findByText('Reactor');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Reactor' }));

    const del = screen.getByRole('button', { name: 'Delete Equipment' });
    expect(del).toBeEnabled();
    expect(del).not.toHaveAttribute('title');
    fireEvent.click(del);
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'Are you sure you want to delete "Reactor"?\n\nThis will also remove all assignments for this equipment.',
          destructive: true,
        })
      )
    );
    expect(apiDelete).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    fireEvent.click(del);
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/api/equipment/2'));
  });
});

describe('EquipmentPanel without views.equipment', () => {
  it('manages equipment through /equipment/all and leaves the view slice alone', async () => {
    apiGet.mockReset().mockResolvedValue(allEquipment);
    apiPost.mockReset().mockResolvedValue({});
    getEquipment.mockReset().mockResolvedValue(perSiteRows);
    useAppStore.setState({
      sites,
      currentSite: sites[0],
      equipment: [],
      teams: [],
      currentUser: makeUser({ id: 40, role: 'eq_admin', permissions: ['equipment.manage', 'sites.view_all'] }),
    });
    render(<EquipmentPanel />);
    await screen.findByText('HPLC 1');
    expect(apiGet).toHaveBeenCalledWith('/api/equipment/all');

    fireEvent.click(screen.getByRole('button', { name: 'Add Equipment' }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Mass Spec 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analytical Device' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Equipment' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(getEquipment).not.toHaveBeenCalled();
    expect(useAppStore.getState().equipment).toEqual([]);
  });
});
