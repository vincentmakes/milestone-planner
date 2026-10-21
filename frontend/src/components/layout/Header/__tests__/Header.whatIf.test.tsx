/**
 * What-If is a Gantt-only sandbox: the header offers the toggle only in the
 * Gantt view, but an active sandbox is never hidden (Apply/Discard stay
 * reachable whatever the view).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Header } from '../Header';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import type { CurrentView } from '@/types';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { resetAllStores } from '@/stores';
import type { HeaderDensity } from '@/hooks/useHeaderDensity';
import { makeUser } from '@/test/factories';

vi.mock('@/api/endpoints/settings', () => ({
  getSetting: vi.fn().mockResolvedValue({ value: null }),
}));
vi.mock('@/components/common/NotificationBell', () => ({
  NotificationBell: () => <div data-testid="bell" />,
}));
vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ offline: false, recentChanges: [] }),
}));
vi.mock('@/components/common/OnlineUsers', () => ({
  OnlineUsers: () => <div data-testid="online-users" />,
}));

let density: HeaderDensity = 'full';
vi.mock('@/hooks/useHeaderDensity', () => ({
  useHeaderDensity: () => density,
}));

const NON_GANTT_VIEWS: CurrentView[] = ['kanban', 'staff', 'equipment', 'crosssite', 'archived'];

const whatIfButton = () => screen.queryByRole('button', { name: /what if/i });
const overflowTrigger = () => screen.queryByRole('button', { name: 'More controls' });

beforeEach(() => {
  resetAllStores();
  useAppStore.setState({ currentUser: makeUser({ id: 1, role: 'admin' }) });
  useViewStore.setState({ currentView: 'gantt' });
});

afterEach(async () => {
  density = 'full';
  if (useWhatIfStore.getState().whatIfMode) {
    await useWhatIfStore.getState().exitWhatIfMode(false);
  }
});

describe('Header What-If toggle', () => {
  it('offers the toggle in the Gantt view', () => {
    render(<Header />);
    expect(whatIfButton()).toBeInTheDocument();
  });

  it.each(NON_GANTT_VIEWS)('hides the toggle in the %s view', (view) => {
    useViewStore.setState({ currentView: view });
    render(<Header />);
    expect(whatIfButton()).not.toBeInTheDocument();
  });

  it('offers the overflow row only on the Gantt at minimal density', () => {
    density = 'minimal';
    const { unmount } = render(<Header />);
    expect(whatIfButton()).not.toBeInTheDocument();
    fireEvent.click(overflowTrigger()!);
    expect(whatIfButton()).toBeInTheDocument();
    unmount();

    useViewStore.setState({ currentView: 'staff' });
    render(<Header />);
    fireEvent.click(overflowTrigger()!);
    expect(whatIfButton()).not.toBeInTheDocument();
  });

  it('keeps an active sandbox reachable off the Gantt', () => {
    useWhatIfStore.getState().enterWhatIfMode([]);
    useViewStore.setState({ currentView: 'kanban' });
    render(<Header />);
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit' })).toBeInTheDocument();
  });

  it('never offers the toggle to a plain user', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 2, role: 'user' }) });
    render(<Header />);
    expect(whatIfButton()).not.toBeInTheDocument();
  });

  it('offers the toggle to any role holding whatif.use', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 3, role: 'planner', permissions: ['projects.view', 'whatif.use'] }) });
    render(<Header />);
    expect(whatIfButton()).toBeInTheDocument();
  });
});
