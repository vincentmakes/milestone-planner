/**
 * Admin-portal create dialogs (tenant, organization, admin user) and the
 * tenant details dialog: form → admin API payload, error display, Escape and
 * explicit buttons to close. The overlay never closes them (CLAUDE.md modal
 * rule), so no test clicks it expecting a close.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { CreateTenantModal } from '../CreateTenantModal';
import { CreateOrganizationModal } from '../CreateOrganizationModal';
import { CreateAdminModal } from '../CreateAdminModal';
import { TenantDetailsModal } from '../TenantDetailsModal';
import { ProvisionTenantModal, SEED_DEMO_LABEL } from '../ProvisionTenantModal';
import {
  createAdminUser,
  createOrganization,
  createTenant,
  getTenant,
  getTenantAuditLog,
  provisionTenant,
} from '@/api';
import type { Tenant } from '@/api/endpoints/admin';
import { makeAuditEntry, makeTenant } from '../../__tests__/adminFixtures';

vi.mock('@/api', () => ({
  createTenant: vi.fn(),
  provisionTenant: vi.fn(),
  createOrganization: vi.fn(),
  createAdminUser: vi.fn(),
  getTenant: vi.fn(),
  getTenantAuditLog: vi.fn(),
}));

const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const submit = (name: string | RegExp) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });

/** What `POST /api/admin/tenants` answers: the record plus one-time DB credentials. */
const created = (tenant: Tenant) => ({
  success: true,
  tenant,
  credentials: { database_name: 'db', database_user: 'u', database_password: 'p' },
  message: 'Tenant created.',
});

beforeEach(() => {
  vi.mocked(createTenant).mockReset();
  vi.mocked(provisionTenant).mockReset();
  vi.mocked(createOrganization).mockReset();
  vi.mocked(createAdminUser).mockReset();
  vi.mocked(getTenant).mockReset();
  vi.mocked(getTenantAuditLog).mockReset();
});

describe('admin modal dialog semantics', () => {
  it('exposes every create modal as a labelled modal dialog with a labelled close button', () => {
    for (const [Modal, title] of [
      [CreateTenantModal, 'Create Tenant'],
      [CreateOrganizationModal, 'Create Organization'],
      [CreateAdminModal, 'Create Admin User'],
    ] as const) {
      const { unmount } = render(<Modal onClose={vi.fn()} onCreated={vi.fn()} />);
      const dialog = screen.getByRole('dialog', { name: title });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveAttribute('type', 'button');
      unmount();
    }
  });

  it('exposes the provision dialog as a labelled modal dialog', () => {
    render(<ProvisionTenantModal tenantName="Acme" onClose={vi.fn()} onConfirm={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Provision database' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toBeInTheDocument();
  });

  it('labels the tenant details dialog by its heading', async () => {
    vi.mocked(getTenant).mockResolvedValue(makeTenant());
    vi.mocked(getTenantAuditLog).mockResolvedValue([]);
    render(<TenantDetailsModal tenantId="t-1" onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Tenant Details' })).toHaveAttribute('aria-modal', 'true');
    await screen.findByText(makeTenant().name);
  });
});

describe('CreateTenantModal', () => {
  it('derives the slug from the name and submits the full request', async () => {
    const tenant = makeTenant({ id: 'new' });
    vi.mocked(createTenant).mockResolvedValue(created(tenant));
    const onCreated = vi.fn();
    render(<CreateTenantModal onClose={vi.fn()} onCreated={onCreated} />);

    change(screen.getByPlaceholderText('Acme Corporation'), '  Acme R&D Labs! ');
    expect(screen.getByPlaceholderText('acme-corp')).toHaveValue('acme-r-d-labs');
    expect(screen.getByText('Access URL: /t/acme-r-d-labs/')).toBeInTheDocument();
    change(screen.getByPlaceholderText('acme-corp'), 'acme');
    change(screen.getByPlaceholderText('Acme Corporation Inc.'), 'Acme Inc.');
    change(screen.getByPlaceholderText('admin@acme.com'), 'it@acme.com');
    change(screen.getByRole('combobox'), 'enterprise');
    expect(screen.getByLabelText('Plan')).toHaveValue('enterprise');
    expect(screen.getByLabelText('URL Slug *')).toHaveAccessibleDescription('Access URL: /t/acme/');
    const [maxUsers, maxProjects] = screen.getAllByRole('spinbutton');
    change(maxUsers, '25');
    change(maxProjects, '200');

    await submit('Create Tenant');
    expect(createTenant).toHaveBeenCalledWith({
      name: '  Acme R&D Labs! ',
      slug: 'acme',
      company_name: 'Acme Inc.',
      admin_email: 'it@acme.com',
      plan: 'enterprise',
      max_users: 25,
      max_projects: 200,
    });
    expect(onCreated).toHaveBeenCalledWith(tenant);
    // Without the switch the tenant stays pending: nothing is provisioned.
    expect(provisionTenant).not.toHaveBeenCalled();
  });

  it('provisions right away with the demo data when the switch is on', async () => {
    const tenant = makeTenant({ id: 'new', name: 'Acme' });
    vi.mocked(createTenant).mockResolvedValue(created(tenant));
    vi.mocked(provisionTenant).mockResolvedValue({ success: true, adminEmail: 'it@acme.com', adminPassword: 'Gen3rated!' });
    const onCreated = vi.fn();
    const onShowCredentials = vi.fn();
    render(<CreateTenantModal onClose={vi.fn()} onCreated={onCreated} onShowCredentials={onShowCredentials} />);

    change(screen.getByPlaceholderText('Acme Corporation'), 'Acme');
    change(screen.getByPlaceholderText('admin@acme.com'), 'it@acme.com');
    fireEvent.click(screen.getByRole('switch', { name: SEED_DEMO_LABEL }));
    expect(screen.getByText(/Only the admin can sign in/)).toBeInTheDocument();

    await submit('Create Tenant');
    expect(createTenant).toHaveBeenCalledTimes(1);
    expect(provisionTenant).toHaveBeenCalledWith('new', { seedDemoData: true });
    expect(onShowCredentials).toHaveBeenCalledWith('Database Provisioned!', 'it@acme.com', 'Gen3rated!');
    expect(onCreated).toHaveBeenCalledWith(tenant);
  });

  it('keeps a created tenant when provisioning fails and reports it', async () => {
    const tenant = makeTenant({ id: 'new', name: 'Acme' });
    vi.mocked(createTenant).mockResolvedValue(created(tenant));
    vi.mocked(provisionTenant).mockRejectedValueOnce(new Error('PG down'));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<CreateTenantModal onClose={onClose} onCreated={onCreated} />);

    change(screen.getByPlaceholderText('Acme Corporation'), 'Acme');
    change(screen.getByPlaceholderText('admin@acme.com'), 'it@acme.com');
    fireEvent.click(screen.getByRole('switch', { name: SEED_DEMO_LABEL }));
    await submit('Create Tenant');

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The tenant was created, but provisioning failed: PG down. Use Provision database in the tenant list to retry.'
    );
    // The form is done: no second create, the fields are locked, only Close is left.
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Create Tenant' })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Acme Corporation')).toBeDisabled();
    expect(screen.getByRole('switch', { name: SEED_DEMO_LABEL })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCreated).toHaveBeenCalledWith(tenant);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports a non-Error provisioning failure generically and closes on Escape', async () => {
    const tenant = makeTenant({ id: 'new' });
    vi.mocked(createTenant).mockResolvedValue(created(tenant));
    vi.mocked(provisionTenant).mockRejectedValueOnce('x');
    const onCreated = vi.fn();
    render(<CreateTenantModal onClose={vi.fn()} onCreated={onCreated} />);
    change(screen.getByPlaceholderText('Acme Corporation'), 'Acme');
    change(screen.getByPlaceholderText('admin@acme.com'), 'it@acme.com');
    fireEvent.click(screen.getByRole('switch', { name: SEED_DEMO_LABEL }));
    await submit('Create Tenant');
    expect(screen.getByRole('alert')).toHaveTextContent('provisioning failed: Unknown error');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCreated).toHaveBeenCalledWith(tenant);
  });

  it('shows the API error and stays open', async () => {
    vi.mocked(createTenant).mockRejectedValueOnce(new Error('Slug already exists'));
    const onCreated = vi.fn();
    render(<CreateTenantModal onClose={vi.fn()} onCreated={onCreated} />);
    // Required fields first: the browser blocks submitting an invalid form.
    change(screen.getByPlaceholderText('Acme Corporation'), 'Acme');
    change(screen.getByPlaceholderText('admin@acme.com'), 'it@acme.com');
    await submit('Create Tenant');
    expect(screen.getByText('Slug already exists')).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();

    vi.mocked(createTenant).mockRejectedValueOnce('x');
    await submit('Create Tenant');
    expect(screen.getByText('Failed to create tenant')).toBeInTheDocument();
  });

  it('closes with Cancel and with Escape', () => {
    const onClose = vi.fn();
    render(<CreateTenantModal onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ProvisionTenantModal', () => {
  it('hands the chosen options to the caller and names the tenant', () => {
    const onConfirm = vi.fn();
    render(<ProvisionTenantModal tenantName="Acme Labs" onClose={vi.fn()} onConfirm={onConfirm} />);
    expect(screen.getByText('Acme Labs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Provision' }));
    expect(onConfirm).toHaveBeenLastCalledWith({ seedDemoData: false });
    fireEvent.click(screen.getByRole('switch', { name: SEED_DEMO_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: 'Provision' }));
    expect(onConfirm).toHaveBeenLastCalledWith({ seedDemoData: true });
  });

  it('closes with Cancel, the close button and Escape without confirming', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<ProvisionTenantModal tenantName="Acme" onClose={onClose} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('CreateOrganizationModal', () => {
  it('auto-generates the slug until it is edited by hand and trims the payload', async () => {
    vi.mocked(createOrganization).mockResolvedValue({} as never);
    const onCreated = vi.fn();
    render(<CreateOrganizationModal onClose={vi.fn()} onCreated={onCreated} />);
    change(screen.getByLabelText('Name *'), 'Acme Group');
    expect(screen.getByLabelText('Slug *')).toHaveValue('acme-group');
    change(screen.getByLabelText('Name *'), 'Acme Group AG');
    expect(screen.getByLabelText('Slug *')).toHaveValue('acme-group-ag');

    change(screen.getByLabelText('Slug *'), 'ACME_Custom');
    expect(screen.getByLabelText('Slug *')).toHaveValue('acmecustom');
    change(screen.getByLabelText('Name *'), ' Acme Holding ');
    expect(screen.getByLabelText('Slug *')).toHaveValue('acmecustom');
    change(screen.getByLabelText('Description'), '  ');

    await submit('Create Organization');
    expect(createOrganization).toHaveBeenCalledWith({ name: 'Acme Holding', slug: 'acmecustom', description: undefined });
    expect(onCreated).toHaveBeenCalled();
  });

  it('validates required fields and the slug format before calling the API', async () => {
    render(<CreateOrganizationModal onClose={vi.fn()} onCreated={vi.fn()} />);
    await submit('Create Organization');
    expect(screen.getByText('Name and slug are required')).toBeInTheDocument();

    change(screen.getByLabelText('Name *'), 'Acme');
    change(screen.getByLabelText('Slug *'), 'acme-');
    await submit('Create Organization');
    expect(screen.getByText(/Slug must start and end with a letter\/number/)).toBeInTheDocument();
    expect(createOrganization).not.toHaveBeenCalled();
  });

  it('shows API errors and closes with Escape', async () => {
    vi.mocked(createOrganization).mockRejectedValueOnce(new Error('Slug taken'));
    const onClose = vi.fn();
    render(<CreateOrganizationModal onClose={onClose} onCreated={vi.fn()} />);
    change(screen.getByLabelText('Name *'), 'A');
    change(screen.getByLabelText('Description'), 'Group');
    await submit('Create Organization');
    expect(createOrganization).toHaveBeenCalledWith({ name: 'A', slug: 'a', description: 'Group' });
    expect(screen.getByText('Slug taken')).toBeInTheDocument();

    vi.mocked(createOrganization).mockRejectedValueOnce(null);
    await submit('Create Organization');
    expect(screen.getByText('Failed to create organization')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CreateAdminModal', () => {
  it('submits the new admin user', async () => {
    vi.mocked(createAdminUser).mockResolvedValue({} as never);
    const onCreated = vi.fn();
    render(<CreateAdminModal onClose={vi.fn()} onCreated={onCreated} />);
    change(screen.getByPlaceholderText('admin@example.com'), 'new@milestone.local');
    change(screen.getByPlaceholderText('••••••••'), 'longpassword');
    change(screen.getByPlaceholderText('John Doe'), 'New Admin');
    change(screen.getByRole('combobox'), 'superadmin');
    expect(screen.getByLabelText('Role')).toHaveValue('superadmin');
    expect(screen.getByLabelText('Password *')).toHaveValue('longpassword');
    await submit('Create Admin');
    expect(createAdminUser).toHaveBeenCalledWith({
      email: 'new@milestone.local',
      password: 'longpassword',
      name: 'New Admin',
      role: 'superadmin',
    });
    expect(onCreated).toHaveBeenCalled();
  });

  it('shows API errors and closes on Cancel', async () => {
    vi.mocked(createAdminUser).mockRejectedValueOnce(new Error('Email exists'));
    const onClose = vi.fn();
    render(<CreateAdminModal onClose={onClose} onCreated={vi.fn()} />);
    change(screen.getByPlaceholderText('admin@example.com'), 'dup@milestone.local');
    change(screen.getByPlaceholderText('••••••••'), 'longpassword');
    change(screen.getByPlaceholderText('John Doe'), 'Dup');
    await submit('Create Admin');
    expect(screen.getByText('Email exists')).toBeInTheDocument();
    vi.mocked(createAdminUser).mockRejectedValueOnce(undefined);
    await submit('Create Admin');
    expect(screen.getByText('Failed to create admin user')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('TenantDetailsModal', () => {
  it('loads the tenant and its last 10 audit entries', async () => {
    vi.mocked(getTenant).mockResolvedValue(
      makeTenant({
        organization_id: 'o1',
        organization_name: 'Acme Group',
        required_group_ids: ['g1'],
        group_membership_mode: 'all',
      })
    );
    vi.mocked(getTenantAuditLog).mockResolvedValue([
      makeAuditEntry(),
      makeAuditEntry({ id: 'a2', action: 'tenant.status_changed', actor: null }),
    ]);
    render(<TenantDetailsModal tenantId="t-demo" onClose={vi.fn()} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Demo Company' })).toBeInTheDocument();
    expect(getTenant).toHaveBeenCalledWith('t-demo');
    expect(getTenantAuditLog).toHaveBeenCalledWith('t-demo', 10);

    expect(screen.getByText('Demo Company AG')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('SSO via Org')).toBeInTheDocument();
    expect(screen.getByText('1 group(s) configured')).toBeInTheDocument();
    expect(screen.getByText('All groups required')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /\/t\/demo\// })).toHaveAttribute('href', '/t/demo/');
    expect(screen.getByText('tenant.provisioned')).toBeInTheDocument();
    expect(screen.getByText(/by admin@milestone\.local/)).toBeInTheDocument();
    expect(screen.getByText('tenant.status_changed')).toBeInTheDocument();
  });

  it('shows defaults for a tenant outside any organization', async () => {
    vi.mocked(getTenant).mockResolvedValue(
      makeTenant({ company_name: undefined, status: 'suspended', database_status: { exists: true, accessible: false } })
    );
    vi.mocked(getTenantAuditLog).mockResolvedValue([]);
    render(<TenantDetailsModal tenantId="t-demo" onClose={vi.fn()} />);
    expect(await screen.findByText('Not assigned')).toBeInTheDocument();
    expect(screen.getByText('suspended')).toBeInTheDocument();
    expect(screen.getByText('Exists')).toBeInTheDocument();
    expect(screen.queryByText('Recent Activity')).not.toBeInTheDocument();
  });

  it('shows org members with no group requirement as open to all org users', async () => {
    vi.mocked(getTenant).mockResolvedValue(
      makeTenant({ organization_id: 'o1', organization_name: 'Acme', database_status: { exists: false, accessible: false } })
    );
    vi.mocked(getTenantAuditLog).mockResolvedValue([]);
    render(<TenantDetailsModal tenantId="t-demo" onClose={vi.fn()} />);
    expect(await screen.findByText('None (all org users allowed)')).toBeInTheDocument();
    expect(screen.getByText('Any group allowed')).toBeInTheDocument();
    expect(screen.getByText('Not provisioned')).toBeInTheDocument();
  });

  it('shows a load error and closes from the footer or Escape', async () => {
    vi.mocked(getTenant).mockRejectedValue(new Error('Tenant not found'));
    vi.mocked(getTenantAuditLog).mockResolvedValue([]);
    const onClose = vi.fn();
    render(<TenantDetailsModal tenantId="gone" onClose={onClose} />);
    expect(await screen.findByText('Tenant not found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('falls back to a generic load error', async () => {
    vi.mocked(getTenant).mockRejectedValue('x');
    vi.mocked(getTenantAuditLog).mockResolvedValue([]);
    render(<TenantDetailsModal tenantId="gone" onClose={vi.fn()} />);
    expect(await screen.findByText('Failed to load tenant details')).toBeInTheDocument();
  });
});
