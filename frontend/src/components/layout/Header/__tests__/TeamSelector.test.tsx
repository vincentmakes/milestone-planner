/**
 * TeamSelector: the header's per-site team filter. Hidden on a site without
 * active teams; every write is pruned against the site's active teams and
 * lands under the tenant + site key; it dismisses like every dropdown.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TeamSelector } from '../TeamSelector';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { tagFilterKey } from '@/utils/tags';
import { makeTeam } from '@/test/factories';
import type { Site } from '@/types';

const teams = [
  makeTeam({ id: 1, site_id: 1, name: 'Analytics', color: '#3b82f6' }),
  makeTeam({ id: 2, site_id: 1, name: 'Process', color: '#10b981' }),
  makeTeam({ id: 3, site_id: 2, name: 'Zurich lab' }),
  makeTeam({ id: 4, site_id: 3, name: 'Dormant', active: false }),
];

function setSite(id: number) {
  useAppStore.setState({ currentSite: { id, name: `Site ${id}` } as Site });
}

const trigger = () => screen.getByRole('button', { name: /^Team filter:/ });
const panel = () => screen.queryByRole('dialog', { name: 'Filter by team' });
const open = () => fireEvent.click(trigger());
const stored = (siteId = 1) => useViewStore.getState().teamFilters[tagFilterKey(siteId)];

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ teamFilters: {} });
  useAppStore.setState({ teams });
  setSite(1);
});

describe('TeamSelector', () => {
  it('renders nothing on a site without active teams', () => {
    setSite(3); // only an inactive team
    const { container } = render(<TeamSelector />);
    expect(container).toBeEmptyDOMElement();

    act(() => useAppStore.setState({ currentSite: null }));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows "Whole site" and opens a dialog of the site\'s teams', () => {
    render(<TeamSelector />);
    expect(trigger()).toHaveAccessibleName('Team filter: Whole site');
    expect(trigger()).toHaveTextContent('Whole site');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    open();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', panel()!.id);
    expect(screen.getByRole('group', { name: 'Teams' })).toBeInTheDocument();
    expect(screen.getByLabelText('Whole site')).toBeChecked();
    expect(screen.getByLabelText('Analytics')).not.toBeChecked();
    expect(screen.getByLabelText('Process')).toBeInTheDocument();
    expect(screen.getByLabelText('(No team)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Zurich lab')).not.toBeInTheDocument();
    // Nothing to clear yet.
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('writes the ticked teams for the current site and labels the trigger', () => {
    render(<TeamSelector />);
    open();
    fireEvent.click(screen.getByLabelText('Analytics'));
    expect(stored()).toEqual({ teamIds: [1], noTeam: false });
    expect(trigger()).toHaveAccessibleName('Team filter: Analytics');
    expect(trigger().className).toMatch(/active/);
    expect(screen.getByLabelText('Whole site')).not.toBeChecked();

    fireEvent.click(screen.getByLabelText('Process'));
    expect(trigger()).toHaveTextContent('2 teams');

    fireEvent.click(screen.getByLabelText('Analytics'));
    fireEvent.click(screen.getByLabelText('Process'));
    expect(stored()).toBeUndefined();

    fireEvent.click(screen.getByLabelText('(No team)'));
    expect(stored()).toEqual({ teamIds: [], noTeam: true });
    expect(trigger()).toHaveTextContent('No team');
  });

  it('clears the entry through "Whole site" and through Clear', () => {
    render(<TeamSelector />);
    open();
    fireEvent.click(screen.getByLabelText('Analytics'));
    fireEvent.click(screen.getByLabelText('Whole site'));
    expect(stored()).toBeUndefined();
    expect(trigger()).toHaveAccessibleName('Team filter: Whole site');
    expect(trigger().className).not.toMatch(/active/);

    fireEvent.click(screen.getByLabelText('(No team)'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(stored()).toBeUndefined();
  });

  it('closes on Escape with focus back on the trigger, and on an outside mousedown', () => {
    render(<TeamSelector />);
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();

    open();
    fireEvent.mouseDown(document.body);
    expect(panel()).not.toBeInTheDocument();
  });

  it('prunes the id of a deleted team on the next write', () => {
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1, 99], noTeam: false } } });
    render(<TeamSelector />);
    expect(trigger()).toHaveAccessibleName('Team filter: Analytics');
    open();
    fireEvent.click(screen.getByLabelText('Process'));
    expect(stored()).toEqual({ teamIds: [1, 2], noTeam: false });
  });

  it("shows the stored selection of the site that becomes current", () => {
    useViewStore.setState({
      teamFilters: {
        [tagFilterKey(1)]: { teamIds: [2], noTeam: false },
        [tagFilterKey(2)]: { teamIds: [3], noTeam: true },
      },
    });
    render(<TeamSelector />);
    expect(trigger()).toHaveAccessibleName('Team filter: Process');

    act(() => setSite(2));
    expect(trigger()).toHaveAccessibleName('Team filter: Zurich lab + no team');
    open();
    expect(screen.getByLabelText('Zurich lab')).toBeChecked();
    expect(screen.queryByLabelText('Analytics')).not.toBeInTheDocument();
  });
});
