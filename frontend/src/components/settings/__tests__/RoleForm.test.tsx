/**
 * Settings › Roles › role form.
 *
 * - The admin role is read-only: every row Allow, nothing editable, an info
 *   Notice explains why, and there is no Save.
 * - "Needs approval" exists only on approvable keys; locked rows are greyed.
 * - Saving sends the name, description and whole matrix; a new role gets a
 *   key derived from its name. Errors (duplicate name, 422) show in a Notice.
 * - Unsaved input is reported to the hub and Back asks before discarding.
 * - Delete (custom roles only) confirms first; a 409 shows in the Notice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { RoleForm } from '../panels/RoleForm';
import { stubConfirm } from '@/test/confirmDialog';
import { makeRole, makeSystemRoles } from '@/test/factories';
import { makeCatalogue } from '@/test/permissionFixtures';
import { ApiError } from '@/api/client';
import type { Role } from '@/types';

const api = vi.hoisted(() => ({
  rolesApi: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/api', () => api);

const roleHooks = vi.hoisted(() => ({ refreshRoles: vi.fn() }));
vi.mock('@/hooks/useRoles', () => roleHooks);

const catalogue = makeCatalogue();
const [adminRole, superuserRole] = makeSystemRoles();
const lead = makeRole({
  id: 4,
  name: 'Team lead',
  description: 'Leads a team',
  permissions: { 'projects.view': 'allow', 'assignments.self_create': 'approval' },
});

function renderForm(role: Role | null, extra: Partial<Parameters<typeof RoleForm>[0]> = {}) {
  const props = {
    role,
    catalogue,
    existingKeys: ['admin', 'superuser', 'user', 'team_lead'],
    onBack: vi.fn(),
    onSaved: vi.fn(),
    onDeleted: vi.fn(),
    onDirtyChange: vi.fn(),
    ...extra,
  };
  render(<RoleForm {...props} />);
  return props;
}

const group = (label: string) => screen.getByRole('radiogroup', { name: label });
const pick = (label: string, chip: string) => fireEvent.click(within(group(label)).getByRole('radio', { name: chip }));
const checked = (label: string) =>
  within(group(label)).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')?.textContent;

beforeEach(() => {
  for (const fn of Object.values(api.rolesApi)) fn.mockReset();
  roleHooks.refreshRoles.mockReset().mockResolvedValue(undefined);
});

describe('RoleForm', () => {
  it('shows the admin role read-only, every permission allowed', () => {
    const props = renderForm(adminRole);
    expect(screen.getByRole('status')).toHaveTextContent('The admin role always holds every permission.');
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(checked('Manage roles')).toBe('Allow');
    expect(checked('Create projects')).toBe('Allow');
    expect(screen.getByLabelText('Name *')).toBeDisabled();
    expect(screen.getByLabelText('Description')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete role' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to roles' }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it('shows the role key read-only and keeps system roles undeletable', () => {
    renderForm(superuserRole);
    expect(screen.getByText('Key: superuser (cannot change)')).toBeInTheDocument();
    expect(screen.getByLabelText('Name *')).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Delete role' })).not.toBeInTheDocument();
  });

  it('offers "Needs approval" only on approvable keys and greys out locked ones', () => {
    renderForm(lead);
    expect(within(group('Book own time')).getByRole('radio', { name: 'Needs approval' })).toBeInTheDocument();
    expect(within(group('Create projects')).queryByRole('radio', { name: 'Needs approval' })).not.toBeInTheDocument();
    for (const radio of within(group('View projects')).getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(group('Manage roles').closest('[data-locked]')).toHaveAttribute('data-locked', 'true');
    expect(within(group('Create projects')).getByRole('radio', { name: 'Allow' })).toBeEnabled();
  });

  it('saves the name, description and the whole matrix', async () => {
    api.rolesApi.update.mockResolvedValue(lead);
    const props = renderForm(lead);

    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: '  Lead ' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } });
    pick('Create projects', 'Allow');
    pick('Book own time', 'Allow');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    expect(api.rolesApi.update).toHaveBeenCalledWith(4, {
      name: 'Lead',
      description: null,
      permissions: { 'projects.view': 'allow', 'projects.create': 'allow', 'assignments.self_create': 'allow' },
    });
    expect(roleHooks.refreshRoles).toHaveBeenCalled();
  });

  it('creates a new role with a key derived from its name', async () => {
    api.rolesApi.create.mockResolvedValue(makeRole({ id: 9, key: 'team_lead_2' }));
    const props = renderForm(null);

    expect(screen.getByRole('heading', { name: 'New role' })).toBeInTheDocument();
    expect(checked('View projects')).toBe('Allow');
    expect(checked('Create projects')).toBe('Deny');
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Team lead' } });
    expect(screen.getByText('Key: team_lead_2 (cannot change later)')).toBeInTheDocument();
    pick('Book own time', 'Needs approval');
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    expect(api.rolesApi.create).toHaveBeenCalledWith({
      key: 'team_lead_2',
      name: 'Team lead',
      description: null,
      permissions: { 'projects.view': 'allow', 'assignments.self_create': 'approval' },
    });
  });

  it('requires a name', async () => {
    renderForm(null);
    fireEvent.submit(screen.getByLabelText('Name *').closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Role name is required');
    expect(api.rolesApi.create).not.toHaveBeenCalled();
  });

  it('shows a refused save in the Notice and saves once on a double click', async () => {
    let reject!: (e: Error) => void;
    api.rolesApi.update.mockImplementation(() => new Promise((_, r) => (reject = r)));
    const props = renderForm(lead);
    pick('Create projects', 'Allow');
    const save = screen.getByRole('button', { name: 'Save Changes' });
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    expect(api.rolesApi.update).toHaveBeenCalledTimes(1);
    expect(save).toHaveAttribute('aria-busy', 'true');

    await act(async () => reject(new ApiError('A role named "User" already exists', 400)));
    expect(screen.getByRole('alert')).toHaveTextContent('A role named "User" already exists');
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it('reports unsaved input and asks before going back', async () => {
    const confirm = stubConfirm(false);
    const props = renderForm(lead);
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);

    // Back without changes leaves at once
    fireEvent.click(screen.getByRole('button', { name: 'Back to roles' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(props.onBack).toHaveBeenCalledTimes(1);

    pick('Create projects', 'Allow');
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Discard your unsaved changes to this role?' }));
    expect(props.onBack).toHaveBeenCalledTimes(1);

    confirm.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Back to roles' }));
    });
    expect(props.onBack).toHaveBeenCalledTimes(2);

    // Setting the chip back clears the flag
    pick('Create projects', 'Deny');
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('deletes a custom role after confirming', async () => {
    const confirm = stubConfirm(true);
    api.rolesApi.delete.mockResolvedValue(undefined);
    const props = renderForm(lead);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete role' }));
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Delete role "Team lead"? Users holding it must be moved to another role first. This cannot be undone.',
        destructive: true,
      })
    );
    expect(api.rolesApi.delete).toHaveBeenCalledWith(4);
    expect(props.onDeleted).toHaveBeenCalled();
  });

  it('keeps the role when the delete is cancelled, and shows a 409', async () => {
    const confirm = stubConfirm(false);
    renderForm(lead);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete role' }));
    });
    expect(api.rolesApi.delete).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    api.rolesApi.delete.mockRejectedValue(new ApiError('2 users hold this role. Give them another role first.', 409));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete role' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('2 users hold this role. Give them another role first.');
  });

  it('waits for the catalogue', () => {
    renderForm(lead, { catalogue: null });
    expect(screen.getByText('Loading permissions...')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });
});
