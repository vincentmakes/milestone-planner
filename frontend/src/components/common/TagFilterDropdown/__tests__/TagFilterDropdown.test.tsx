import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TagFilterDropdown } from '../TagFilterDropdown';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import type { Site, Tag, TagGroup } from '@/types';

function tag(id: number, name: string, extra: Partial<Tag> = {}): Tag {
  return { id, name, color: '#10b981', group_id: null, all_sites: true, site_ids: [], sort_order: 0, ...extra };
}

const TYPE: TagGroup = { id: 1, name: 'Project type', single_select: true, sort_order: 0 };
const tags: Tag[] = [
  tag(1, 'Internal', { group_id: 1 }),
  tag(2, 'Customer', { group_id: 1 }),
  tag(3, 'Pilot'),
  tag(4, 'Zurich only', { all_sites: false, site_ids: [2] }),
];

function setSite(id: number) {
  useAppStore.setState({ currentSite: { id, name: `Site ${id}` } as Site });
}

function openDropdown() {
  fireEvent.click(screen.getByRole('button', { name: /^Tags/ }));
}

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ tagFilters: {} });
  useAppStore.setState({ tags, tagGroups: [TYPE] });
  setSite(1);
});

describe('TagFilterDropdown', () => {
  it('renders one section per group with "(No tag)", ungrouped tags under Other', () => {
    render(<TagFilterDropdown />);
    const trigger = screen.getByRole('button', { name: 'Tags' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    openDropdown();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const sections = screen.getAllByRole('group');
    expect(sections.map((g) => g.getAttribute('aria-label'))).toEqual(['Project type', 'Other']);
    expect(within(sections[0]).getByLabelText('(No tag) in Project type')).toBeInTheDocument();
    expect(within(sections[0]).getByLabelText('Internal')).toBeInTheDocument();
    expect(within(sections[1]).getByLabelText('Pilot')).toBeInTheDocument();
    // Tags of other sites are not offered
    expect(screen.queryByLabelText('Zurich only')).not.toBeInTheDocument();
  });

  it('writes the filter for the current site only and shows a count', () => {
    render(<TagFilterDropdown />);
    openDropdown();
    fireEvent.click(screen.getByLabelText('Internal'));
    fireEvent.click(screen.getByLabelText('(No tag) in Project type'));
    expect(useViewStore.getState().tagFilters).toEqual({ ':1': { tagIds: [1], noneGroupIds: [1] } });
    expect(screen.getByRole('button', { name: 'Tags (2 selected)' })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Internal'));
    expect(useViewStore.getState().tagFilters).toEqual({ ':1': { tagIds: [], noneGroupIds: [1] } });
  });

  it('keeps separate filters per site', () => {
    useViewStore.setState({ tagFilters: { ':2': { tagIds: [4], noneGroupIds: [] } } });
    const { rerender } = render(<TagFilterDropdown />);
    expect(screen.getByRole('button', { name: 'Tags' })).toBeInTheDocument();

    setSite(2);
    rerender(<TagFilterDropdown />);
    expect(screen.getByRole('button', { name: 'Tags (1 selected)' })).toBeInTheDocument();
    openDropdown();
    expect(screen.getByLabelText('Zurich only')).toBeChecked();
  });

  it('Clear removes the site filter', () => {
    useViewStore.setState({ tagFilters: { ':1': { tagIds: [3], noneGroupIds: [] }, ':2': { tagIds: [4], noneGroupIds: [] } } });
    render(<TagFilterDropdown />);
    openDropdown();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(useViewStore.getState().tagFilters).toEqual({ ':2': { tagIds: [4], noneGroupIds: [] } });
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('ignores stale ids in the stored filter', () => {
    useViewStore.setState({ tagFilters: { ':1': { tagIds: [999, 4], noneGroupIds: [77] } } });
    render(<TagFilterDropdown />);
    expect(screen.getByRole('button', { name: 'Tags' })).toBeInTheDocument();
    openDropdown();
    fireEvent.click(screen.getByLabelText('Pilot'));
    expect(useViewStore.getState().tagFilters).toEqual({ ':1': { tagIds: [3], noneGroupIds: [] } });
  });

  it('shows an empty state when the site has no tags', () => {
    useAppStore.setState({ tags: [tag(4, 'Zurich only', { all_sites: false, site_ids: [2] })] });
    render(<TagFilterDropdown />);
    openDropdown();
    expect(screen.getByText('No tags for this site')).toBeInTheDocument();
  });

  it('Escape closes the dropdown without reaching other key handlers', () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    render(<TagFilterDropdown />);
    openDropdown();
    expect(screen.getByText('Filter by tag')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText('Pilot'), { key: 'Escape' });
    expect(screen.queryByText('Filter by tag')).not.toBeInTheDocument();
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Tags' })).toHaveFocus();
    document.removeEventListener('keydown', outer);
  });

  it('closes on an outside mousedown', () => {
    render(
      <div>
        <TagFilterDropdown />
        <p>outside</p>
      </div>
    );
    openDropdown();
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByText('Filter by tag')).not.toBeInTheDocument();
  });

  it('announces a dialog of checkboxes and points at it while open', () => {
    render(<TagFilterDropdown />);
    const trigger = screen.getByRole('button', { name: 'Tags' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).not.toHaveAttribute('aria-controls');
    openDropdown();
    const panel = screen.getByRole('dialog', { name: 'Filter by tag' });
    expect(trigger).toHaveAttribute('aria-controls', panel.id);
  });

  it('closes when focus leaves the wrapper (Tab out), not when it moves inside', () => {
    render(
      <div>
        <TagFilterDropdown />
        <button type="button">next</button>
      </div>
    );
    openDropdown();
    const pilot = screen.getByLabelText('Pilot');
    fireEvent.blur(screen.getByLabelText('Internal'), { relatedTarget: pilot });
    expect(screen.getByText('Filter by tag')).toBeInTheDocument();
    // Focus dropping to the body (mousedown on option text) keeps it open too.
    fireEvent.blur(pilot, { relatedTarget: null });
    expect(screen.getByText('Filter by tag')).toBeInTheDocument();

    fireEvent.blur(pilot, { relatedTarget: screen.getByRole('button', { name: 'next' }) });
    expect(screen.queryByText('Filter by tag')).not.toBeInTheDocument();
  });

  it('drops a "(No tag)" selection whose group no longer shows at this site', () => {
    // Every tag of "Project type" re-scoped to site 2: the group has no
    // checkbox at site 1, so its "(No tag)" must not count as selected.
    useAppStore.setState({
      tags: [
        tag(1, 'Internal', { group_id: 1, all_sites: false, site_ids: [2] }),
        tag(3, 'Pilot'),
      ],
    });
    useViewStore.setState({ tagFilters: { ':1': { tagIds: [], noneGroupIds: [1] } } });
    render(<TagFilterDropdown />);
    expect(screen.getByRole('button', { name: 'Tags' })).toBeInTheDocument();
    openDropdown();
    expect(screen.queryByText('Project type')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('compact mode hides the visible label but keeps the accessible name', () => {
    render(<TagFilterDropdown compact />);
    const trigger = screen.getByRole('button', { name: 'Tags' });
    expect(trigger.textContent).toBe('');
  });
});
