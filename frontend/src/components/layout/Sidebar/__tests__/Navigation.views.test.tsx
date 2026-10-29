/**
 * Navigation lists the views the user's keys allow (useAllowedViews): a view
 * without its `views.*` key is hidden, Cross-site is hidden while only one
 * site is visible, and What-If blocks every view but the Gantt with its hint.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Navigation } from '../Navigation';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { resetAllStores } from '@/stores';
import { useWorkStore } from '@/stores/workStore';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { makeApprovalRequest, makeSite, makeUser } from '@/test/factories';

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

  it('hides Cross-site, not disables it, when one site is visible', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [2] }) });
    render(<Navigation />);
    expect(button('Cross-Site')).not.toBeInTheDocument();
    // The other views stay enabled, without a tooltip while expanded
    const staff = button('Staff Overview')!;
    expect(staff).toBeEnabled();
    expect(staff).not.toHaveAttribute('title');
  });

  it('enables Cross-site with two visible sites', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [1, 2] }) });
    render(<Navigation />);
    fireEvent.click(button('Cross-Site')!);
    expect(useViewStore.getState().currentView).toBe('crosssite');
  });

  it('shows the What-If hint on Cross-site while What-If is active', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'admin', site_ids: [1, 2] }) });
    useWhatIfStore.getState().enterWhatIfMode([]);
    render(<Navigation />);
    expect(button('Cross-Site')).toBeDisabled();
    expect(button('Cross-Site')).toHaveAttribute('title', whatIfUnavailableMessage('Switching views'));
  });

  it('titles every entry with its label while collapsed', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [1, 2] }) });
    render(<Navigation collapsed />);
    expect(button('Cross-Site')).toHaveAttribute('title', 'Cross-Site');
  });

  it('lists My Work right after the Kanban board, even without any view key', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'viewer', permissions: ['projects.view'] }) });
    render(<Navigation />);
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Gantt Chart', 'My Work']);
    fireEvent.click(button('My Work')!);
    expect(useViewStore.getState().currentView).toBe('work');
  });

  it('places My Work after Kanban, with the work icon', () => {
    useAppStore.setState({ currentUser: makeUser({ role: 'user', site_ids: [1, 2] }) });
    render(<Navigation />);
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels.slice(0, 3)).toEqual(['Gantt Chart', 'Kanban Board', 'My Work']);
    expect(button('My Work')!.querySelector('[data-testid="AssignmentIndOutlinedIcon"]')).not.toBeNull();
  });

  it('badges My Work with the approvals to decide, in its accessible name', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user' }) });
    useWorkStore.getState().setToDecide([makeApprovalRequest({ id: 1 }), makeApprovalRequest({ id: 2 })]);
    // My own requests are not counted.
    useWorkStore.getState().setMine([makeApprovalRequest({ id: 3 })]);
    render(<Navigation />);
    const work = screen.getByRole('button', { name: 'My Work, 2 approvals to decide' });
    expect(work).toHaveTextContent('2');
  });

  it('caps the badge and shows it collapsed, without one when nothing is open', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user' }) });
    useWorkStore.getState().setToDecide([makeApprovalRequest({ id: 1 })]);
    const { rerender } = render(<Navigation collapsed />);
    expect(screen.getByRole('button', { name: 'My Work, 1 approval to decide' })).toHaveTextContent('1');
    useWorkStore
      .getState()
      .setToDecide(Array.from({ length: 120 }, (_, i) => makeApprovalRequest({ id: i + 1 })));
    rerender(<Navigation collapsed />);
    expect(screen.getByRole('button', { name: 'My Work, 120 approvals to decide' })).toHaveTextContent('99+');
    useWorkStore.getState().setToDecide([]);
    rerender(<Navigation collapsed />);
    expect(screen.getByRole('button', { name: 'My Work' })).toHaveTextContent('');
  });
});
