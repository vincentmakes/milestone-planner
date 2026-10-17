/**
 * Tenant table: rows and stats from adminStore, the per-status action set,
 * and each action calling the admin API behind a confirm (provision and
 * password reset surface the generated credentials).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { TenantList } from '../TenantList';
import { useAdminStore } from '@/stores/adminStore';
import { deleteTenant, provisionTenant, resetTenantAdminPassword, updateTenantStatus } from '@/api';
import { makeStats, makeTenant } from './adminFixtures';

vi.mock('@/api', () => ({
  updateTenantStatus: vi.fn(),
  provisionTenant: vi.fn(),
  resetTenantAdminPassword: vi.fn(),
  deleteTenant: vi.fn(),
}));

const props = {
  onCreateNew: vi.fn(),
  onViewDetails: vi.fn(),
  onShowCredentials: vi.fn(),
  onRefresh: vi.fn(),
};

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useAdminStore.setState(useAdminStore.getInitialState());
  Object.values(props).forEach((fn) => fn.mockReset());
  vi.mocked(updateTenantStatus).mockReset().mockResolvedValue({} as never);
  vi.mocked(provisionTenant).mockReset();
  vi.mocked(resetTenantAdminPassword).mockReset();
  vi.mocked(deleteTenant).mockReset().mockResolvedValue(undefined);
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function row(name: string) {
  return within(screen.getByRole('button', { name }).closest('tr') as HTMLElement);
}

const click = (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el);
  });

describe('TenantList', () => {
  it('shows an empty state and no stats cards without data', () => {
    render(<TenantList {...props} />);
    expect(screen.getByText(/No tenants found/)).toBeInTheDocument();
    expect(screen.queryByText('Total Tenants')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Create Tenant/ }));
    expect(props.onCreateNew).toHaveBeenCalled();
  });

  it('renders stats and one row per tenant with status and database badges', () => {
    useAdminStore.setState({
      systemStats: makeStats(),
      tenants: [
        makeTenant(),
        makeTenant({
          id: 't2',
          name: 'Pending Co',
          slug: 'pending-co',
          company_name: undefined,
          status: 'pending',
          database_status: { exists: false, accessible: false },
          organization_name: 'Acme Group',
          required_group_ids: ['g1', 'g2'],
        }),
        makeTenant({ id: 't3', name: 'Half Done', status: 'archived', database_status: { exists: true, accessible: false } }),
        makeTenant({ id: 't4', name: 'Mystery', database_status: undefined }),
      ],
    });
    render(<TenantList {...props} />);
    expect(screen.getByText('Total Tenants').nextSibling).toHaveTextContent('7');

    const demo = row('Demo Company');
    expect(demo.getByText('Demo Company AG')).toBeInTheDocument();
    expect(demo.getByRole('link', { name: 'demo' })).toHaveAttribute('href', '/t/demo/');
    expect(demo.getByText('Connected')).toBeInTheDocument();
    expect(demo.getByTitle('Open tenant (new tab)')).toBeInTheDocument();
    expect(demo.getByTitle('Suspend')).toBeInTheDocument();
    expect(demo.queryByTitle('Provision Database')).not.toBeInTheDocument();

    const pending = row('Pending Co');
    expect(pending.getByText('pending')).toBeInTheDocument();
    expect(pending.getByText('Not provisioned')).toBeInTheDocument();
    expect(pending.getByText('Acme Group')).toBeInTheDocument();
    expect(pending.getByText('(2 groups)')).toBeInTheDocument();
    expect(pending.getByTitle('Provision Database')).toBeInTheDocument();
    expect(pending.queryByTitle('Reset Admin Password')).not.toBeInTheDocument();

    expect(row('Half Done').getByText('Exists')).toBeInTheDocument();
    expect(row('Mystery').getByText('Unknown')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Demo Company' }));
    fireEvent.click(demo.getByTitle('View Details'));
    expect(props.onViewDetails).toHaveBeenCalledTimes(2);
    expect(props.onViewDetails).toHaveBeenCalledWith('t-demo');
  });

  it('provisions a database and shows the generated admin credentials', async () => {
    vi.mocked(provisionTenant).mockResolvedValue({ success: true, adminEmail: 'a@p', adminPassword: 'Secr3t!' });
    useAdminStore.setState({ tenants: [makeTenant({ id: 'p', name: 'Pending Co', status: 'pending', database_status: { exists: false, accessible: false } })] });
    render(<TenantList {...props} />);
    await click(row('Pending Co').getByTitle('Provision Database'));
    expect(confirmSpy).toHaveBeenCalledWith('This will create the database for this tenant. Continue?');
    expect(provisionTenant).toHaveBeenCalledWith('p');
    expect(props.onShowCredentials).toHaveBeenCalledWith('Database Provisioned!', 'a@p', 'Secr3t!');
    expect(props.onRefresh).toHaveBeenCalled();
  });

  it('does nothing when an action is not confirmed', async () => {
    confirmSpy.mockReturnValue(false);
    useAdminStore.setState({ tenants: [makeTenant({ status: 'pending', database_status: undefined })] });
    render(<TenantList {...props} />);
    await click(row('Demo Company').getByTitle('Provision Database'));
    expect(provisionTenant).not.toHaveBeenCalled();
  });

  it('shows a failed provision in place', async () => {
    vi.mocked(provisionTenant).mockRejectedValue(new Error('PG down'));
    useAdminStore.setState({ tenants: [makeTenant({ database_status: undefined })] });
    render(<TenantList {...props} />);
    await click(row('Demo Company').getByTitle('Provision Database'));
    expect(screen.getByRole('alert')).toHaveTextContent('PG down');
    expect(props.onRefresh).not.toHaveBeenCalled();
  });

  it('resets the tenant admin password', async () => {
    vi.mocked(resetTenantAdminPassword).mockResolvedValue({ email: 'admin@demo.local', password: 'n3w' });
    useAdminStore.setState({ tenants: [makeTenant()] });
    render(<TenantList {...props} />);
    await click(row('Demo Company').getByTitle('Reset Admin Password'));
    expect(resetTenantAdminPassword).toHaveBeenCalledWith('t-demo');
    expect(props.onShowCredentials).toHaveBeenCalledWith('Password Reset!', 'admin@demo.local', 'n3w');

    vi.mocked(resetTenantAdminPassword).mockRejectedValue('x');
    await click(row('Demo Company').getByTitle('Reset Admin Password'));
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown error');
  });

  it('suspends an active tenant and activates a suspended one', async () => {
    useAdminStore.setState({ tenants: [makeTenant(), makeTenant({ id: 's', name: 'Paused', status: 'suspended' })] });
    render(<TenantList {...props} />);
    await click(row('Demo Company').getByTitle('Suspend'));
    expect(confirmSpy).toHaveBeenCalledWith('Change tenant status to suspended?');
    expect(updateTenantStatus).toHaveBeenCalledWith('t-demo', 'suspended');
    await click(row('Paused').getByTitle('Activate'));
    expect(updateTenantStatus).toHaveBeenLastCalledWith('s', 'active');
    expect(props.onRefresh).toHaveBeenCalledTimes(2);

    vi.mocked(updateTenantStatus).mockRejectedValue(new Error('nope'));
    await click(row('Paused').getByTitle('Activate'));
    expect(screen.getByRole('alert')).toHaveTextContent('nope');
  });

  it('refuses to delete an active tenant', async () => {
    useAdminStore.setState({ tenants: [makeTenant()] });
    render(<TenantList {...props} />);
    await click(row('Demo Company').getByTitle('Delete Tenant'));
    expect(screen.getByRole('alert')).toHaveTextContent('You must suspend the tenant before deleting it');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(deleteTenant).not.toHaveBeenCalled();
  });

  it('deletes a suspended tenant together with its database', async () => {
    useAdminStore.setState({
      tenants: [
        makeTenant({ status: 'suspended' }),
        makeTenant({ id: 'x', name: 'No DB', status: 'pending', database_status: { exists: false, accessible: false } }),
      ],
    });
    render(<TenantList {...props} />);
    await click(row('Demo Company').getByTitle('Delete Tenant'));
    expect(confirmSpy).toHaveBeenLastCalledWith(expect.stringContaining('The tenant database and all its data'));
    expect(deleteTenant).toHaveBeenCalledWith('t-demo', true);

    await click(row('No DB').getByTitle('Delete Tenant'));
    expect(confirmSpy).toHaveBeenLastCalledWith(expect.stringContaining('This will remove the tenant record.'));
    expect(deleteTenant).toHaveBeenLastCalledWith('x', true);

    vi.mocked(deleteTenant).mockRejectedValue(new Error('locked'));
    await click(row('No DB').getByTitle('Delete Tenant'));
    expect(screen.getByRole('alert')).toHaveTextContent('locked');
  });

  it('shows a loading marker on the row while an action runs', async () => {
    let finish: (v: { email: string; password: string }) => void = () => {};
    vi.mocked(resetTenantAdminPassword).mockImplementation(() => new Promise((r) => (finish = r)));
    useAdminStore.setState({ tenants: [makeTenant()] });
    render(<TenantList {...props} />);
    await click(row('Demo Company').getByTitle('Reset Admin Password'));
    expect(row('Demo Company').getByText('Loading...')).toBeInTheDocument();
    await act(async () => finish({ email: 'e', password: 'p' }));
    expect(row('Demo Company').queryByText('Loading...')).not.toBeInTheDocument();
  });
});
