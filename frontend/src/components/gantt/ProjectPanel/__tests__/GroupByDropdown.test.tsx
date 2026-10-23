/**
 * GroupByDropdown: radios for "No grouping" + each tag group (display order),
 * writes the current site's grouping, Collapse all / Expand all while
 * grouped, and the TagFilterDropdown close rules (Escape, focus-out).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { GroupByDropdown } from '../GroupByDropdown';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import type { Site } from '@/types';
import type { TagGroup, LegacyGroupedTag } from '@/utils/tags';

function tag(id: number, name: string, groupId: number): LegacyGroupedTag {
  return { id, name, color: '#10b981', group_id: groupId, all_sites: true, site_ids: [], sort_order: 0 };
}

// Display order: Project type (sort 0) before Area (sort 1)
const AREA: TagGroup = { id: 2, name: 'Area', single_select: false, sort_order: 1 };
const TYPE: TagGroup = { id: 1, name: 'Project type', single_select: true, sort_order: 0 };

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ ganttGrouping: {}, collapsedGanttSections: {} });
  useAppStore.setState({
    tags: [tag(1, 'Internal', 1), tag(2, 'Customer', 1), tag(3, 'Bio', 2)],
    tagGroups: [AREA, TYPE],
    currentSite: { id: 1, name: 'Basel' } as Site,
  });
});

function open() {
  fireEvent.click(screen.getByRole('button', { name: /^Group(ed)? by/ }));
  return screen.getByRole('dialog', { name: 'Group projects' });
}

describe('GroupByDropdown', () => {
  it('renders nothing when there are no tag groups', () => {
    useAppStore.setState({ tagGroups: [] });
    const { container } = render(<GroupByDropdown />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers "No grouping" and one radio per tag group, in group order', () => {
    render(<GroupByDropdown />);
    const trigger = screen.getByRole('button', { name: 'Group by' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const dialog = open();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const radios = within(within(dialog).getByRole('radiogroup')).getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')!.textContent)).toEqual(['No grouping', 'Project type', 'Area']);
    expect(radios[0]).toBeChecked();
    // No collapse controls while not grouped
    expect(within(dialog).queryByRole('button', { name: 'Collapse all' })).not.toBeInTheDocument();
  });

  it('groups the current site by the picked group and names the trigger after it', () => {
    render(<GroupByDropdown />);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Area' }));
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':1': 2 });
    // Stays open, now showing the active state
    expect(within(dialog).getByRole('radio', { name: 'Area' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Grouped by Area' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'No grouping' }));
    expect(useViewStore.getState().ganttGrouping).toEqual({});
    expect(screen.getByRole('button', { name: 'Group by' })).toBeInTheDocument();
  });

  it('collapses all sections of the group and expands them again', () => {
    useViewStore.setState({ ganttGrouping: { ':1': 1 } });
    render(<GroupByDropdown />);
    const dialog = open();
    const expandAll = within(dialog).getByRole('button', { name: 'Expand all' });
    expect(expandAll).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Collapse all' }));
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':1': ['tag-2', 'tag-1', 'none'] });
    expect(expandAll).toBeEnabled();

    fireEvent.click(expandAll);
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('closes on Escape without letting it reach the app shortcuts, and returns focus', () => {
    render(<GroupByDropdown />);
    const dialog = open();
    let reachedDocument = false;
    const listener = () => { reachedDocument = true; };
    document.addEventListener('keydown', listener);
    try {
      fireEvent.keyDown(within(dialog).getByRole('radio', { name: 'Area' }), { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', listener);
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(reachedDocument).toBe(false);
    expect(screen.getByRole('button', { name: 'Group by' })).toHaveFocus();
  });

  it('closes when focus leaves it, and on an outside mousedown', () => {
    render(
      <>
        <GroupByDropdown />
        <button type="button">Elsewhere</button>
      </>
    );
    const dialog = open();
    fireEvent.blur(within(dialog).getByRole('radio', { name: 'Area' }), {
      relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }),
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    open();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
