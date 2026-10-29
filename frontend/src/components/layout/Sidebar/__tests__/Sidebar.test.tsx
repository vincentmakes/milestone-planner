/**
 * Sidebar: view navigation (viewStore.currentView), collapse toggle, the
 * Settings entry for admins/superusers only, and the site-scoped quick stats.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Sidebar } from '../Sidebar';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { resetAllStores } from '@/stores';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { makeEquipment, makeProject, makeSite, makeStaff, makeTeam, makeUser } from '@/test/factories';
import { tagFilterKey } from '@/utils/tags';

beforeEach(() => {
  resetAllStores();
  useViewStore.getState().resetView();
});

afterEach(async () => {
  if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
});

/** The value next to a label in the Quick Stats section ("Equipment" is also a nav item). */
function stat(label: string) {
  const section = within(screen.getByText('Quick Stats').parentElement as HTMLElement);
  return within(section.getByText(label).parentElement as HTMLElement);
}

describe('Sidebar', () => {
  it('lists every view and switches to the clicked one', async () => {
    useAppStore.setState({
      currentUser: makeUser({ role: 'user', site_ids: [1, 2] }),
      sites: [makeSite({ id: 1 }), makeSite({ id: 2, name: 'Zurich' })],
    });
    render(<Sidebar />);
    for (const label of ['Gantt Chart', 'Kanban Board', 'Staff Overview', 'Equipment', 'Cross-Site', 'Archived']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(useViewStore.getState().currentView).toBe('archived');
    fireEvent.click(screen.getByRole('button', { name: 'Kanban Board' }));
    expect(useViewStore.getState().currentView).toBe('kanban');
  });

  it('hides the admin section from regular users', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user' }) });
    render(<Sidebar />);
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('opens the settings hub for superusers', async () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'superuser' }) });
    render(<Sidebar />);
    expect(screen.getByText('Admin')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useUIStore.getState().activeModal).toBe('settingsHub');
  });

  it('collapses to icons only, keeping accessible names', async () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'admin' }) });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(useViewStore.getState().sidebarCollapsed).toBe(true);
    expect(screen.queryByText('Views')).not.toBeInTheDocument();
    expect(screen.queryByText('Quick Stats')).not.toBeInTheDocument();
    expect(screen.getByTitle('Gantt Chart')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('title', 'Settings');
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(useViewStore.getState().sidebarCollapsed).toBe(false);
  });

  it('blocks switching views and opening Settings while What-If is active', async () => {
    useAppStore.setState({
      currentUser: makeUser({ role: 'admin' }),
      sites: [makeSite({ id: 1 }), makeSite({ id: 2, name: 'Zurich' })],
    });
    useViewStore.setState({ currentView: 'gantt' });
    useWhatIfStore.getState().enterWhatIfMode([]);
    const { rerender } = render(<Sidebar />);

    const switchHint = whatIfUnavailableMessage('Switching views');
    for (const label of ['Kanban Board', 'Staff Overview', 'Equipment', 'Cross-Site', 'Archived']) {
      const button = screen.getByRole('button', { name: label });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', switchHint);
    }
    const gantt = screen.getByRole('button', { name: 'Gantt Chart' });
    expect(gantt).toBeEnabled();
    expect(gantt).not.toHaveAttribute('title');

    fireEvent.click(screen.getByRole('button', { name: 'Kanban Board' }));
    expect(useViewStore.getState().currentView).toBe('gantt');

    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(settings).toBeDisabled();
    expect(settings).toHaveAttribute('title', whatIfUnavailableMessage('Opening Settings'));
    fireEvent.click(settings);
    expect(useUIStore.getState().activeModal).toBeNull();

    await useWhatIfStore.getState().exitWhatIfMode(false);
    rerender(<Sidebar />);
    expect(screen.getByRole('button', { name: 'Kanban Board' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Kanban Board' }));
    expect(useViewStore.getState().currentView).toBe('kanban');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useUIStore.getState().activeModal).toBe('settingsHub');
  });

  it('keeps the What-If hint over the collapsed tooltip', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'admin' }) });
    useViewStore.setState({ currentView: 'gantt', sidebarCollapsed: true });
    useWhatIfStore.getState().enterWhatIfMode([]);
    render(<Sidebar />);
    expect(screen.getByRole('button', { name: 'Archived' })).toHaveAttribute(
      'title',
      whatIfUnavailableMessage('Switching views')
    );
    expect(screen.getByRole('button', { name: 'Gantt Chart' })).toHaveAttribute('title', 'Gantt Chart');
  });

  it('counts active projects, staff and equipment of the current site', () => {
    useAppStore.setState({
      currentUser: makeUser({ role: 'user' }),
      currentSite: makeSite({ id: 1 }),
      projects: [
        makeProject({ id: 1, site_id: 1, confirmed: true }),
        makeProject({ id: 2, site_id: 1, confirmed: false }),
        makeProject({ id: 3, site_id: 1, archived: true }),
        makeProject({ id: 4, site_id: 2 }),
      ],
      staff: [
        makeStaff({ id: 1, site_id: 1 }),
        makeStaff({ id: 2, site_id: 1, active: false }),
        makeStaff({ id: 3, site_id: 2 }),
      ],
      equipment: [makeEquipment({ id: 1, site_id: 1 }), makeEquipment({ id: 2, site_id: 2 })],
    });
    render(<Sidebar />);
    expect(stat('Projects').getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1 confirmed, 1 pending')).toBeInTheDocument();
    expect(stat('Staff').getByText('1')).toBeInTheDocument();
    expect(stat('Equipment').getByText('1')).toBeInTheDocument();
  });

  it('counts across sites without a current site, each equipment once', () => {
    useAppStore.setState({
      currentUser: makeUser({ role: 'user' }),
      projects: [makeProject({ id: 1, site_id: 1 }), makeProject({ id: 2, site_id: 2 })],
      staff: [makeStaff({ id: 1, site_id: 1 }), makeStaff({ id: 3, site_id: 2 })],
      equipment: [
        makeEquipment({ id: 1, site_id: 1 }),
        makeEquipment({ id: 1, site_id: 2 }),
        makeEquipment({ id: 2, site_id: 2, active: false }),
      ],
    });
    render(<Sidebar />);
    expect(stat('Projects').getByText('2')).toBeInTheDocument();
    expect(stat('Staff').getByText('2')).toBeInTheDocument();
    expect(stat('Equipment').getByText('1')).toBeInTheDocument();
  });

  it('with an active team filter, counts only matching projects, staff and equipment', () => {
    useAppStore.setState({
      currentUser: makeUser({ role: 'user' }),
      currentSite: makeSite({ id: 1 }),
      teams: [makeTeam({ id: 1, site_id: 1 }), makeTeam({ id: 2, site_id: 1, name: 'Process' })],
      projects: [
        makeProject({ id: 1, site_id: 1, confirmed: true, team_ids: [1] }),
        makeProject({ id: 2, site_id: 1, confirmed: false, team_ids: [2] }),
        makeProject({ id: 3, site_id: 1, confirmed: false, team_ids: [] }),
      ],
      staff: [
        makeStaff({ id: 1, site_id: 1, team_ids: [1] }),
        makeStaff({ id: 2, site_id: 1, team_ids: [2] }),
      ],
      equipment: [
        makeEquipment({ id: 1, site_id: 1, team_ids: [] }),
        makeEquipment({ id: 2, site_id: 1, team_ids: [1] }),
        makeEquipment({ id: 3, site_id: 1, team_ids: [2] }),
      ],
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
    render(<Sidebar />);
    expect(stat('Projects').getByText('1')).toBeInTheDocument();
    expect(screen.getByText('1 confirmed, 0 pending')).toBeInTheDocument();
    expect(stat('Staff').getByText('1')).toBeInTheDocument();
    // Whole-site equipment plus the team's own
    expect(stat('Equipment').getByText('2')).toBeInTheDocument();
  });
});
