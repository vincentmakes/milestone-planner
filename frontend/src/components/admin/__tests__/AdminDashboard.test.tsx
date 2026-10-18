/**
 * Admin dashboard: loads tenants, organizations and stats on mount (admin
 * users only on the superadmin tab), switches tabs through adminStore, opens
 * the create/detail dialogs, refreshes after a create, and logs out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminDashboard } from '../AdminDashboard';
import { useAdminStore } from '@/stores/adminStore';
import {
  adminLogout,
  createTenant,
  getAdminUsers,
  getOrganizations,
  getSystemStats,
  getTenant,
  getTenantAuditLog,
  getTenants,
  provisionTenant,
} from '@/api';
import { makeAdminListUser, makeOrganization, makeStats, makeTenant } from './adminFixtures';
import { stubConfirm } from '@/test/confirmDialog';

vi.mock('@/api', () => ({
  adminLogout: vi.fn(),
  getTenants: vi.fn(),
  getSystemStats: vi.fn(),
  getAdminUsers: vi.fn(),
  getOrganizations: vi.fn(),
  createTenant: vi.fn(),
  createOrganization: vi.fn(),
  createAdminUser: vi.fn(),
  getTenant: vi.fn(),
  getTenantAuditLog: vi.fn(),
  provisionTenant: vi.fn(),
  updateTenantStatus: vi.fn(),
  resetTenantAdminPassword: vi.fn(),
  deleteTenant: vi.fn(),
  deleteOrganization: vi.fn(),
  deleteAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
}));
// Organization details has its own test file and many API calls.
vi.mock('../modals/OrganizationDetailsModal', () => ({
  OrganizationDetailsModal: ({ organizationId, onClose }: { organizationId: string; onClose: () => void }) => (
    <div role="dialog">
      Org details {organizationId}
      <button onClick={onClose}>Close org</button>
    </div>
  ),
}));

const superadmin = { id: 1, email: 'root@milestone.local', name: 'Root', role: 'superadmin' as const };

beforeEach(() => {
  useAdminStore.setState({ ...useAdminStore.getInitialState(), isLoading: false, isAuthenticated: true, adminUser: superadmin });
  vi.mocked(getTenants).mockReset().mockResolvedValue([makeTenant()]);
  vi.mocked(getOrganizations).mockReset().mockResolvedValue([makeOrganization()]);
  vi.mocked(getSystemStats).mockReset().mockResolvedValue(makeStats());
  vi.mocked(getAdminUsers).mockReset().mockResolvedValue([makeAdminListUser()]);
  vi.mocked(adminLogout).mockReset().mockResolvedValue(undefined);
  vi.mocked(createTenant).mockReset();
  vi.mocked(getTenant).mockReset().mockResolvedValue(makeTenant());
  vi.mocked(getTenantAuditLog).mockReset().mockResolvedValue([]);
  vi.mocked(provisionTenant).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const tab = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });

describe('AdminDashboard', () => {
  it('loads the portal data on mount and shows the tenant list', async () => {
    render(<AdminDashboard />);
    expect(await screen.findByRole('button', { name: 'Demo Company' })).toBeInTheDocument();
    expect(getTenants).toHaveBeenCalledTimes(1);
    expect(getOrganizations).toHaveBeenCalledTimes(1);
    expect(getSystemStats).toHaveBeenCalledTimes(1);
    expect(getAdminUsers).not.toHaveBeenCalled();
    expect(screen.getByText('root@milestone.local')).toBeInTheDocument();
    expect(screen.getByText('Superadmin')).toBeInTheDocument();
    expect(useAdminStore.getState().organizations).toHaveLength(1);
  });

  it('switches between tabs and loads admin users on demand', async () => {
    render(<AdminDashboard />);
    await screen.findByRole('button', { name: 'Demo Company' });

    await tab('Organizations');
    expect(useAdminStore.getState().activeTab).toBe('organizations');
    expect(screen.getByRole('button', { name: 'Acme Group' })).toBeInTheDocument();

    await tab('Admin Users');
    expect(getAdminUsers).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('ops@milestone.local')).toBeInTheDocument();

    await tab('System Stats');
    expect(screen.getByRole('heading', { name: 'System Statistics' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    });
    expect(getSystemStats).toHaveBeenCalledTimes(2);

    await tab('Tenants');
    expect(screen.getByRole('heading', { name: 'Tenants' })).toBeInTheDocument();
  });

  it('hides the admin-users tab from regular portal admins', async () => {
    useAdminStore.setState({ adminUser: { ...superadmin, role: 'admin' } });
    render(<AdminDashboard />);
    await screen.findByRole('button', { name: 'Demo Company' });
    expect(screen.queryByRole('button', { name: 'Admin Users' })).not.toBeInTheDocument();
    expect(screen.queryByText('Superadmin')).not.toBeInTheDocument();
  });

  it('creates a tenant and reloads the list', async () => {
    const created = makeTenant({ id: 'n', name: 'New Co', slug: 'new-co' });
    vi.mocked(createTenant).mockResolvedValue({
      success: true,
      tenant: created,
      credentials: { database_name: 'db', database_user: 'u', database_password: 'p' },
      message: 'Tenant created.',
    });
    render(<AdminDashboard />);
    await screen.findByRole('button', { name: 'Demo Company' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Tenant/ }));
    });
    expect(screen.getByRole('heading', { name: 'Create Tenant' })).toBeInTheDocument();
    vi.mocked(getTenants).mockResolvedValue([makeTenant(), created]);
    fireEvent.change(screen.getByPlaceholderText('Acme Corporation'), { target: { value: 'New Co' } });
    fireEvent.change(screen.getByPlaceholderText('admin@acme.com'), { target: { value: 'a@new.co' } });
    await act(async () => {
      fireEvent.submit(document.getElementById('create-tenant-form') as HTMLFormElement);
    });
    expect(createTenant).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Co', slug: 'new-co' }));
    expect(screen.queryByRole('heading', { name: 'Create Tenant' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'New Co' })).toBeInTheDocument();
    expect(getTenants).toHaveBeenCalledTimes(2);
  });

  it('creating a tenant with demo data provisions it and shows the credentials', async () => {
    const created = makeTenant({ id: 'n', name: 'New Co', slug: 'new-co' });
    vi.mocked(createTenant).mockResolvedValue({
      success: true,
      tenant: created,
      credentials: { database_name: 'db', database_user: 'u', database_password: 'p' },
      message: 'Tenant created.',
    });
    vi.mocked(provisionTenant).mockResolvedValue({ success: true, adminEmail: 'a@new.co', adminPassword: 'Gen3rated!' });
    render(<AdminDashboard />);
    await screen.findByRole('button', { name: 'Demo Company' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Create Tenant/ }));
    });
    fireEvent.change(screen.getByPlaceholderText('Acme Corporation'), { target: { value: 'New Co' } });
    fireEvent.change(screen.getByPlaceholderText('admin@acme.com'), { target: { value: 'a@new.co' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Seed demo data' }));
    await act(async () => {
      fireEvent.submit(document.getElementById('create-tenant-form') as HTMLFormElement);
    });
    expect(provisionTenant).toHaveBeenCalledWith('n', { seedDemoData: true });
    expect(screen.queryByRole('heading', { name: 'Create Tenant' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Database Provisioned!' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Gen3rated!')).toBeInTheDocument();
    expect(getTenants).toHaveBeenCalledTimes(2);
  });

  it('opens and closes the create dialogs for organizations and admins', async () => {
    render(<AdminDashboard />);
    await screen.findByRole('button', { name: 'Demo Company' });

    await tab('Organizations');
    fireEvent.click(screen.getByRole('button', { name: /Create Organization/ }));
    expect(screen.getByRole('heading', { name: 'Create Organization' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Create Organization' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Acme Group' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Org details o-acme');
    fireEvent.click(screen.getByRole('button', { name: 'Close org' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await tab('Admin Users');
    fireEvent.click(screen.getByRole('button', { name: /Add Admin/ }));
    expect(screen.getByRole('heading', { name: 'Create Admin User' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Create Admin User' })).not.toBeInTheDocument();
  });

  it('opens tenant details and shows provisioned credentials', async () => {
    const confirm = stubConfirm(true);
    vi.mocked(getTenants).mockResolvedValue([makeTenant({ database_status: { exists: false, accessible: false } })]);
    vi.mocked(provisionTenant).mockResolvedValue({ success: true, adminEmail: 'admin@demo.local', adminPassword: 'S3cret!' });
    render(<AdminDashboard />);
    await screen.findByRole('button', { name: 'Demo Company' });

    fireEvent.click(screen.getByTitle('View Details'));
    expect(await screen.findByRole('heading', { name: 'Tenant Details' })).toBeInTheDocument();
    expect(getTenant).toHaveBeenCalledWith('t-demo');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'Tenant Details' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Provision Database'));
    expect(screen.getByRole('heading', { name: 'Provision database' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Provision' }));
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(provisionTenant).toHaveBeenCalledWith('t-demo', { seedDemoData: false });
    expect(screen.getByRole('heading', { name: 'Database Provisioned!' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('S3cret!')).toBeInTheDocument();
    expect(screen.getByDisplayValue('admin@demo.local')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'Database Provisioned!' })).not.toBeInTheDocument();
  });

  it('logs out and resets the portal state, even if the request fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(adminLogout).mockRejectedValue(new Error('offline'));
    render(<AdminDashboard />);
    await screen.findByRole('button', { name: 'Demo Company' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Logout/ }));
    });
    expect(useAdminStore.getState()).toMatchObject({ isAuthenticated: false, adminUser: null, tenants: [] });
  });

  it('logs and survives failed loads', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getTenants).mockRejectedValue(new Error('t'));
    vi.mocked(getOrganizations).mockRejectedValue(new Error('o'));
    vi.mocked(getSystemStats).mockRejectedValue(new Error('s'));
    vi.mocked(getAdminUsers).mockRejectedValue(new Error('a'));
    useAdminStore.setState({ activeTab: 'admins' });
    render(<AdminDashboard />);
    await waitFor(() => expect(error).toHaveBeenCalledTimes(4));
    expect(error).toHaveBeenCalledWith('Failed to load tenants:', expect.any(Error));
    expect(error).toHaveBeenCalledWith('Failed to load admin users:', expect.any(Error));
    expect(screen.getByText('No admin users found.')).toBeInTheDocument();
  });
});
