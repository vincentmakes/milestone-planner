/**
 * Organization details (admin portal).
 *
 * - Escape with an inline edit open (details, tenant groups) leaves the edit
 *   instead of closing the whole dialog; with none open it closes as before.
 * - The write actions (save details, add tenant, save groups) send one
 *   request per click burst, not one per click.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { OrganizationDetailsModal } from './OrganizationDetailsModal';
import { useAdminStore } from '@/stores/adminStore';
import type { OrganizationDetail } from '@/api/endpoints/admin';

const api = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  updateOrganization: vi.fn(),
  updateOrganizationSSOConfig: vi.fn(),
  testOrganizationSSOConfig: vi.fn(),
  removeTenantFromOrganization: vi.fn(),
  addTenantToOrganization: vi.fn(),
  updateTenantGroupAccess: vi.fn(),
}));
vi.mock('@/api', () => api);

const org: OrganizationDetail = {
  id: 'org-1',
  name: 'Acme Labs',
  slug: 'acme',
  description: 'R&D',
  created_at: '2026-01-01T00:00:00.000Z',
  tenants: [
    { id: 't-1', name: 'Demo Company', slug: 'demo', status: 'active', required_group_ids: [], group_membership_mode: 'any' },
  ],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getOrganization.mockResolvedValue(org);
  useAdminStore.setState({
    tenants: [{ id: 't-2', name: 'Other Co', slug: 'other' }] as never,
  });
});

describe('OrganizationDetailsModal', () => {
  it('Escape leaves the inline details edit first, then closes the dialog', async () => {
    const onClose = vi.fn();
    render(<OrganizationDetailsModal organizationId="org-1" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Details' }));
    fireEvent.change(screen.getByDisplayValue('Acme Labs'), { target: { value: 'Acme Research' } });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit Details' })).toBeInTheDocument();

    // Reopening shows the saved name, not the abandoned input
    fireEvent.click(screen.getByRole('button', { name: 'Edit Details' }));
    expect(screen.getByDisplayValue('Acme Labs')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the tenant group editor, not the dialog', async () => {
    const onClose = vi.fn();
    render(<OrganizationDetailsModal organizationId="org-1" onClose={onClose} />);
    await screen.findByRole('button', { name: 'Edit Details' });
    fireEvent.click(screen.getByRole('button', { name: 'tenants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Configure Groups' }));
    expect(screen.getByPlaceholderText('group-id-1, group-id-2')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('group-id-1, group-id-2')).not.toBeInTheDocument();
  });

  it('saves tenant groups once on a double click', async () => {
    let finish!: () => void;
    api.updateTenantGroupAccess.mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<OrganizationDetailsModal organizationId="org-1" onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Edit Details' });
    fireEvent.click(screen.getByRole('button', { name: 'tenants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Configure Groups' }));
    fireEvent.change(screen.getByPlaceholderText('group-id-1, group-id-2'), { target: { value: 'g1, g2' } });

    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(api.updateTenantGroupAccess).toHaveBeenCalledTimes(1);
    expect(api.updateTenantGroupAccess).toHaveBeenCalledWith('t-1', {
      requiredGroupIds: ['g1', 'g2'],
      groupMembershipMode: 'any',
    });
    await act(async () => finish());
  });

  it('adds a tenant once on a double click', async () => {
    let finish!: (value: { tenant_had_own_sso: boolean }) => void;
    api.addTenantToOrganization.mockReturnValue(new Promise((r) => (finish = r)));
    render(<OrganizationDetailsModal organizationId="org-1" onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Edit Details' });
    fireEvent.click(screen.getByRole('button', { name: 'tenants' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 't-2' } });

    const add = screen.getByRole('button', { name: 'Add Tenant' });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(api.addTenantToOrganization).toHaveBeenCalledTimes(1);
    await act(async () => finish({ tenant_had_own_sso: false }));
    await waitFor(() => expect(api.getOrganization).toHaveBeenCalledTimes(2));
  });
});
