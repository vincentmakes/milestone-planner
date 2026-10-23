/**
 * ColorByDropdown: radios for "Default" + each tag group (display order),
 * writes the current site's colouring (independent of Group by), and the
 * shared close rules (Escape, focus-out, outside mousedown).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ColorByDropdown } from '../ColorByDropdown';
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
  useViewStore.setState({ ganttColorBy: {}, ganttGrouping: {}, collapsedGanttSections: {} });
  useAppStore.setState({
    tags: [tag(1, 'Internal', 1), tag(2, 'Customer', 1), tag(3, 'Bio', 2)],
    tagGroups: [AREA, TYPE],
    currentSite: { id: 1, name: 'Basel' } as Site,
  });
});

function open() {
  fireEvent.click(screen.getByRole('button', { name: /^Colou?r(ed)? by/ }));
  return screen.getByRole('dialog', { name: 'Colour projects' });
}

describe('ColorByDropdown', () => {
  it('renders nothing when there are no tag groups', () => {
    useAppStore.setState({ tagGroups: [] });
    const { container } = render(<ColorByDropdown />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is disabled without a current site', () => {
    useAppStore.setState({ currentSite: null });
    render(<ColorByDropdown />);
    expect(screen.getByRole('button', { name: 'Colour by' })).toBeDisabled();
  });

  it('offers "Default" and one radio per tag group, in group order', () => {
    render(<ColorByDropdown />);
    const trigger = screen.getByRole('button', { name: 'Colour by' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const dialog = open();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByText('Colour by')).toBeInTheDocument();

    const radiogroup = within(dialog).getByRole('radiogroup', { name: 'Colour projects by tag group' });
    const radios = within(radiogroup).getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')!.textContent)).toEqual(['Default', 'Project type', 'Area']);
    expect(radios[0]).toBeChecked();
    // No footer controls
    expect(within(dialog).queryByRole('button')).not.toBeInTheDocument();
  });

  it('colours the current site by the picked group and names the trigger after it', () => {
    render(<ColorByDropdown />);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Area' }));
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':1': 2 });
    // Group by untouched
    expect(useViewStore.getState().ganttGrouping).toEqual({});
    // Stays open, now showing the active state
    expect(within(dialog).getByRole('radio', { name: 'Area' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Coloured by Area' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Default' }));
    expect(useViewStore.getState().ganttColorBy).toEqual({});
    expect(screen.getByRole('button', { name: 'Colour by' })).toBeInTheDocument();
  });

  it('shows a stored colouring as checked', () => {
    useViewStore.setState({ ganttColorBy: { ':1': 1 } });
    render(<ColorByDropdown />);
    const dialog = open();
    expect(within(dialog).getByRole('radio', { name: 'Project type' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Coloured by Project type' })).toBeInTheDocument();
  });

  it('closes on Escape without letting it reach the app shortcuts, and returns focus', () => {
    render(<ColorByDropdown />);
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
    expect(screen.getByRole('button', { name: 'Colour by' })).toHaveFocus();
  });

  it('closes when focus leaves it, and on an outside mousedown', () => {
    render(
      <>
        <ColorByDropdown />
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
