/**
 * The header's responsive contract.
 *
 * Header widths are budgeted (see hooks/useHeaderDensity.ts). These tests hold
 * the two properties that budget is supposed to guarantee: every control
 * renders exactly once at any width, and no control ever becomes unreachable —
 * it moves into the overflow menu instead of disappearing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { Header } from '../Header';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import type { HeaderDensity } from '@/hooks/useHeaderDensity';

// Network and presence are not what is under test here.
vi.mock('@/api/endpoints/settings', () => ({
  getSetting: vi.fn().mockResolvedValue({ value: null }),
}));
vi.mock('@/components/common/NotificationBell', () => ({
  NotificationBell: () => <div data-testid="bell" />,
}));
vi.mock('@/components/common/OnlineUsers', () => ({
  OnlineUsers: ({ maxVisible }: { maxVisible?: number }) => (
    <div data-testid="online-users" data-max-visible={maxVisible} />
  ),
}));

let density: HeaderDensity = 'full';
vi.mock('@/hooks/useHeaderDensity', () => ({
  useHeaderDensity: () => density,
}));

const TIERS: HeaderDensity[] = ['full', 'compact', 'condensed', 'minimal'];

/** Controls that must be reachable in every tier, however they are reached. */
const ALWAYS_REACHABLE = ['Zoom in', 'Zoom out', 'Undo', 'Redo'];

function renderAt(tier: HeaderDensity) {
  density = tier;
  return render(<Header />);
}

const overflowTrigger = () => screen.queryByRole('button', { name: 'More controls' });

beforeEach(() => {
  useAppStore.setState({ currentUser: { id: 1, role: 'admin' } as never });
  useViewStore.setState({ currentView: 'gantt' });
});

afterEach(() => {
  density = 'full';
});

describe('Header density', () => {
  it.each(TIERS)('exposes the tier to CSS at %s', (tier) => {
    const { container } = renderAt(tier);
    expect(container.querySelector('header')).toHaveAttribute('data-density', tier);
  });

  it.each(TIERS)('renders each control exactly once at %s', (tier) => {
    renderAt(tier);
    // Open the menu once: with it open, every control is in the DOM at the
    // same time, which is exactly when a duplicate would show up. A CSS-only
    // approach — rendering both copies and hiding one — fails here.
    if (overflowTrigger()) fireEvent.click(overflowTrigger()!);
    for (const name of ALWAYS_REACHABLE) {
      expect(screen.getAllByRole('button', { name })).toHaveLength(1);
    }
  });

  it.each(TIERS)('leaves no control unreachable at %s', (tier) => {
    renderAt(tier);
    for (const name of ALWAYS_REACHABLE) {
      if (!screen.queryByRole('button', { name })) {
        expect(overflowTrigger()).toBeInTheDocument();
        fireEvent.click(overflowTrigger()!);
      }
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('keeps the bar intact and shows no overflow menu at full width', () => {
    renderAt('full');
    expect(overflowTrigger()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
  });

  it('moves zoom and history out of the bar at condensed', () => {
    renderAt('condensed');
    expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    // View modes have no keyboard shortcut, so they stay a tier longer.
    expect(screen.getByRole('button', { name: /week view/i })).toBeInTheDocument();
  });

  it('moves the view switcher out only at minimal', () => {
    renderAt('minimal');
    expect(screen.queryByRole('button', { name: /week view/i })).not.toBeInTheDocument();
    fireEvent.click(overflowTrigger()!);
    expect(screen.getByRole('button', { name: /week view/i })).toBeInTheDocument();
  });

  it('stays open while the zoom buttons inside it are used', () => {
    // The reason this is not the shared ContextMenu, which closes on every
    // item click: zooming is press-plus-three-times.
    renderAt('minimal');
    fireEvent.click(overflowTrigger()!);
    const panel = screen.getByRole('group', { name: 'More controls' });
    const zoomIn = within(panel).getByRole('button', { name: 'Zoom in' });

    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);

    expect(screen.getByRole('group', { name: 'More controls' })).toBeInTheDocument();
    expect(useViewStore.getState().cellWidth).toBeGreaterThan(36);
  });

  it('closes the overflow menu on Escape and on an outside click', () => {
    renderAt('minimal');
    fireEvent.click(overflowTrigger()!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'More controls' })).not.toBeInTheDocument();

    fireEvent.click(overflowTrigger()!);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('group', { name: 'More controls' })).not.toBeInTheDocument();
  });

  it('shows fewer avatars as the bar tightens', () => {
    const seen = TIERS.map((tier) => {
      const { unmount } = renderAt(tier);
      const value = screen.getByTestId('online-users').getAttribute('data-max-visible');
      unmount();
      return Number(value);
    });
    expect(seen).toEqual([3, 3, 2, 1]);
  });

  it('drops the wordmark only at minimal, and never a tenant logo', () => {
    const { unmount } = renderAt('condensed');
    expect(screen.getByAltText('Milestone')).toHaveAttribute(
      'src',
      expect.stringContaining('milestone_logo')
    );
    expect(screen.getByAltText('Milestone').getAttribute('src')).not.toContain('no_text');
    unmount();

    renderAt('minimal');
    expect(screen.getByAltText('Milestone').getAttribute('src')).toContain('no_text');
  });

  it('shows no overflow menu on the Kanban board, which has no timeline controls', () => {
    // condensed demotes only zoom and history; the board has neither, so the
    // menu would otherwise render empty.
    useViewStore.setState({ currentView: 'kanban' });
    renderAt('condensed');
    expect(overflowTrigger()).not.toBeInTheDocument();
  });
});
