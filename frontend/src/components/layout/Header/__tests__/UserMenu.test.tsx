/**
 * The profile menu's version line.
 *
 * The point of the feature is that opening the menu tells you what the server
 * is running *now* — so the two properties worth pinning are that the request
 * is deferred until the menu opens, and that it repeats on each open rather
 * than caching a number that would go stale in a long-lived tab.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UserMenu } from '../UserMenu';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { getAppVersion } from '@/api/endpoints/health';
import { logout } from '@/api/endpoints/auth';

vi.mock('@/api/endpoints/auth', () => ({
  logout: vi.fn().mockResolvedValue(undefined),
  login: vi.fn(),
  checkAuth: vi.fn().mockResolvedValue({ user: null }),
}));
vi.mock('@/api/endpoints/health', () => ({
  getAppVersion: vi.fn().mockResolvedValue('1.2.0'),
}));

const trigger = () => screen.getByRole('button', { expanded: false });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAppVersion).mockResolvedValue('1.2.0');
  useAppStore.setState({
    isAuthChecking: false,
    isAuthenticated: true,
    currentUser: {
      id: 1,
      name: 'Alice Anderson',
      email: 'alice@demo.local',
      first_name: 'Alice',
      last_name: 'Anderson',
      role: 'admin',
    } as never,
  });
});

describe('UserMenu version', () => {
  it('does not ask the server until the menu is opened', () => {
    render(<UserMenu />);
    expect(getAppVersion).not.toHaveBeenCalled();
  });

  it('shows the running version once the menu is open', async () => {
    render(<UserMenu />);
    fireEvent.click(trigger());
    expect(await screen.findByText('v1.2.0')).toBeInTheDocument();
  });

  it('re-asks on each open, so an upgraded instance shows through', async () => {
    render(<UserMenu />);
    const button = screen.getByRole('button');

    fireEvent.click(button);
    expect(await screen.findByText('v1.2.0')).toBeInTheDocument();

    // The instance is upgraded while the tab stays open.
    vi.mocked(getAppVersion).mockResolvedValue('1.3.0');
    fireEvent.click(button); // close
    fireEvent.click(button); // reopen

    expect(await screen.findByText('v1.3.0')).toBeInTheDocument();
    expect(getAppVersion).toHaveBeenCalledTimes(2);
  });

  it('renders no version line when the server cannot be reached', async () => {
    vi.mocked(getAppVersion).mockResolvedValue(null);
    render(<UserMenu />);
    fireEvent.click(trigger());

    // The rest of the menu must still work — a missing version is not a failure.
    await waitFor(() => expect(getAppVersion).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Log out')).toBeInTheDocument();
    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
  });
});

describe('UserMenu My absences', () => {
  it('opens the My absences dialog and closes the menu', async () => {
    useUIStore.setState({ activeModal: null });
    render(<UserMenu />);
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByText('My absences'));

    expect(useUIStore.getState().activeModal).toBe('myAbsences');
    expect(screen.queryByText('Log out')).not.toBeInTheDocument();
  });
});

describe('UserMenu Log out', () => {
  it('logs out through useAuth: session destroyed, every store reset, no reload', async () => {
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload },
    });
    useUndoStore.setState({ undoStack: [{} as never] } as never);

    try {
      render(<UserMenu />);
      fireEvent.click(trigger());
      fireEvent.click(await screen.findByText('Log out'));

      await waitFor(() => expect(useAppStore.getState().isAuthenticated).toBe(false));
      expect(logout).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().currentUser).toBeNull();
      expect(useAppStore.getState().isAuthChecking).toBe(false);
      expect(useUndoStore.getState().undoStack).toHaveLength(0);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    }
  });
});
