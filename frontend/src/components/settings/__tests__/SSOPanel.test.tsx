/**
 * Settings › SSO (admins only): loads the full config with the masked
 * secret, validates before enabling, sends the secret only when typed, and
 * turns read-only when the organization's SSO takes precedence. Over a live
 * configuration a sign-in-affecting save asks for the typed word CHANGE;
 * "Test configuration" posts the entered values; unsaved input is reported.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SSOPanel } from '../panels/SSOPanel';
import { resetAllStores, useAppStore } from '@/stores';
import { apiGet, apiPost, apiPut } from '@/api/client';
import { makeRole, makeSystemRoles, makeUser } from '@/test/factories';
import { stubConfirm } from '@/test/confirmDialog';

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));
const rolesApi = vi.hoisted(() => ({ getAll: vi.fn() }));
vi.mock('@/api/endpoints/roles', () => ({ rolesApi }));

const ROLES = makeSystemRoles(makeRole({ name: 'Team lead' }));

const fullConfig = {
  enabled: 1,
  tenant_id: 'tenant-guid',
  client_id: 'client-guid',
  client_secret_masked: '••••••ab12',
  redirect_uri: 'https://planner.example/api/auth/sso/callback',
  auto_create_users: 0,
  default_role: 'user' as const,
};

const TEST_RESULT = {
  credentialsOk: false,
  summary: 'Microsoft rejected the configuration. See below.',
  checks: [
    { name: 'Directory (tenant) ID', status: 'pass', message: 'Looks like a valid identifier.' },
    { name: 'Client credentials', status: 'fail', message: 'Invalid secret', code: 'AADSTS7000215' },
  ],
};

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: /Save Configuration|Saving/ });
const testButton = () => screen.getByRole('button', { name: 'Test configuration' });
const CONFIRM = expect.objectContaining({ confirmWord: 'CHANGE', title: 'Change Microsoft sign-in settings' });

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetAllStores();
  useAppStore.setState({ currentUser: makeUser({ role: 'admin' }), roles: ROLES });
  rolesApi.getAll.mockReset().mockResolvedValue(ROLES);
  vi.mocked(apiGet).mockReset().mockResolvedValue(fullConfig);
  vi.mocked(apiPut).mockReset().mockResolvedValue({});
  vi.mocked(apiPost).mockReset().mockResolvedValue(TEST_RESULT);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  return () => errorSpy.mockRestore();
});

describe('SSOPanel', () => {
  it('renders nothing for non-admins and does not load', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'superuser' }) });
    const { container } = render(<SSOPanel />);
    expect(container).toBeEmptyDOMElement();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('offers every role but admin as the default role, custom ones included', async () => {
    render(<SSOPanel />);
    await screen.findByDisplayValue('tenant-guid');
    const options = Array.from(field(/Default role/).querySelectorAll('option')).map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ['superuser', 'Superuser'],
      ['user', 'User'],
      ['team_lead', 'Team lead'],
    ]);
    fireEvent.click(screen.getByRole('switch', { name: /Auto-create users/ }));
    fireEvent.change(field(/Default role/), { target: { value: 'team_lead' } });
    fireEvent.click(save());
    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    expect(vi.mocked(apiPut).mock.calls[0][1]).toMatchObject({ default_role: 'team_lead' });
  });

  it('loads the roles when the store has none, keeping the saved default meanwhile', async () => {
    useAppStore.setState({ roles: [] });
    let release!: (roles: typeof ROLES) => void;
    rolesApi.getAll.mockImplementation(() => new Promise((r) => (release = r)));
    vi.mocked(apiGet).mockResolvedValue({ ...fullConfig, default_role: 'team_lead' });
    render(<SSOPanel />);
    await screen.findByDisplayValue('tenant-guid');
    expect(field(/Default role/)).toHaveValue('team_lead');
    expect(Array.from(field(/Default role/).querySelectorAll('option')).map((o) => o.textContent)).toEqual(['team_lead']);

    await act(async () => release(ROLES));
    expect(field(/Default role/)).toHaveValue('team_lead');
    expect(screen.getByRole('option', { name: 'Team lead' })).toBeInTheDocument();
    expect(rolesApi.getAll).toHaveBeenCalledTimes(1);
  });

  it('loads the configuration with the masked secret as placeholder', async () => {
    render(<SSOPanel />);
    expect(screen.getByText('Loading configuration...')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('tenant-guid')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/api/sso/config/full');
    expect(screen.getByRole('switch', { name: 'Enable SSO' })).toBeChecked();
    expect(field(/Client ID/)).toHaveValue('client-guid');
    expect(field(/Client Secret/)).toHaveValue('');
    expect(field(/Client Secret/)).toHaveAttribute('placeholder', '••••••ab12');
    // auto-create off: the default role cannot be chosen
    expect(field(/Default role/)).toBeDisabled();
    expect(screen.queryByText(/managed by your organization/)).not.toBeInTheDocument();
  });

  it('defaults the redirect URI and secret placeholder for an empty config', async () => {
    vi.mocked(apiGet).mockResolvedValue({ enabled: 0, tenant_id: '', client_id: '', redirect_uri: '', auto_create_users: 0 });
    render(<SSOPanel />);
    await waitFor(() => expect(field(/Redirect URI/)).toHaveValue(`${window.location.origin}/api/auth/sso/callback`));
    expect(field(/Client Secret/)).toHaveAttribute('placeholder', 'Enter client secret');
    expect(screen.getByRole('switch', { name: 'Enable SSO' })).not.toBeChecked();
    expect(field(/Tenant ID/)).toBeDisabled();
  });

  it('offers auto-create as a switch that follows the Enable SSO state', async () => {
    vi.mocked(apiGet).mockResolvedValue({ ...fullConfig, enabled: 0 });
    render(<SSOPanel />);
    await screen.findByDisplayValue('tenant-guid');
    const autoCreate = screen.getByRole('switch', { name: /Auto-create users/ });
    expect(autoCreate).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable SSO' }));
    expect(autoCreate).toBeEnabled();
    fireEvent.click(autoCreate);
    expect(autoCreate).toBeChecked();
  });

  it('shows the load error', async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error('Forbidden'));
    render(<SSOPanel />);
    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
  });

  it('requires the Entra fields before enabling SSO', async () => {
    vi.mocked(apiGet).mockResolvedValue({ ...fullConfig, enabled: 0, tenant_id: '' });
    render(<SSOPanel />);
    await screen.findByDisplayValue('client-guid');
    fireEvent.click(screen.getByRole('switch', { name: 'Enable SSO' }));
    fireEvent.click(save());
    expect(
      screen.getByText('Please fill in Tenant ID, Client ID, and Redirect URI to enable SSO')
    ).toBeInTheDocument();
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('saves without the secret unless one was typed, then reloads', async () => {
    // Both saves change sign-in values of a live configuration: each asks.
    const confirm = stubConfirm(true);
    render(<SSOPanel />);
    await screen.findByDisplayValue('tenant-guid');
    fireEvent.change(field(/Tenant ID/), { target: { value: '  new-tenant  ' } });
    fireEvent.change(field(/Client ID/), { target: { value: 'new-client' } });
    fireEvent.change(field(/Redirect URI/), { target: { value: 'https://new.example/cb' } });
    expect(field(/Client ID/)).toHaveValue('new-client');
    expect(field(/Redirect URI/)).toHaveValue('https://new.example/cb');
    fireEvent.click(screen.getByRole('switch', { name: /Auto-create users/ }));
    fireEvent.change(field(/Default role/), { target: { value: 'superuser' } });
    fireEvent.click(save());

    expect(await screen.findByText('SSO configuration saved successfully')).toBeInTheDocument();
    expect(apiPut).toHaveBeenCalledWith('/api/sso/config', {
      enabled: true,
      tenant_id: 'new-tenant',
      client_id: 'new-client',
      redirect_uri: 'https://new.example/cb',
      auto_create_users: true,
      default_role: 'superuser',
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));

    fireEvent.change(field(/Client Secret/), { target: { value: 's3cret' } });
    fireEvent.click(save());
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(2));
    expect(vi.mocked(apiPut).mock.calls[1][1]).toMatchObject({ client_secret: 's3cret' });
    await waitFor(() => expect(field(/Client Secret/)).toHaveValue(''));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenNthCalledWith(1, CONFIRM);
    expect(confirm).toHaveBeenNthCalledWith(2, CONFIRM);
    expect(confirm.mock.calls[0][0].message).toMatch(/change the Directory \(tenant\) ID/);
    expect(confirm.mock.calls[1][0].message).toMatch(/replace the client secret/);
  });

  it('shows the save error (e.g. the 409 while organization SSO is active)', async () => {
    vi.mocked(apiPut).mockRejectedValue(new Error('Organization SSO is active'));
    render(<SSOPanel />);
    await screen.findByDisplayValue('tenant-guid');
    fireEvent.click(save());
    expect(await screen.findByText('Organization SSO is active')).toBeInTheDocument();
    expect(screen.queryByText('SSO configuration saved successfully')).not.toBeInTheDocument();
  });

  it('is read-only when the organization manages SSO', async () => {
    vi.mocked(apiGet).mockResolvedValue({
      ...fullConfig,
      auto_create_users: 1,
      org_sso_active: true,
      organization: { name: 'Acme Group' },
    });
    render(<SSOPanel />);
    expect(await screen.findByText('Acme Group')).toBeInTheDocument();
    expect(screen.getByText(/managed by your organization/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable SSO' })).toBeDisabled();
    expect(field(/Tenant ID/)).toBeDisabled();
    expect(field(/Default role/)).toBeDisabled();
    expect(save()).toBeDisabled();
  });

  it('names no organization when the config has none', async () => {
    vi.mocked(apiGet).mockResolvedValue({ ...fullConfig, org_sso_active: true });
    render(<SSOPanel />);
    const notice = await screen.findByText(/managed by your organization/);
    expect(notice).toHaveTextContent(/managed by your organization\. Organization SSO takes precedence/);
    expect(notice.querySelector('strong')).toBeNull();
  });


  it('sends one PUT when Save is clicked twice before the first save settles', async () => {
    let finish: (value: unknown) => void = () => {};
    vi.mocked(apiPut).mockImplementation(() => new Promise((r) => { finish = r; }));
    render(<SSOPanel />);
    await screen.findByDisplayValue('tenant-guid');

    act(() => {
      fireEvent.click(save());
      fireEvent.click(save());
    });
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(save()).toHaveAttribute('aria-busy', 'true');

    await act(async () => finish({}));
    expect(await screen.findByText('SSO configuration saved successfully')).toBeInTheDocument();
    expect(apiPut).toHaveBeenCalledTimes(1);
  });

  describe('confirming a change to live sign-in settings', () => {
    it('saves a first-time configuration without asking', async () => {
      const confirm = stubConfirm(true);
      vi.mocked(apiGet).mockResolvedValue({ enabled: 0, tenant_id: '', client_id: '', redirect_uri: '', auto_create_users: 0 });
      render(<SSOPanel />);
      await waitFor(() => expect(field(/Redirect URI/)).not.toHaveValue(''));
      fireEvent.click(screen.getByRole('switch', { name: 'Enable SSO' }));
      fireEvent.change(field(/Tenant ID/), { target: { value: 'tenant' } });
      fireEvent.change(field(/Client ID/), { target: { value: 'client' } });
      fireEvent.change(field(/Client Secret/), { target: { value: 'secret' } });
      fireEvent.click(save());
      await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
      expect(confirm).not.toHaveBeenCalled();
    });

    it('asks for CHANGE before saving a new tenant id, and saves nothing when cancelled', async () => {
      const confirm = stubConfirm(false);
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.change(field(/Tenant ID/), { target: { value: 'other-tenant' } });
      fireEvent.click(save());
      await waitFor(() => expect(confirm).toHaveBeenCalledWith(CONFIRM));
      const { message, destructive, confirmLabel } = confirm.mock.calls[0][0];
      expect(destructive).toBe(true);
      expect(confirmLabel).toBe('Save changes');
      expect(message).toMatch(/^Single sign-on is live\. You are about to:/);
      expect(message).toMatch(/everyone who signs in with Microsoft only will be unable to sign in/);
      expect(message).toMatch(/Password sign-in keeps working\./);
      expect(message).toMatch(/Tip: use Test configuration first\./);
      expect(message).not.toMatch(/Client ID|client secret|redirect URI/);
      expect(apiPut).not.toHaveBeenCalled();
      expect(save()).toBeEnabled(); // the guard was never taken
    });

    it('names every changed sign-in value', async () => {
      const confirm = stubConfirm(true);
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.change(field(/Client ID/), { target: { value: 'other-client' } });
      fireEvent.change(field(/Redirect URI/), { target: { value: 'https://other.example/cb' } });
      fireEvent.click(save());
      await waitFor(() => expect(apiPut).toHaveBeenCalled());
      const { message } = confirm.mock.calls[0][0];
      expect(message).toMatch(/• change the Client ID\n• change the redirect URI/);
      expect(message).not.toMatch(/tenant\) ID|client secret/);
    });

    it('saves a role or auto-create change without asking', async () => {
      const confirm = stubConfirm(true);
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.click(screen.getByRole('switch', { name: /Auto-create users/ }));
      fireEvent.change(field(/Default role/), { target: { value: 'superuser' } });
      // Padding a value with spaces is no change either (both sides are trimmed).
      fireEvent.change(field(/Tenant ID/), { target: { value: ' tenant-guid ' } });
      fireEvent.click(save());
      await waitFor(() => expect(apiPut).toHaveBeenCalled());
      expect(confirm).not.toHaveBeenCalled();
    });

    it('asks before switching live SSO off, with the switch-off wording', async () => {
      const confirm = stubConfirm(true);
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.click(screen.getByRole('switch', { name: 'Enable SSO' }));
      fireEvent.click(save());
      await waitFor(() => expect(apiPut).toHaveBeenCalled());
      expect(confirm).toHaveBeenCalledWith(CONFIRM);
      const { message } = confirm.mock.calls[0][0];
      expect(message).toMatch(/• switch single sign-on off/);
      expect(message).toMatch(/unable to sign in until SSO is enabled again\. Password sign-in keeps working\./);
      expect(message).not.toMatch(/Tip:/);
      expect(vi.mocked(apiPut).mock.calls[0][1]).toMatchObject({ enabled: false });
    });

    it('does not ask when SSO is switched off and back on', async () => {
      const confirm = stubConfirm(true);
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.click(screen.getByRole('switch', { name: 'Enable SSO' }));
      fireEvent.click(screen.getByRole('switch', { name: 'Enable SSO' }));
      fireEvent.click(save());
      await waitFor(() => expect(apiPut).toHaveBeenCalled());
      expect(confirm).not.toHaveBeenCalled();
    });

    it('does not ask over a configuration without a stored secret', async () => {
      const confirm = stubConfirm(true);
      vi.mocked(apiGet).mockResolvedValue({ ...fullConfig, client_secret_masked: undefined });
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.change(field(/Tenant ID/), { target: { value: 'other-tenant' } });
      fireEvent.click(save());
      await waitFor(() => expect(apiPut).toHaveBeenCalled());
      expect(confirm).not.toHaveBeenCalled();
    });

    it('keeps password managers away from the secret field', async () => {
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      expect(field(/Client Secret/)).toHaveAttribute('autocomplete', 'new-password');
    });
  });

  describe('Test configuration', () => {
    it('posts the entered values, omits a blank secret and shows the result', async () => {
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      expect(screen.getByText('The test uses the values above as entered — nothing is saved.')).toBeInTheDocument();
      fireEvent.change(field(/Tenant ID/), { target: { value: ' typed-tenant ' } });
      fireEvent.change(field(/Client Secret/), { target: { value: '   ' } });
      fireEvent.click(testButton());

      expect(await screen.findByText('Microsoft rejected the configuration. See below.')).toBeInTheDocument();
      expect(apiPost).toHaveBeenCalledWith('/api/auth/sso/test', {
        tenant_id: 'typed-tenant',
        client_id: 'client-guid',
        redirect_uri: 'https://planner.example/api/auth/sso/callback',
      });
      expect(screen.getByText('Client credentials')).toBeInTheDocument();
      expect(screen.getByText('Invalid secret')).toBeInTheDocument();
      expect(screen.getByText('(AADSTS7000215)', { exact: false })).toBeInTheDocument();
      expect(apiPut).not.toHaveBeenCalled();
    });

    it('sends a typed secret, trimmed', async () => {
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.change(field(/Client Secret/), { target: { value: ' typed-secret\n' } });
      fireEvent.click(testButton());
      await waitFor(() => expect(apiPost).toHaveBeenCalled());
      expect(vi.mocked(apiPost).mock.calls[0][1]).toMatchObject({ client_secret: 'typed-secret' });
    });

    it.each([
      [/Tenant ID/, 'x'],
      [/Client ID/, 'y'],
      [/Client Secret/, 'z'],
      [/Redirect URI/, 'https://z.example/cb'],
    ])('clears the result when %s changes', async (label, value) => {
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.click(testButton());
      expect(await screen.findByText('Client credentials')).toBeInTheDocument();
      fireEvent.change(field(label), { target: { value } });
      expect(screen.queryByText('Client credentials')).not.toBeInTheDocument();
    });

    it('clears the result after a successful save', async () => {
      stubConfirm(true);
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.click(testButton());
      expect(await screen.findByText('Client credentials')).toBeInTheDocument();
      fireEvent.click(save());
      expect(await screen.findByText('SSO configuration saved successfully')).toBeInTheDocument();
      expect(screen.queryByText('Client credentials')).not.toBeInTheDocument();
    });

    it('clears the result when the Enable SSO switch changes', async () => {
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.click(testButton());
      expect(await screen.findByRole('status')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('switch', { name: 'Enable SSO' }));
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('shows the "nothing is saved" note only while the organization does not manage SSO', async () => {
      const note = 'The test uses the values above as entered — nothing is saved.';
      const { unmount } = render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      expect(screen.getByText(note)).toBeInTheDocument();
      unmount();

      vi.mocked(apiGet).mockResolvedValue({ ...fullConfig, org_sso_active: true });
      render(<SSOPanel />);
      await screen.findByText(/managed by your organization/);
      expect(screen.queryByText(note)).toBeNull();
    });

    it('validates the required fields before testing', async () => {
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.change(field(/Client ID/), { target: { value: ' ' } });
      fireEvent.click(testButton());
      expect(screen.getByText('Please fill in Tenant ID, Client ID, and Redirect URI to enable SSO')).toBeInTheDocument();
      expect(apiPost).not.toHaveBeenCalled();
    });

    it('shows a failed test in place', async () => {
      vi.mocked(apiPost).mockRejectedValue(new Error('SSO is managed by your organization'));
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.click(testButton());
      expect(await screen.findByRole('alert')).toHaveTextContent('SSO is managed by your organization');
    });

    it('reports a non-Error failure generically', async () => {
      vi.mocked(apiPost).mockRejectedValue('x');
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.click(testButton());
      expect(await screen.findByText('Failed to test configuration')).toBeInTheDocument();
    });

    it('sends one test when clicked twice before the first settles', async () => {
      let finish: (value: unknown) => void = () => {};
      vi.mocked(apiPost).mockImplementation(() => new Promise((r) => { finish = r; }));
      render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      act(() => {
        fireEvent.click(testButton());
        fireEvent.click(testButton());
      });
      expect(apiPost).toHaveBeenCalledTimes(1);
      await act(async () => finish(TEST_RESULT));
      expect(screen.getByText('Client credentials')).toBeInTheDocument();
    });

    it('is disabled while SSO is off or managed by the organization', async () => {
      vi.mocked(apiGet).mockResolvedValue({ ...fullConfig, enabled: 0 });
      const { unmount } = render(<SSOPanel />);
      await screen.findByDisplayValue('tenant-guid');
      expect(testButton()).toBeDisabled();
      unmount();

      vi.mocked(apiGet).mockResolvedValue({ ...fullConfig, org_sso_active: true });
      render(<SSOPanel />);
      await screen.findByText(/managed by your organization/);
      expect(testButton()).toBeDisabled();
    });
  });

  describe('unsaved changes', () => {
    it('reports dirty after an edit and clean after the save', async () => {
      const onDirtyChange = vi.fn();
      render(<SSOPanel onDirtyChange={onDirtyChange} />);
      await screen.findByDisplayValue('tenant-guid');
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);

      fireEvent.change(field(/Default role/), { target: { value: 'superuser' } });
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);

      fireEvent.click(save());
      expect(await screen.findByText('SSO configuration saved successfully')).toBeInTheDocument();
      // The reload answers with the old fixture; the saved snapshot follows it.
      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    });

    it('is clean on load for an empty configuration', async () => {
      const onDirtyChange = vi.fn();
      vi.mocked(apiGet).mockResolvedValue({ enabled: 0, tenant_id: '', client_id: '', redirect_uri: '', auto_create_users: 0 });
      render(<SSOPanel onDirtyChange={onDirtyChange} />);
      await waitFor(() => expect(field(/Redirect URI/)).not.toHaveValue(''));
      expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    });

    it('counts a typed secret, but not spaces', async () => {
      const onDirtyChange = vi.fn();
      render(<SSOPanel onDirtyChange={onDirtyChange} />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.change(field(/Client Secret/), { target: { value: '   ' } });
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
      fireEvent.change(field(/Client Secret/), { target: { value: 'typed' } });
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    });

    it('stays clean when the reload after a save fails', async () => {
      const onDirtyChange = vi.fn();
      stubConfirm(true);
      render(<SSOPanel onDirtyChange={onDirtyChange} />);
      await screen.findByDisplayValue('tenant-guid');
      fireEvent.change(field(/Tenant ID/), { target: { value: 'new-tenant' } });
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      vi.mocked(apiGet).mockRejectedValue(new Error('Reload failed'));
      fireEvent.click(save());
      expect(await screen.findByText('Reload failed')).toBeInTheDocument();
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });
  });
});
