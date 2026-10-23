/**
 * Settings › Roles › Approvals: one card per approvable action with "The
 * project's manager can approve" and the roles whose holders approve. The
 * admin role is always ticked; a warning shows when only administrators
 * would approve. Each card saves on its own; unsaved input is reported.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { ApprovalPoliciesForm } from '../panels/ApprovalPoliciesForm';
import { makeRole, makeSystemRoles } from '@/test/factories';
import { ApiError } from '@/api/client';
import type { ApprovalPolicy } from '@/types';

const api = vi.hoisted(() => ({
  rolesApi: { getApprovalPolicies: vi.fn(), updateApprovalPolicy: vi.fn() },
}));
vi.mock('@/api', () => api);

const roles = makeSystemRoles(makeRole({ id: 4, name: 'Team lead' }));
const policies: ApprovalPolicy[] = [
  { action: 'assignments.self_create', label: 'Book own time', pm_approves: true, role_ids: [] },
  { action: 'assignments.self_update', label: 'Change own bookings', pm_approves: false, role_ids: [2] },
];

const card = (label: string) => screen.getByRole('region', { name: label });

beforeEach(() => {
  api.rolesApi.getApprovalPolicies.mockReset().mockResolvedValue(policies);
  api.rolesApi.updateApprovalPolicy.mockReset();
});

describe('ApprovalPoliciesForm', () => {
  it('lists one card per approvable action with its current policy', async () => {
    render(<ApprovalPoliciesForm roles={roles} />);
    expect(screen.getByText('Loading approval policies...')).toBeInTheDocument();

    const create = await screen.findByRole('region', { name: 'Book own time' });
    expect(within(create).getByRole('switch', { name: "The project's manager can approve" })).toBeChecked();
    const update = card('Change own bookings');
    expect(within(update).getByRole('switch', { name: "The project's manager can approve" })).not.toBeChecked();
    expect(within(update).getByRole('checkbox', { name: 'Superuser' })).toBeChecked();
    expect(within(update).getByRole('checkbox', { name: 'Team lead' })).not.toBeChecked();
  });

  it('always ticks the admin role, disabled', async () => {
    render(<ApprovalPoliciesForm roles={roles} />);
    const admin = within(await screen.findByRole('region', { name: 'Book own time' })).getByRole('checkbox', {
      name: 'Admin (always)',
    });
    expect(admin).toBeChecked();
    expect(admin).toBeDisabled();
  });

  it('warns when only administrators would approve', async () => {
    render(<ApprovalPoliciesForm roles={roles} />);
    const create = await screen.findByRole('region', { name: 'Book own time' });
    const warning = 'Only administrators can approve these requests.';
    expect(within(create).queryByText(warning)).not.toBeInTheDocument();

    fireEvent.click(within(create).getByRole('switch', { name: "The project's manager can approve" }));
    expect(within(create).getByText(warning)).toBeInTheDocument();

    fireEvent.click(within(create).getByRole('checkbox', { name: 'Team lead' }));
    expect(within(create).queryByText(warning)).not.toBeInTheDocument();
  });

  it('saves one action with its toggle and roles, then reports clean', async () => {
    api.rolesApi.updateApprovalPolicy.mockResolvedValue({ ...policies[0], pm_approves: false, role_ids: [4] });
    const onDirtyChange = vi.fn();
    render(<ApprovalPoliciesForm roles={roles} onDirtyChange={onDirtyChange} />);
    const create = await screen.findByRole('region', { name: 'Book own time' });
    const save = within(create).getByRole('button', { name: 'Save Changes' });
    expect(save).toBeDisabled();

    fireEvent.click(within(create).getByRole('switch', { name: "The project's manager can approve" }));
    fireEvent.click(within(create).getByRole('checkbox', { name: 'Team lead' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(within(card('Change own bookings')).getByRole('button', { name: 'Save Changes' })).toBeDisabled();

    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(api.rolesApi.updateApprovalPolicy).toHaveBeenCalledTimes(1);
    expect(api.rolesApi.updateApprovalPolicy).toHaveBeenCalledWith('assignments.self_create', {
      pm_approves: false,
      role_ids: [4],
    });
    expect(within(create).getByRole('status')).toHaveTextContent('Saved.');
    expect(save).toBeDisabled();
  });

  it('shows a refused save in its card and keeps the input', async () => {
    api.rolesApi.updateApprovalPolicy.mockRejectedValue(new ApiError('Role not found', 404));
    render(<ApprovalPoliciesForm roles={roles} />);
    const update = await screen.findByRole('region', { name: 'Change own bookings' });
    fireEvent.click(within(update).getByRole('checkbox', { name: 'User' }));
    await act(async () => {
      fireEvent.click(within(update).getByRole('button', { name: 'Save Changes' }));
    });
    expect(within(update).getByRole('alert')).toHaveTextContent('Role not found');
    expect(within(update).getByRole('checkbox', { name: 'User' })).toBeChecked();
  });

  it('shows a load failure', async () => {
    api.rolesApi.getApprovalPolicies.mockRejectedValue(new Error('Network down'));
    render(<ApprovalPoliciesForm roles={roles} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
  });
});
