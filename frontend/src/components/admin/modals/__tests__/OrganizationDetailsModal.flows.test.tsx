/**
 * Organization details flows not covered by OrganizationDetailsModal.test.tsx
 * (Escape handling and double-click guards): loading the SSO config (with an
 * invalid legacy default role), SSO validation/save/test, editing details,
 * and adding/removing tenants and their group requirements.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { OrganizationDetailsModal } from '../OrganizationDetailsModal';
import { useAdminStore } from '@/stores/adminStore';
import {
  addTenantToOrganization,
  getOrganization,
  removeTenantFromOrganization,
  testOrganizationSSOConfig,
  updateOrganization,
  updateOrganizationSSOConfig,
  updateTenantGroupAccess,
} from '@/api';
import type { OrganizationDetail } from '@/api/endpoints/admin';
import { makeTenant } from '../../__tests__/adminFixtures';

vi.mock('@/api', () => ({
  getOrganization: vi.fn(),
  updateOrganization: vi.fn(),
  updateOrganizationSSOConfig: vi.fn(),
  testOrganizationSSOConfig: vi.fn(),
  removeTenantFromOrganization: vi.fn(),
  addTenantToOrganization: vi.fn(),
  updateTenantGroupAccess: vi.fn(),
}));

function org(overrides: Partial<OrganizationDetail> = {}): OrganizationDetail {
  return {
    id: 'org-1',
    name: 'Acme Labs',
    slug: 'acme',
    description: 'R&D',
    created_at: '2026-01-01T00:00:00.000Z',
    sso_config: {
      enabled: true,
      configured: true,
      provider: 'entra',
      entraTenantId: 'tenant-guid',
      clientId: 'client-guid',
      redirectUri: 'https://app.example/api/auth/sso/callback',
      autoCreateUsers: true,
      defaultUserRole: 'viewer',
    },
    tenants: [
      { id: 't-1', name: 'Demo Company', slug: 'demo', status: 'active', required_group_ids: ['g1', 'g2'], group_membership_mode: 'all' },
    ],
    ...overrides,
  };
}

const click = (name: string | RegExp) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });

// The tab label is lowercase in the DOM; CSS capitalises it.
const openTenantsTab = () => click('tenants');

async function open(detail = org(), onRefresh = vi.fn()) {
  vi.mocked(getOrganization).mockResolvedValue(detail);
  render(<OrganizationDetailsModal organizationId="org-1" onClose={vi.fn()} onRefresh={onRefresh} />);
  await screen.findByRole('heading', { name: detail.name });
  return onRefresh;
}

beforeEach(() => {
  vi.mocked(getOrganization).mockReset();
  vi.mocked(updateOrganization).mockReset().mockResolvedValue({} as never);
  vi.mocked(updateOrganizationSSOConfig).mockReset().mockResolvedValue({} as never);
  vi.mocked(testOrganizationSSOConfig).mockReset();
  vi.mocked(removeTenantFromOrganization).mockReset().mockResolvedValue(undefined);
  vi.mocked(addTenantToOrganization).mockReset().mockResolvedValue({ success: true });
  vi.mocked(updateTenantGroupAccess).mockReset().mockResolvedValue(undefined);
  useAdminStore.setState({ tenants: [makeTenant({ id: 't-1' }), makeTenant({ id: 't-2', name: 'Other Co', slug: 'other' })] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('details tab', () => {
  it('shows the organization and its SSO status', async () => {
    await open();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('R&D')).toBeInTheDocument();
  });

  it.each([
    [{ enabled: false, configured: true }, 'Configured (Disabled)'],
    [undefined, 'Not configured'],
  ])('labels SSO %o as "%s"', async (sso, label) => {
    const base = org();
    await open(org({ description: undefined, sso_config: sso ? { ...base.sso_config!, ...sso } : undefined }));
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('saves edited details, trimming the values', async () => {
    const onRefresh = await open();
    await click('Edit Details');
    const [name, description] = screen.getAllByRole('textbox');
    expect(screen.getByLabelText('Name')).toBe(name);
    expect(screen.getByLabelText('Description')).toBe(description);
    fireEvent.change(name, { target: { value: '  Acme Holding ' } });
    fireEvent.change(description, { target: { value: '   ' } });
    await click('Save');
    expect(updateOrganization).toHaveBeenCalledWith('org-1', { name: 'Acme Holding', description: undefined });
    expect(onRefresh).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit Details' })).toBeInTheDocument();
  });

  it('keeps the form open and shows the error when saving fails; Cancel restores', async () => {
    vi.mocked(updateOrganization).mockRejectedValue(new Error('Name taken'));
    await open();
    await click('Edit Details');
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'Dup' } });
    await click('Save');
    expect(screen.getByText('Name taken')).toBeInTheDocument();
    await click('Cancel');
    await click('Edit Details');
    expect(screen.getAllByRole('textbox')[0]).toHaveValue('Acme Labs');
  });

  it('shows a load error', async () => {
    vi.mocked(getOrganization).mockRejectedValue(new Error('Organization not found'));
    render(<OrganizationDetailsModal organizationId="nope" onClose={vi.fn()} />);
    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Organization Details' })).toBeInTheDocument();
  });
});

describe('SSO tab', () => {
  it('loads the saved config and falls back to "user" for an invalid default role', async () => {
    await open();
    await click('SSO Configuration');
    expect(screen.getByDisplayValue('tenant-guid')).toBeInTheDocument();
    expect(screen.getByDisplayValue('client-guid')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('user');
    expect(screen.getByLabelText('Default role for new users')).toHaveValue('user');
    expect(screen.getByLabelText('Entra Tenant ID *')).toHaveValue('tenant-guid');
    expect(screen.getByLabelText('Client Secret')).toHaveAccessibleDescription('Leave blank to keep existing secret.');
    expect(screen.getByPlaceholderText('••••••••••••••••')).toBeInTheDocument();
  });

  it('requires the Entra ids and redirect URI to enable SSO', async () => {
    await open();
    await click('SSO Configuration');
    fireEvent.change(screen.getByDisplayValue('client-guid'), { target: { value: ' ' } });
    await click('Save SSO Configuration');
    expect(screen.getByText('Tenant ID, Client ID, and Redirect URI are required to enable SSO')).toBeInTheDocument();
    expect(updateOrganizationSSOConfig).not.toHaveBeenCalled();
  });

  it('saves the config, sending the secret only when typed', async () => {
    const onRefresh = await open();
    await click('SSO Configuration');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'superuser' } });
    await click('Save SSO Configuration');
    expect(updateOrganizationSSOConfig).toHaveBeenLastCalledWith('org-1', {
      enabled: true,
      entraTenantId: 'tenant-guid',
      clientId: 'client-guid',
      redirectUri: 'https://app.example/api/auth/sso/callback',
      autoCreateUsers: true,
      defaultUserRole: 'superuser',
    });
    expect(screen.getByText('SSO configuration saved successfully')).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('••••••••••••••••'), { target: { value: ' s3cret ' } });
    await click('Save SSO Configuration');
    expect(vi.mocked(updateOrganizationSSOConfig).mock.calls[1][1]).toMatchObject({ clientSecret: 's3cret' });
  });

  it('can save a disabled config without ids and reports save errors', async () => {
    await open(org({ sso_config: undefined }));
    await click('SSO Configuration');
    expect(screen.getByRole('button', { name: 'Test configuration' })).toBeDisabled();
    vi.mocked(updateOrganizationSSOConfig).mockRejectedValueOnce(new Error('Encryption key missing'));
    await click('Save SSO Configuration');
    expect(screen.getByText('Encryption key missing')).toBeInTheDocument();
    expect(vi.mocked(updateOrganizationSSOConfig).mock.calls[0][1]).toMatchObject({ enabled: false, entraTenantId: '' });

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.change(screen.getAllByPlaceholderText('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')[0], { target: { value: 't' } });
    fireEvent.change(screen.getAllByPlaceholderText('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')[1], { target: { value: 'c' } });
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    await click('Save SSO Configuration');
    expect(vi.mocked(updateOrganizationSSOConfig).mock.calls[1][1]).toMatchObject({
      enabled: true,
      entraTenantId: 't',
      clientId: 'c',
      autoCreateUsers: true,
    });
  });

  it('shows the result of testing the saved credentials', async () => {
    vi.mocked(testOrganizationSSOConfig).mockResolvedValue({
      credentialsOk: false,
      summary: 'Microsoft rejected the client secret.',
      checks: [
        { name: 'Tenant exists', status: 'pass', message: 'Found' },
        { name: 'Client secret', status: 'fail', message: 'Invalid secret', code: 'AADSTS7000215' },
        { name: 'Redirect URI', status: 'warn', message: 'Not https' },
        { name: 'Groups', status: 'manual', message: 'Check in portal' },
      ],
    });
    await open();
    await click('SSO Configuration');
    await click('Test configuration');
    expect(testOrganizationSSOConfig).toHaveBeenCalledWith('org-1');
    expect(screen.getByText('Microsoft rejected the client secret.')).toBeInTheDocument();
    expect(screen.getByText('(AADSTS7000215)', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Invalid secret')).toBeInTheDocument();
    expect(['✓', '✕', '!', '?'].every((mark) => screen.getByText(mark))).toBe(true);
  });

  it('reports a failed test', async () => {
    vi.mocked(testOrganizationSSOConfig).mockRejectedValue('x');
    await open();
    await click('SSO Configuration');
    await click('Test configuration');
    expect(screen.getByText('Failed to test SSO configuration')).toBeInTheDocument();
  });
});

describe('tenants tab', () => {
  it('lists member tenants with their group requirement and offers the others', async () => {
    await open();
    await openTenantsTab();
    expect(screen.getByText('2 group(s) (all mode)')).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Select a tenant to add...',
      'Other Co (other)',
    ]);
    expect(screen.getByRole('button', { name: 'Add Tenant' })).toBeDisabled();
  });

  it('adds a tenant and warns when its own SSO is now overridden', async () => {
    vi.mocked(addTenantToOrganization).mockResolvedValue({ success: true, tenant_had_own_sso: true });
    const onRefresh = await open();
    await openTenantsTab();
    fireEvent.change(screen.getByLabelText('Tenant to add'), { target: { value: 't-2' } });
    await click('Add Tenant');
    expect(addTenantToOrganization).toHaveBeenCalledWith('org-1', 't-2');
    expect(screen.getByText(/already had its own SSO configured/)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalled();
  });

  it('reports a failed add', async () => {
    vi.mocked(addTenantToOrganization).mockRejectedValue(new Error('Tenant busy'));
    await open();
    await openTenantsTab();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 't-2' } });
    await click('Add Tenant');
    expect(screen.getByText('Tenant busy')).toBeInTheDocument();
  });

  it('removes a tenant only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    await open();
    await openTenantsTab();
    await click('Remove');
    expect(removeTenantFromOrganization).not.toHaveBeenCalled();
    await click('Remove');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(removeTenantFromOrganization).toHaveBeenCalledWith('org-1', 't-1');

    vi.mocked(removeTenantFromOrganization).mockRejectedValue(new Error('Locked'));
    await click('Remove');
    expect(screen.getByText('Locked')).toBeInTheDocument();
  });

  it('edits the group requirement, splitting and trimming ids', async () => {
    await open();
    await openTenantsTab();
    await click('Configure Groups');
    const input = screen.getByPlaceholderText('group-id-1, group-id-2');
    expect(input).toHaveValue('g1, g2');
    fireEvent.change(input, { target: { value: ' a , ,b ' } });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'any' } });
    expect(screen.getByLabelText('Membership Mode')).toHaveValue('any');
    expect(screen.getByLabelText('Required Group IDs')).toBe(input);
    await click('Save');
    expect(updateTenantGroupAccess).toHaveBeenCalledWith('t-1', { requiredGroupIds: ['a', 'b'], groupMembershipMode: 'any' });
    expect(screen.queryByPlaceholderText('group-id-1, group-id-2')).not.toBeInTheDocument();
  });

  it('reports a failed group update and cancels the editor', async () => {
    vi.mocked(updateTenantGroupAccess).mockRejectedValue(new Error('Bad group id'));
    await open();
    await openTenantsTab();
    await click('Configure Groups');
    await click('Save');
    expect(screen.getByText('Bad group id')).toBeInTheDocument();
    await click('Cancel');
    expect(screen.queryByPlaceholderText('group-id-1, group-id-2')).not.toBeInTheDocument();
  });

  it('shows an empty state without member tenants', async () => {
    await open(org({ tenants: [] }));
    await openTenantsTab();
    expect(screen.getByText('No tenants assigned to this organization yet.')).toBeInTheDocument();
  });
});
