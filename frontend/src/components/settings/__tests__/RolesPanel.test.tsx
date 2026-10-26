/**
 * Settings › Roles.
 *
 * - Roles tab: every role with a System pill, its user count and an Edit
 *   button; Delete only on custom roles, confirmed before the guard, a 409
 *   shown in a Notice. Edit / Add role open the role form (with the
 *   catalogue), Back returns to the list.
 * - Approvals tab: the approval policies form.
 * - Unsaved input of either form is reported to the hub; leaving the
 *   Approvals tab with unsaved input asks first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { RolesPanel } from '../panels/RolesPanel';
import { useAppStore } from '@/stores/appStore';
import { stubConfirm } from '@/test/confirmDialog';
import { makeRole, makeSystemRoles } from '@/test/factories';
import { makeCatalogue } from '@/test/permissionFixtures';
import { ApiError } from '@/api/client';

const api = vi.hoisted(() => ({
  rolesApi: {
    getPermissions: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getApprovalPolicies: vi.fn(),
    updateApprovalPolicy: vi.fn(),
  },
}));
vi.mock('@/api', () => api);

const roleHooks = vi.hoisted(() => ({ refreshRoles: vi.fn() }));
vi.mock('@/hooks/useRoles', async () => {
  const { useAppStore: store } = await import('@/stores/appStore');
  return { useRoles: () => store((s) => s.roles), refreshRoles: roleHooks.refreshRoles };
});

const lead = makeRole({ id: 4, name: 'Team lead', description: 'Leads a team', user_count: 1 });
const roles = makeSystemRoles(lead);

const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

beforeEach(() => {
  for (const fn of Object.values(api.rolesApi)) fn.mockReset();
  api.rolesApi.getPermissions.mockResolvedValue(makeCatalogue());
  api.rolesApi.getApprovalPolicies.mockResolvedValue([
    { action: 'assignments.self_create', label: 'Book own time', pm_approves: true, role_ids: [] },
  ]);
  roleHooks.refreshRoles.mockReset().mockResolvedValue(undefined);
  useAppStore.setState({ roles });
});

describe('RolesPanel', () => {
  it('lists every role with its user count, System pill and actions', () => {
    render(<RolesPanel />);
    expect(screen.getByText('4 roles')).toBeInTheDocument();

    const admin = rowOf('Admin');
    expect(within(admin).getByText('System')).toBeInTheDocument();
    expect(within(admin).getByText('1 user')).toBeInTheDocument();
    expect(within(admin).getByRole('button', { name: 'Edit Admin' })).toBeInTheDocument();
    expect(within(admin).queryByRole('button', { name: 'Delete Admin' })).not.toBeInTheDocument();
    expect(within(rowOf('User')).getByText('2 users')).toBeInTheDocument();

    const custom = rowOf('Team lead');
    expect(within(custom).queryByText('System')).not.toBeInTheDocument();
    expect(within(custom).getByText('Leads a team')).toBeInTheDocument();
    expect(within(custom).getByRole('button', { name: 'Delete Team lead' })).toBeInTheDocument();
    expect(screen.queryByText('No custom roles yet. Add one above.')).not.toBeInTheDocument();
  });

  it('says when there is no custom role, and while the roles load', () => {
    useAppStore.setState({ roles: makeSystemRoles() });
    const { unmount } = render(<RolesPanel />);
    expect(screen.getByText('No custom roles yet. Add one above.')).toBeInTheDocument();
    unmount();

    useAppStore.setState({ roles: [] });
    render(<RolesPanel />);
    expect(screen.getByText('Loading roles...')).toBeInTheDocument();
  });

  it('opens the role form with the catalogue, and goes back', async () => {
    render(<RolesPanel />);
    fireEvent.click(within(rowOf('Team lead')).getByRole('button', { name: 'Edit Team lead' }));
    expect(screen.getByRole('heading', { name: 'Edit role: Team lead' })).toBeInTheDocument();
    expect(await screen.findByRole('radiogroup', { name: 'Create projects' })).toBeInTheDocument();
    expect(api.rolesApi.getPermissions).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Back to roles' }));
    expect(screen.getByText('4 roles')).toBeInTheDocument();
  });

  it('adds a role through the form', async () => {
    api.rolesApi.create.mockResolvedValue(makeRole({ id: 9, key: 'qa', name: 'QA' }));
    render(<RolesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }));
    expect(screen.getByRole('heading', { name: 'New role' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'QA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(screen.getByText('4 roles')).toBeInTheDocument());
    expect(api.rolesApi.create).toHaveBeenCalledWith(expect.objectContaining({ key: 'qa', name: 'QA' }));
  });

  it('reports the form\'s unsaved input to the hub', async () => {
    const onDirtyChange = vi.fn();
    render(<RolesPanel onDirtyChange={onDirtyChange} />);
    fireEvent.click(within(rowOf('Team lead')).getByRole('button', { name: 'Edit Team lead' }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Lead' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('deletes a custom role after confirming, once', async () => {
    const confirm = stubConfirm(true);
    api.rolesApi.delete.mockResolvedValue(undefined);
    render(<RolesPanel />);
    await act(async () => {
      fireEvent.click(within(rowOf('Team lead')).getByRole('button', { name: 'Delete Team lead' }));
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Delete role "Team lead"? Users holding it must be moved to another role first. This cannot be undone.',
        destructive: true,
      })
    );
    expect(api.rolesApi.delete).toHaveBeenCalledWith(4);
    expect(roleHooks.refreshRoles).toHaveBeenCalled();
  });

  it('keeps the role when the delete is cancelled, and shows a 409 in a Notice', async () => {
    const confirm = stubConfirm(false);
    render(<RolesPanel />);
    const del = within(rowOf('Team lead')).getByRole('button', { name: 'Delete Team lead' });
    await act(async () => {
      fireEvent.click(del);
    });
    expect(api.rolesApi.delete).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    api.rolesApi.delete.mockRejectedValue(new ApiError('1 user holds this role. Give them another role first.', 409));
    await act(async () => {
      fireEvent.click(del);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('1 user holds this role. Give them another role first.');
  });

  it('shows a catalogue load failure', async () => {
    api.rolesApi.getPermissions.mockRejectedValue(new Error('Network down'));
    render(<RolesPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
    // The role form shows it in place of the matrix
    fireEvent.click(within(rowOf('Team lead')).getByRole('button', { name: 'Edit Team lead' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Network down');
    expect(screen.queryByText('Loading permissions...')).not.toBeInTheDocument();
  });

  it('switches to the approval policies, and asks before leaving unsaved ones', async () => {
    const confirm = stubConfirm(false);
    const onDirtyChange = vi.fn();
    render(<RolesPanel onDirtyChange={onDirtyChange} />);
    const tabs = screen.getByRole('tablist', { name: 'Roles and approvals' });
    const rolesTab = within(tabs).getByRole('tab', { name: 'Roles' });
    const approvalsTab = within(tabs).getByRole('tab', { name: 'Approvals' });
    expect(rolesTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(approvalsTab);
    expect(approvalsTab).toHaveAttribute('aria-selected', 'true');
    const card = await screen.findByRole('region', { name: 'Book own time' });
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', approvalsTab.id);

    // Without changes, switching back is immediate
    fireEvent.click(rolesTab);
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByText('4 roles')).toBeInTheDocument();

    fireEvent.click(approvalsTab);
    fireEvent.click(within(await screen.findByRole('region', { name: 'Book own time' })).getByRole('checkbox', { name: 'Team lead' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      fireEvent.click(rolesTab);
    });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Discard your unsaved approval changes?' }));
    expect(approvalsTab).toHaveAttribute('aria-selected', 'true');

    confirm.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(rolesTab);
    });
    expect(rolesTab).toHaveAttribute('aria-selected', 'true');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(card).not.toBeInTheDocument();
  });
});
