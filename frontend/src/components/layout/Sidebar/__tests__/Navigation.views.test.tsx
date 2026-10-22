/**
 * Navigation lists the views the user's keys allow (useAllowedViews): a view
 * without its `views.*` key is hidden, Cross-site is disabled with its reason
 * while only one site is visible, and the What-If hint wins over that reason.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Navigation } from '../Navigation';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { resetAllStores } from '@/stores';
import { useTodoStore } from '@/stores/todoStore';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { CROSS_SITE_DISABLED_REASON } from '@/hooks/useAllowedViews';
import { makeApprovalRequest, makeSite, makeTodo, makeUser } from '@/test/factories';

const twoSites = [makeSite({ id: 1 }), makeSite({ id: 2, name: 'Zurich' })];

beforeEach(() => {
  resetAllStores();
  useViewStore.getState().resetView();
  useAppStore.setState({ sites: twoSites });
});

afterEach(async () => {
  if (useWhatIfStore.getState().whatIfMode) await useWhatIfStore.getState().exitWhatIfMode(false);
});

const button = (name: string) => screen.queryByRole('button', { name });

describe('Navigation views', () => {
  it('hides the views whose key the role lacks', () => {
    useAppStore.setState({
      currentUser: makeUser({ role: 'viewer', permissions: ['projects.view', 'views.kanban'], site_ids: [1, 2] }),
    });
    render(<Navigation />);
    expect(button('Gantt Chart')).toBeInTheDocument();
    expect(button('Kanban Board')).toBeInTheDocument();
    for (const label of ['Staff Overview', 'Equipment', 'Cross-Site', 'Archived']) {
      expect(button(label)).not.toBeInTheDocument();
    }
  });

  it('draws the Equipment view with a wrench, not the Settings cog', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'admin', site_ids: [1, 2] }) });
    render(<Navigation />);
    const equipment = button('Equipment')!;
    expect(equipment.querySelector('[data-testid="BuildOutlinedIcon"]')).not.toBeNull();
    expect(equipment.querySelector('[data-testid="SettingsOutlinedIcon"]')).toBeNull();
  });

  it('disables Cross-site with the reason when one site is visible', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [2] }) });
    render(<Navigation />);
    const crossSite = button('Cross-Site')!;
    expect(crossSite).toBeDisabled();
    expect(crossSite).toHaveAttribute('title', CROSS_SITE_DISABLED_REASON);
    fireEvent.click(crossSite);
    expect(useViewStore.getState().currentView).toBe('gantt');
  });

  it('enables Cross-site with two visible sites', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [1, 2] }) });
    render(<Navigation />);
    fireEvent.click(button('Cross-Site')!);
    expect(useViewStore.getState().currentView).toBe('crosssite');
  });

  it('shows the What-If hint over the Cross-site reason', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'admin', site_ids: [1] }), sites: [twoSites[0]] });
    useWhatIfStore.getState().enterWhatIfMode([]);
    render(<Navigation />);
    expect(button('Cross-Site')).toHaveAttribute('title', whatIfUnavailableMessage('Switching views'));
  });

  it('lists My Todos right after the Kanban board, even without any view key', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'viewer', permissions: ['projects.view'] }) });
    render(<Navigation />);
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Gantt Chart', 'My Todos']);
    fireEvent.click(button('My Todos')!);
    expect(useViewStore.getState().currentView).toBe('todos');
  });

  it('places My Todos after Kanban', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [1, 2] }) });
    render(<Navigation />);
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels.slice(0, 3)).toEqual(['Gantt Chart', 'Kanban Board', 'My Todos']);
  });

  it('badges My Todos with the open count, in its accessible name', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user' }) });
    useTodoStore.getState().setTasks([makeTodo({ id: 1 }), makeTodo({ id: 2 })]);
    useTodoStore.getState().setToDecide([makeApprovalRequest()]);
    render(<Navigation />);
    const todos = screen.getByRole('button', { name: 'My Todos, 3 open items' });
    expect(todos).toHaveTextContent('3');
  });

  it('caps the badge and shows it collapsed, without one when nothing is open', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user' }) });
    useTodoStore.getState().setTasks(Array.from({ length: 120 }, (_, i) => makeTodo({ id: i + 1 })));
    const { rerender } = render(<Navigation collapsed />);
    expect(screen.getByRole('button', { name: 'My Todos, 120 open items' })).toHaveTextContent('99+');
    useTodoStore.getState().setTasks([]);
    rerender(<Navigation collapsed />);
    expect(screen.getByRole('button', { name: 'My Todos' })).toHaveTextContent('');
  });
});
