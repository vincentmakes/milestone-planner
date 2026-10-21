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
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { CROSS_SITE_DISABLED_REASON } from '@/hooks/useAllowedViews';
import { makeSite, makeUser } from '@/test/factories';

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
});
