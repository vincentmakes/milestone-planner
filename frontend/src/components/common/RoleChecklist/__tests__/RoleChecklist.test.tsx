/**
 * RoleChecklist: a labelled group with one native checkbox per role (inside
 * its label, for the touch target). The admin role may always approve, so it
 * is listed ticked and disabled with "(always)" and never reported in the
 * selection.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RoleChecklist } from '@/components/common';
import { makeRole, makeSystemRoles } from '@/test/factories';

const roles = makeSystemRoles(makeRole({ id: 4, name: 'Team lead' }));

describe('RoleChecklist', () => {
  it('renders one labelled checkbox per role inside a named group', () => {
    render(<RoleChecklist roles={roles} selected={[2]} onChange={() => {}} label="Roles that can approve" />);
    const group = screen.getByRole('group', { name: 'Roles that can approve' });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    expect(within(group).getByRole('checkbox', { name: 'Superuser' })).toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'User' })).not.toBeChecked();
    expect(boxes[1].closest('label')).toHaveTextContent('Superuser');
  });

  it('lists the admin role ticked and disabled, always', () => {
    render(<RoleChecklist roles={roles} selected={[]} onChange={() => {}} label="Roles" />);
    const admin = screen.getByRole('checkbox', { name: 'Admin (always)' });
    expect(admin).toBeChecked();
    expect(admin).toBeDisabled();
  });

  it('adds and removes ids on toggle, never the admin role', () => {
    const onChange = vi.fn();
    render(<RoleChecklist roles={roles} selected={[2]} onChange={onChange} label="Roles" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Team lead' }));
    expect(onChange).toHaveBeenLastCalledWith([2, 4]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Superuser' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Admin (always)' }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('disables every checkbox', () => {
    render(<RoleChecklist roles={roles} selected={[]} onChange={() => {}} label="Roles" disabled />);
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
  });

  it('shows the empty text when there is no role', () => {
    render(<RoleChecklist roles={[]} selected={[]} onChange={() => {}} label="Roles" emptyText="Loading roles..." />);
    expect(screen.getByRole('group', { name: 'Roles' })).toHaveTextContent('Loading roles...');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
