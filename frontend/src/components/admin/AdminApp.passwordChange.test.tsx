/**
 * Forced admin-portal password change survives a reload.
 *
 * The backend answers 403 on every admin route except /auth/me,
 * /auth/change-password and /auth/logout while `must_change_password` is set,
 * so a reload must land on the change-password screen, not the dashboard.
 * Only the login flow knows the current password, so after a reload the
 * screen has to ask for it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AdminApp } from './AdminApp';
import { useAdminStore } from '@/stores/adminStore';

const getAdminMe = vi.fn();
const changeAdminPassword = vi.fn();
const adminLogout = vi.fn();
vi.mock('@/api', () => ({
  getAdminMe: (...args: unknown[]) => getAdminMe(...args),
  changeAdminPassword: (...args: unknown[]) => changeAdminPassword(...args),
  adminLogout: (...args: unknown[]) => adminLogout(...args),
  adminLogin: vi.fn(),
}));

vi.mock('./AdminDashboard', () => ({ AdminDashboard: () => <div>Admin dashboard</div> }));

const admin = { id: 1, email: 'admin@milestone.local', name: 'Admin', role: 'superadmin' };

describe('AdminApp forced password change after reload', () => {
  beforeEach(() => {
    getAdminMe.mockReset().mockResolvedValue({ user: admin, must_change_password: true });
    changeAdminPassword.mockReset().mockResolvedValue({ success: true });
    adminLogout.mockReset().mockResolvedValue(undefined);
    useAdminStore.setState({
      isLoading: true,
      isAuthenticated: false,
      adminUser: null,
      mustChangePassword: false,
    });
  });

  it('shows the change-password screen (with a current-password field), not the dashboard', async () => {
    render(<AdminApp />);

    expect(await screen.findByText('Change Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Current Password')).toBeInTheDocument();
    expect(screen.queryByText('Admin dashboard')).not.toBeInTheDocument();
    expect(useAdminStore.getState().isAuthenticated).toBe(false);
    expect(useAdminStore.getState().mustChangePassword).toBe(true);
  });

  it('goes straight to the dashboard when no change is required', async () => {
    getAdminMe.mockResolvedValue({ user: admin, must_change_password: false });
    render(<AdminApp />);
    expect(await screen.findByText('Admin dashboard')).toBeInTheDocument();
  });

  it('sends the typed current password and then opens the dashboard', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<AdminApp />);
      fireEvent.change(await screen.findByLabelText('Current Password'), {
        target: { value: 'old-secret' },
      });
      fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'new-secret-1' } });
      fireEvent.change(screen.getByLabelText('Confirm Password'), {
        target: { value: 'new-secret-1' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Set New Password' }));

      await waitFor(() =>
        expect(changeAdminPassword).toHaveBeenCalledWith('old-secret', 'new-secret-1'),
      );
      expect(await screen.findByText(/Password changed successfully/)).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(1600);
      });
      expect(await screen.findByText('Admin dashboard')).toBeInTheDocument();
      expect(useAdminStore.getState().mustChangePassword).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers a way out: Sign out ends the session and shows the sign-in form', async () => {
    render(<AdminApp />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(adminLogout).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Admin Portal')).toBeInTheDocument();
    expect(useAdminStore.getState().mustChangePassword).toBe(false);
    expect(useAdminStore.getState().adminUser).toBeNull();
  });
});
