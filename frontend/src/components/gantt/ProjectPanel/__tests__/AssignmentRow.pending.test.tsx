/**
 * A staff row whose booking awaits approval: dashed, with the pending badge;
 * a pending change shows the current and the requested allocation, a pending
 * removal says so. Its context menu also opens for a decider who cannot edit
 * the booking (to approve or reject it from there).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AssignmentRow } from '../AssignmentRow';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { makeProject, makeUser } from '@/test/factories';
import type { AssignmentApproval } from '@/types';

vi.mock('@/api/endpoints/roles', () => ({
  rolesApi: { getAll: vi.fn(() => new Promise(() => {})), getApprovalPolicies: vi.fn(() => new Promise(() => {})) },
}));

const approval = (over: Partial<AssignmentApproval> = {}): AssignmentApproval => ({
  request_id: 31,
  action: 'assignments.self_create',
  requester_id: 4,
  requested: { allocation: 60 },
  previous: null,
  created_at: null,
  can_decide: false,
  ...over,
});

function renderRow(props: Partial<React.ComponentProps<typeof AssignmentRow>> = {}) {
  return render(
    <AssignmentRow
      type="phase-staff"
      assignmentId={9}
      projectId={1}
      phaseId={3}
      staffId={4}
      name="Bob Brown"
      allocation={40}
      depth={1}
      {...props}
    />
  );
}

beforeEach(() => {
  useAppStore.setState({
    projects: [makeProject({ id: 1, pm_id: 12 })],
    currentUser: makeUser({ id: 2, role: 'user' }),
    approvalPolicies: [],
    roles: [],
  });
  useUIStore.setState({ contextMenu: { ...useUIStore.getState().contextMenu, visible: false } });
});

describe('AssignmentRow pending bookings', () => {
  it('renders a pending booking dashed with its badge', () => {
    const { container } = renderRow({ approvalStatus: 'pending', approval: approval() });
    expect(container.firstElementChild?.className).toMatch(/pending/);
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('shows the current and the requested allocation of a pending change', () => {
    renderRow({
      type: 'staff',
      approvalStatus: 'approved',
      approval: approval({ action: 'assignments.self_update', previous: { allocation: 40 } }),
    });
    expect(screen.getByText('40% → 60%')).toBeInTheDocument();
    expect(screen.getByText('Change pending')).toBeInTheDocument();
  });

  it('says a removal was requested', () => {
    const { container } = renderRow({
      approvalStatus: 'approved',
      approval: approval({ action: 'assignments.self_remove', requested: null }),
    });
    expect(screen.getByText('Removal requested')).toBeInTheDocument();
    // The row still counts: not dashed like a pending booking.
    expect(container.firstElementChild?.className).not.toMatch(/pending/);
  });

  it('renders an approved row as before', () => {
    const { container } = renderRow({ approvalStatus: 'approved', approval: null });
    expect(container.firstElementChild?.className).not.toMatch(/pending/);
    expect(screen.queryByText('Pending approval')).not.toBeInTheDocument();
  });

  it('opens the context menu for a decider who cannot edit the booking', () => {
    renderRow({ approvalStatus: 'pending', approval: approval({ can_decide: true }) });
    fireEvent.contextMenu(screen.getByText('Bob Brown'));
    expect(useUIStore.getState().contextMenu).toMatchObject({ visible: true, type: 'staffAssignment', targetId: 9 });
  });

  it('keeps the context menu closed for someone who can neither edit nor decide', () => {
    renderRow({ approvalStatus: 'pending', approval: approval() });
    fireEvent.contextMenu(screen.getByText('Bob Brown'));
    expect(useUIStore.getState().contextMenu.visible).toBe(false);
  });
});
