/**
 * Settings › SSO (admins only): loads the full config with the masked
 * secret, validates before enabling, sends the secret only when typed, and
 * turns read-only when the organization's SSO takes precedence.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SSOPanel } from '../panels/SSOPanel';
import { resetAllStores, useAppStore } from '@/stores';
import { apiGet, apiPut } from '@/api/client';
import { makeUser } from '@/test/factories';

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));

const fullConfig = {
  enabled: 1,
  tenant_id: 'tenant-guid',
  client_id: 'client-guid',
  client_secret_masked: '••••••ab12',
  redirect_uri: 'https://planner.example/api/auth/sso/callback',
  auto_create_users: 0,
  default_role: 'user' as const,
};

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: /Save Configuration|Saving/ });

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetAllStores();
  useAppStore.setState({ currentUser: makeUser({ role: 'admin' }) });
  vi.mocked(apiGet).mockReset().mockResolvedValue(fullConfig);
  vi.mocked(apiPut).mockReset().mockResolvedValue({});
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
    render(<SSOPanel />);
    await screen.findByDisplayValue('tenant-guid');
    fireEvent.change(field(/Tenant ID/), { target: { value: '  new-tenant  ' } });
    fireEvent.click(screen.getByRole('switch', { name: /Auto-create users/ }));
    fireEvent.change(field(/Default role/), { target: { value: 'superuser' } });
    fireEvent.click(save());

    expect(await screen.findByText('SSO configuration saved successfully')).toBeInTheDocument();
    expect(apiPut).toHaveBeenCalledWith('/api/sso/config', {
      enabled: true,
      tenant_id: 'new-tenant',
      client_id: 'client-guid',
      redirect_uri: fullConfig.redirect_uri,
      auto_create_users: true,
      default_role: 'superuser',
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));

    fireEvent.change(field(/Client Secret/), { target: { value: 's3cret' } });
    fireEvent.click(save());
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(2));
    expect(vi.mocked(apiPut).mock.calls[1][1]).toMatchObject({ client_secret: 's3cret' });
    await waitFor(() => expect(field(/Client Secret/)).toHaveValue(''));
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
});
