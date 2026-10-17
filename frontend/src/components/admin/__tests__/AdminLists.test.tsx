/**
 * Admin portal lists other than tenants: organizations (delete guarded by
 * tenant count), admin users (toggle active / delete, never yourself) and the
 * system statistics panel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { OrganizationList } from '../OrganizationList';
import { AdminUserList } from '../AdminUserList';
import { SystemStatsPanel } from '../SystemStatsPanel';
import { useAdminStore } from '@/stores/adminStore';
import { deleteAdminUser, deleteOrganization, updateAdminUser } from '@/api';
import { makeAdminListUser, makeOrganization, makeStats } from './adminFixtures';
import { stubConfirm } from '@/test/confirmDialog';

vi.mock('@/api', () => ({
  deleteOrganization: vi.fn(),
  deleteAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
}));

let confirmSpy: ReturnType<typeof stubConfirm>;

beforeEach(() => {
  useAdminStore.setState(useAdminStore.getInitialState());
  vi.mocked(deleteOrganization).mockReset().mockResolvedValue(undefined);
  vi.mocked(deleteAdminUser).mockReset().mockResolvedValue(undefined);
  vi.mocked(updateAdminUser).mockReset().mockResolvedValue({} as never);
  confirmSpy = stubConfirm(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const click = (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el);
  });

const rowOf = (text: string) => within(screen.getByText(text).closest('tr') as HTMLElement);

describe('OrganizationList', () => {
  const props = { onCreateNew: vi.fn(), onViewDetails: vi.fn(), onRefresh: vi.fn() };
  beforeEach(() => Object.values(props).forEach((fn) => fn.mockReset()));

  it('shows an empty state and zeroed stats', () => {
    render(<OrganizationList {...props} />);
    expect(screen.getByText(/No organizations found/)).toBeInTheDocument();
    expect(screen.getByText('Total Organizations').nextSibling).toHaveTextContent('0');
    fireEvent.click(screen.getByRole('button', { name: /Create Organization/ }));
    expect(props.onCreateNew).toHaveBeenCalled();
  });

  it('lists organizations with SSO state and aggregate stats', () => {
    useAdminStore.setState({
      organizations: [
        makeOrganization({ tenant_count: 2, sso_enabled: true }),
        makeOrganization({ id: 'o2', name: 'Beta Labs', slug: 'beta', description: undefined, tenant_count: 1 }),
      ],
    });
    render(<OrganizationList {...props} />);
    expect(screen.getByText('SSO Enabled').nextSibling).toHaveTextContent('1');
    expect(screen.getByText('Total Tenants').nextSibling).toHaveTextContent('3');
    expect(rowOf('acme').getByText('Enabled')).toBeInTheDocument();
    expect(rowOf('acme').getByText('Shared Entra tenant')).toBeInTheDocument();
    expect(rowOf('beta').getByText('Not configured')).toBeInTheDocument();
    expect(rowOf('beta').getByText('—')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Beta Labs' }));
    fireEvent.click(rowOf('acme').getByTitle('View Details & Configure SSO'));
    expect(props.onViewDetails.mock.calls).toEqual([['o2'], ['o-acme']]);
  });

  it('refuses to delete an organization that still has tenants', async () => {
    useAdminStore.setState({ organizations: [makeOrganization({ tenant_count: 2 })] });
    render(<OrganizationList {...props} />);
    await click(rowOf('acme').getByTitle('Delete Organization'));
    expect(screen.getByRole('alert')).toHaveTextContent('it has 2 tenant(s) assigned');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(deleteOrganization).not.toHaveBeenCalled();
  });

  it('deletes an empty organization after confirmation', async () => {
    useAdminStore.setState({ organizations: [makeOrganization()] });
    render(<OrganizationList {...props} />);
    confirmSpy.mockResolvedValueOnce(false);
    await click(rowOf('acme').getByTitle('Delete Organization'));
    expect(confirmSpy).toHaveBeenCalledWith({
      message:
        'Delete organization "Acme Group"?\n\nThis will also delete its SSO configuration.\nThis action cannot be undone.',
      title: 'Delete organization',
      confirmLabel: 'Delete',
      destructive: true,
    });
    expect(deleteOrganization).not.toHaveBeenCalled();
    expect(props.onRefresh).not.toHaveBeenCalled();

    await click(rowOf('acme').getByTitle('Delete Organization'));
    expect(deleteOrganization).toHaveBeenCalledWith('o-acme');
    expect(props.onRefresh).toHaveBeenCalled();

    vi.mocked(deleteOrganization).mockRejectedValue(new Error('in use'));
    await click(rowOf('acme').getByTitle('Delete Organization'));
    expect(screen.getByRole('alert')).toHaveTextContent('in use');
  });
});

describe('AdminUserList', () => {
  const props = { onCreateNew: vi.fn(), onRefresh: vi.fn() };
  beforeEach(() => Object.values(props).forEach((fn) => fn.mockReset()));

  it('shows an empty state', () => {
    render(<AdminUserList {...props} />);
    expect(screen.getByText('No admin users found.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add Admin/ }));
    expect(props.onCreateNew).toHaveBeenCalled();
  });

  it('marks the signed-in admin and disables actions on their own row', () => {
    useAdminStore.setState({
      adminUser: { id: 1, email: 'root@milestone.local', name: 'Root', role: 'superadmin' },
      adminUsers: [
        makeAdminListUser({ id: 1, email: 'root@milestone.local', role: 'superadmin', last_login: '2026-03-01T08:00:00.000Z' }),
        makeAdminListUser({ active: false }),
      ],
    });
    render(<AdminUserList {...props} />);
    const me = rowOf('root@milestone.local');
    expect(me.getByText('(you)')).toBeInTheDocument();
    expect(me.getByText('superadmin')).toBeInTheDocument();
    expect(me.getByTitle('Disable')).toBeDisabled();
    expect(me.getByTitle('Delete')).toBeDisabled();
    const other = rowOf('ops@milestone.local');
    expect(other.getByText('Disabled')).toBeInTheDocument();
    expect(other.getByText('-')).toBeInTheDocument();
    expect(other.getByTitle('Enable')).toBeEnabled();
  });

  it('toggles active state and deletes other admins', async () => {
    useAdminStore.setState({
      adminUser: { id: 1, email: 'root@milestone.local', name: 'Root', role: 'superadmin' },
      adminUsers: [makeAdminListUser()],
    });
    render(<AdminUserList {...props} />);
    await click(rowOf('ops@milestone.local').getByTitle('Disable'));
    expect(updateAdminUser).toHaveBeenCalledWith(2, { active: false });

    await click(rowOf('ops@milestone.local').getByTitle('Delete'));
    expect(confirmSpy).toHaveBeenCalledWith({
      message: 'Delete admin user "ops@milestone.local"?',
      title: 'Delete admin',
      confirmLabel: 'Delete',
      destructive: true,
    });
    expect(deleteAdminUser).toHaveBeenCalledWith(2);
    expect(props.onRefresh).toHaveBeenCalledTimes(2);
  });

  it('shows API errors in place and skips unconfirmed deletes', async () => {
    useAdminStore.setState({ adminUsers: [makeAdminListUser()] });
    render(<AdminUserList {...props} />);
    vi.mocked(updateAdminUser).mockRejectedValue(new Error('forbidden'));
    await click(rowOf('ops@milestone.local').getByTitle('Disable'));
    expect(screen.getByRole('alert')).toHaveTextContent('forbidden');

    confirmSpy.mockResolvedValueOnce(false);
    await click(rowOf('ops@milestone.local').getByTitle('Delete'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'Delete admin user "ops@milestone.local"?' }));
    expect(deleteAdminUser).not.toHaveBeenCalled();

    vi.mocked(deleteAdminUser).mockRejectedValue('boom');
    await click(rowOf('ops@milestone.local').getByTitle('Delete'));
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown error');
  });
});

describe('SystemStatsPanel', () => {
  it('shows a loading message until stats arrive', () => {
    render(<SystemStatsPanel onRefresh={vi.fn()} />);
    expect(screen.getByText('Loading statistics...')).toBeInTheDocument();
  });

  it('renders tenant, connection and server figures and refreshes', () => {
    const onRefresh = vi.fn();
    useAdminStore.setState({ systemStats: makeStats() });
    render(<SystemStatsPanel onRefresh={onRefresh} />);
    expect(screen.getByText('Archived').nextSibling).toHaveTextContent('0');
    expect(screen.getByText('Total Connections').nextSibling).toHaveTextContent('12');
    expect(screen.getByText('1d 2h 3m')).toBeInTheDocument();
    expect(screen.getByText('256 MB')).toBeInTheDocument();
    expect(screen.getByText('3.11.9')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it.each([
    [7380, '2h 3m'],
    [120, '2m'],
  ])('formats an uptime of %i s as %s', (uptime, text) => {
    useAdminStore.setState({ systemStats: makeStats({ system: { uptime, memory_mb: 1, python_version: '3.11' } }) });
    render(<SystemStatsPanel onRefresh={vi.fn()} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
