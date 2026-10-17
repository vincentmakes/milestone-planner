/**
 * Admin-portal sign-in: a normal login authenticates; a login flagged
 * `must_change_password` switches to the change-password form without asking
 * for the current password again; the change form validates before calling
 * the API, then authenticates after a short success message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AdminLoginScreen } from '../AdminLoginScreen';
import { useAdminStore } from '@/stores/adminStore';
import { adminLogin, adminLogout, changeAdminPassword } from '@/api';

vi.mock('@/api', () => ({
  adminLogin: vi.fn(),
  adminLogout: vi.fn(),
  changeAdminPassword: vi.fn(),
}));

const admin = { id: 1, email: 'admin@milestone.local', name: 'Admin', role: 'superadmin' as const };
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });

async function signIn(password = 'initial-pw') {
  change('Email', 'admin@milestone.local');
  change('Password', password);
  await press('Sign In');
}

beforeEach(() => {
  useAdminStore.setState({ ...useAdminStore.getInitialState(), isLoading: true });
  vi.mocked(adminLogin).mockReset();
  vi.mocked(adminLogout).mockReset().mockResolvedValue(undefined);
  vi.mocked(changeAdminPassword).mockReset().mockResolvedValue({ success: true });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AdminLoginScreen', () => {
  it('signs in and marks the portal session authenticated', async () => {
    vi.mocked(adminLogin).mockResolvedValue({ success: true, user: admin });
    render(<AdminLoginScreen />);
    // The back link is a ghost Button that navigates to the application root
    const originalLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, assign } });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Back to Application' }));
      expect(assign).toHaveBeenCalledWith('/');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    }
    await signIn();
    expect(adminLogin).toHaveBeenCalledWith('admin@milestone.local', 'initial-pw');
    expect(useAdminStore.getState()).toMatchObject({ isAuthenticated: true, adminUser: admin, isLoading: false });
  });

  it('shows the login error', async () => {
    vi.mocked(adminLogin).mockRejectedValueOnce(new Error('Invalid email or password'));
    render(<AdminLoginScreen />);
    await signIn();
    expect(screen.getByText('Invalid email or password')).toBeInTheDocument();
    vi.mocked(adminLogin).mockRejectedValueOnce('x');
    await press('Sign In');
    expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    expect(useAdminStore.getState().isAuthenticated).toBe(false);
  });

  it('ignores an unsuccessful response without a user', async () => {
    vi.mocked(adminLogin).mockResolvedValue({ success: false } as never);
    render(<AdminLoginScreen />);
    await signIn();
    expect(useAdminStore.getState().isAuthenticated).toBe(false);
    expect(screen.getByRole('heading', { name: 'Admin Portal' })).toBeInTheDocument();
  });

  describe('forced password change after login', () => {
    beforeEach(() => {
      vi.mocked(adminLogin).mockResolvedValue({ success: true, user: admin, must_change_password: true });
    });

    it('reuses the login password as the current password', async () => {
      render(<AdminLoginScreen />);
      await signIn('initial-pw');
      expect(screen.getByRole('heading', { name: 'Change Password' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Current Password')).not.toBeInTheDocument();
      expect(useAdminStore.getState()).toMatchObject({ mustChangePassword: true, isAuthenticated: false });

      vi.useFakeTimers({ shouldAdvanceTime: true });
      change('New Password', 'brand-new-pw');
      change('Confirm Password', 'brand-new-pw');
      await press('Set New Password');
      expect(changeAdminPassword).toHaveBeenCalledWith('initial-pw', 'brand-new-pw');
      expect(screen.getByText('Password changed successfully. Redirecting...')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
      expect(useAdminStore.getState().mustChangePassword).toBe(false);

      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(useAdminStore.getState().isAuthenticated).toBe(true);
    });

    it('validates length and confirmation before calling the API', async () => {
      render(<AdminLoginScreen />);
      await signIn();
      const form = screen.getByRole('button', { name: 'Set New Password' }).closest('form') as HTMLFormElement;
      change('New Password', 'short');
      change('Confirm Password', 'short');
      await act(async () => {
        fireEvent.submit(form);
      });
      expect(screen.getByText('New password must be at least 8 characters')).toBeInTheDocument();

      change('New Password', 'long-enough-1');
      change('Confirm Password', 'long-enough-2');
      await act(async () => {
        fireEvent.submit(form);
      });
      expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
      expect(changeAdminPassword).not.toHaveBeenCalled();
    });

    it('shows the API error when the change is rejected', async () => {
      vi.mocked(changeAdminPassword).mockRejectedValueOnce(new Error('Password reused'));
      render(<AdminLoginScreen />);
      await signIn();
      change('New Password', 'brand-new-pw');
      change('Confirm Password', 'brand-new-pw');
      await press('Set New Password');
      expect(screen.getByText('Password reused')).toBeInTheDocument();

      vi.mocked(changeAdminPassword).mockRejectedValueOnce({});
      await press('Set New Password');
      expect(screen.getByText('Failed to change password')).toBeInTheDocument();
    });

    it('signs out back to the login form even if logout fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(adminLogout).mockRejectedValue(new Error('offline'));
      render(<AdminLoginScreen />);
      await signIn();
      await press('Sign out');
      expect(screen.getByRole('heading', { name: 'Admin Portal' })).toBeInTheDocument();
      expect(useAdminStore.getState()).toMatchObject({ mustChangePassword: false, adminUser: null });
    });
  });

  it('asks for the current password after a reload and requires it', async () => {
    useAdminStore.setState({ mustChangePassword: true });
    render(<AdminLoginScreen />);
    expect(screen.getByLabelText('Current Password')).toBeInTheDocument();
    change('New Password', 'brand-new-pw');
    change('Confirm Password', 'brand-new-pw');
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: 'Set New Password' }).closest('form') as HTMLFormElement);
    });
    expect(screen.getByText('Current password is required')).toBeInTheDocument();
  });

  it('swaps the logo with the theme', async () => {
    localStorage.setItem('milestone_theme', 'light');
    render(<AdminLoginScreen />);
    const logo = screen.getByAltText('Milestone');
    expect(logo).toHaveAttribute('src', '/img/milestone_logo_light_theme.svg');
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    expect(logo).toHaveAttribute('src', '/img/milestone_logo_dark_theme.svg');
    document.documentElement.removeAttribute('data-theme');
  });
});
