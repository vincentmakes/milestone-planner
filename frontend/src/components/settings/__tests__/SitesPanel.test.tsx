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
import type { Site, User } from '@/types';

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

const admin: User = {
  id: 1,
  email: 'admin@demo.local',
  first_name: 'Ada',
  last_name: 'Admin',
  name: 'Ada Admin',
  role: 'admin',
  active: true,
  site_ids: [1],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getBankHolidays.mockResolvedValue([]);
  api.updateSite.mockImplementation(async (id: number, data: Partial<Site>) => ({ ...basel, ...data, id }));
  useAppStore.setState({ currentUser: admin, sites: [basel], currentSite: basel });
});

describe('SiteForm', () => {
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

  it('reports unsaved input, and a value typed back is clean again', () => {
    const onDirtyChange = vi.fn();
    render(<SiteForm site={basel} onBack={vi.fn()} onDirtyChange={onDirtyChange} />);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    const city = screen.getByPlaceholderText('e.g., Winterthur');
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
    fireEvent.change(input, { target: { value: 'Zurich' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.createSite).toHaveBeenCalledTimes(1);

    await act(async () => finish({ id: 2, name: 'Zurich' }));
    expect(useAppStore.getState().sites.map((s) => s.name)).toEqual(['Basel', 'Zurich']);
  });
});
