/**
 * Admin-portal logout lands on the login screen.
 *
 * Logout calls `adminStore.reset()`. AdminApp only checks auth on mount, so a
 * reset that restored `isLoading: true` left the portal on "Loading..." until
 * a hard reload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { AdminApp } from './AdminApp';
import { useAdminStore } from '@/stores/adminStore';

const getAdminMe = vi.fn();
vi.mock('@/api', () => ({
  getAdminMe: (...args: unknown[]) => getAdminMe(...args),
}));

vi.mock('./AdminLoginScreen', () => ({ AdminLoginScreen: () => <div>Admin login</div> }));
vi.mock('./AdminDashboard', () => ({ AdminDashboard: () => <div>Admin dashboard</div> }));

describe('AdminApp logout', () => {
  beforeEach(() => {
    getAdminMe.mockReset().mockResolvedValue({
      user: { id: 1, email: 'admin@milestone.local', role: 'superadmin' },
    });
    useAdminStore.setState({ isLoading: true, isAuthenticated: false, adminUser: null });
  });

  it('leaves the store ready for the login screen after reset()', () => {
    useAdminStore.setState({ isLoading: false, isAuthenticated: true });
    useAdminStore.getState().reset();

    const state = useAdminStore.getState();
    expect(state.isLoading).toBe(false);
    expect(state.isAuthenticated).toBe(false);
    expect(state.adminUser).toBeNull();
  });

  it('shows the login screen, not "Loading...", after logging out', async () => {
    render(<AdminApp />);
    expect(await screen.findByText('Admin dashboard')).toBeInTheDocument();

    // What AdminDashboard.handleLogout does once the logout request settles
    act(() => {
      useAdminStore.getState().reset();
      useAdminStore.getState().setIsAuthenticated(false);
      useAdminStore.getState().setAdminUser(null);
    });

    expect(screen.getByText('Admin login')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });
});
