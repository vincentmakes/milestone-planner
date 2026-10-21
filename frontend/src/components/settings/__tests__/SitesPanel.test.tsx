/**
 * Settings › Sites.
 *
 * - Clearing City / Country / Region sends an explicit null: an omitted field
 *   means "unchanged" to the backend, so a set value could never be cleared.
 * - The site form and the "new site" input report unsaved input to the hub.
 * - Enter pressed twice in "New site name" creates one site, not two.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SitesPanel } from '../panels/SitesPanel';
import { SiteForm } from '../panels/SiteForm';
import { useAppStore } from '@/stores/appStore';
import { stubConfirm } from '@/test/confirmDialog';
import type { Site } from '@/types';
import { makeSite, makeUser } from '@/test/factories';

const api = vi.hoisted(() => ({
  createSite: vi.fn(),
  exportSiteToExcel: vi.fn(),
  updateSite: vi.fn(),
  getBankHolidays: vi.fn(),
  refreshBankHolidays: vi.fn(),
  buildHolidayDateSet: vi.fn(() => new Set()),
}));
vi.mock('@/api', () => api);

const basel: Site = {
  id: 1,
  name: 'Basel',
  city: 'Basel',
  country_code: 'CH',
  region_code: 'BS',
  active: true,
};

const admin = makeUser({ id: 1, email: 'admin@demo.local', role: 'admin', site_ids: [1] });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getBankHolidays.mockResolvedValue([]);
  api.updateSite.mockImplementation(async (id: number, data: Partial<Site>) => ({ ...basel, ...data, id }));
  useAppStore.setState({ currentUser: admin, sites: [basel], currentSite: basel });
});

describe('SiteForm', () => {
  it('refreshes the bank holidays from Nager only after confirmation', async () => {
    const confirm = stubConfirm(false);
    api.refreshBankHolidays.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    render(<SiteForm site={basel} onBack={vi.fn()} />);
    const refresh = await screen.findByRole('button', { name: 'Refresh' });

    await act(async () => {
      fireEvent.click(refresh);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'This will refresh bank holidays from the Nager holiday API. Continue?',
        confirmLabel: 'Refresh',
      })
    );
    expect(api.refreshBankHolidays).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(refresh);
    });
    await waitFor(() => expect(api.refreshBankHolidays).toHaveBeenCalledWith(1));
    expect(await screen.findByText('2 bank holidays')).toBeInTheDocument();
  });

  it('sends null for a cleared city, country and region', async () => {
    const onBack = vi.fn();
    render(<SiteForm site={basel} onBack={onBack} />);

    fireEvent.change(screen.getByPlaceholderText('e.g., Winterthur'), { target: { value: '  ' } });
    fireEvent.change(screen.getByDisplayValue('Switzerland (CH)'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('e.g., ZH, HE, ARA'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(api.updateSite).toHaveBeenCalledWith(1, {
      name: 'Basel',
      city: null,
      country_code: null,
      region_code: null,
      active: true,
    });
  });

  it('sends the renamed site name', async () => {
    const onBack = vi.fn();
    render(<SiteForm site={basel} onBack={onBack} />);
    const name = screen.getByLabelText('Site Name');
    fireEvent.change(name, { target: { value: 'Basel Lab' } });
    expect(name).toHaveValue('Basel Lab');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(api.updateSite).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Basel Lab' }));
  });

  it('offers Active as a switch and sends its new value', async () => {
    const onBack = vi.fn();
    render(<SiteForm site={basel} onBack={onBack} />);
    const active = screen.getByRole('switch', { name: 'Active' });
    expect(active).toBeChecked();
    fireEvent.click(active);
    expect(active).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
    expect(api.updateSite).toHaveBeenCalledWith(1, expect.objectContaining({ active: false }));
  });

  it('reports unsaved input, and a value typed back is clean again', () => {
    const onDirtyChange = vi.fn();
    render(<SiteForm site={basel} onBack={vi.fn()} onDirtyChange={onDirtyChange} />);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    const city = screen.getByPlaceholderText('e.g., Winterthur');
    expect(screen.getByLabelText('City')).toBe(city);
    expect(screen.getByLabelText('Country')).toHaveValue('CH');
    fireEvent.change(city, { target: { value: 'Riehen' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(city, { target: { value: 'Basel' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});

describe('SitesPanel', () => {
  it('passes the site form state on to the hub, and clears it when going back', async () => {
    const onDirtyChange = vi.fn();
    render(<SitesPanel onDirtyChange={onDirtyChange} />);
    fireEvent.click(screen.getByTitle('Edit site'));

    fireEvent.change(await screen.findByPlaceholderText('e.g., Winterthur'), { target: { value: 'Riehen' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: /All sites/ }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    // A typed new site name is unsaved input too
    fireEvent.change(screen.getByPlaceholderText('New site name'), { target: { value: 'Zurich' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('names the export and edit actions after the site', () => {
    render(<SitesPanel />);
    const exportBtn = screen.getByRole('button', { name: 'Export Basel as Excel' });
    expect(exportBtn).toHaveAttribute('title', 'Export site data as Excel');
    expect(exportBtn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    const edit = screen.getByRole('button', { name: 'Edit Basel' });
    expect(edit).toHaveAttribute('title', 'Edit site');
    expect(edit.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('creates one site when Enter is pressed twice', async () => {
    let finish!: (site: Site) => void;
    api.createSite.mockReturnValue(new Promise<Site>((r) => (finish = r)));
    render(<SitesPanel />);

    const input = screen.getByPlaceholderText('New site name');
    expect(screen.getByLabelText('New site name')).toBe(input);
    fireEvent.change(input, { target: { value: 'Zurich' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.createSite).toHaveBeenCalledTimes(1);

    await act(async () => finish({ id: 2, name: 'Zurich' }));
    expect(useAppStore.getState().sites.map((s) => s.name)).toEqual(['Basel', 'Zurich']);
  });
});

describe('SitesPanel permissions', () => {
  const zurich = makeSite({ id: 2, name: 'Zurich' });

  it('offers only the export of the visible sites with sites.export alone', () => {
    useAppStore.setState({
      currentUser: makeUser({ id: 5, role: 'superuser', site_ids: [2] }),
      sites: [basel, zurich],
    });
    render(<SitesPanel />);
    expect(screen.getByRole('button', { name: 'Export Zurich as Excel' })).toBeInTheDocument();
    expect(screen.queryByText('Basel')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Zurich' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New site name')).not.toBeInTheDocument();
  });

  it('manages every site without the export control for sites.manage alone', () => {
    useAppStore.setState({
      currentUser: makeUser({ id: 6, role: 'site_admin', permissions: ['sites.manage'], site_ids: [] }),
      sites: [basel, zurich],
    });
    render(<SitesPanel />);
    expect(screen.getByRole('button', { name: 'Edit Basel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Zurich' })).toBeInTheDocument();
    expect(screen.getByLabelText('New site name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export .* as Excel/ })).not.toBeInTheDocument();
  });
});
