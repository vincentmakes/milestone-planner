/**
 * The pill on a booking awaiting approval: what is pending (the booking, a
 * change, a removal) and, in its tooltip, who decides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PendingBadge } from '../PendingBadge';
import { useAppStore } from '@/stores/appStore';
import { makeProject, makeRole, makeSystemRoles } from '@/test/factories';
import type { AssignmentApproval } from '@/types';

vi.mock('@/api/endpoints/roles', () => ({
  rolesApi: { getAll: vi.fn(() => new Promise(() => {})), getApprovalPolicies: vi.fn(() => new Promise(() => {})) },
}));

const approval = (action: string): AssignmentApproval => ({
  request_id: 31,
  action,
  requester_id: 4,
  requested: null,
  previous: null,
  created_at: null,
  can_decide: false,
});

beforeEach(() => {
  useAppStore.setState({
    approvalPolicies: [
      { action: 'assignments.self_create', label: 'Book own time', pm_approves: true, role_ids: [4] },
    ],
    roles: makeSystemRoles(makeRole({ id: 4, name: 'Team lead' })),
    projects: [makeProject({ id: 1, pm_id: 12, pm_name: 'Fiona Fischer' })],
  });
});

describe('PendingBadge', () => {
  it('labels a pending booking and names its approvers', () => {
    render(<PendingBadge assignment={{ approval_status: 'pending', approval: approval('assignments.self_create') }} projectId={1} />);
    const badge = screen.getByText('Pending approval');
    expect(badge).toHaveAttribute(
      'title',
      'Awaiting approval by Fiona Fischer (project manager), Team lead or an administrator'
    );
  });

  it('labels a pending change and a pending removal', () => {
    const { rerender } = render(
      <PendingBadge assignment={{ approval_status: 'approved', approval: approval('assignments.self_update') }} projectId={1} />
    );
    expect(screen.getByText('Change pending')).toBeInTheDocument();
    rerender(<PendingBadge assignment={{ approval_status: 'approved', approval: approval('assignments.self_remove') }} projectId={1} />);
    expect(screen.getByText('Removal requested')).toBeInTheDocument();
  });

  it('treats a pending row without request details as a pending booking', () => {
    render(<PendingBadge assignment={{ approval_status: 'pending', approval: null }} projectId={1} />);
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
  });

  it('renders nothing for an approved row with no open request', () => {
    const { container } = render(<PendingBadge assignment={{ approval_status: 'approved', approval: null }} projectId={1} />);
    expect(container).toBeEmptyDOMElement();
  });
});
