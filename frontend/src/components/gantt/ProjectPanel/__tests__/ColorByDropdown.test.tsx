/**
 * ColorByDropdown: radios for "Default", each dropdown project field applying
 * to the site (display order) and "Tags" while the site has tags; writes the
 * current site's colouring (independent of Group by).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ColorByDropdown } from '../ColorByDropdown';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { makeProjectField, makeProjectFieldOption, makeTag } from '@/test/factories';
import type { Site } from '@/types';

// Display order: Project type (sort 0) before Area (sort 1)
const TYPE = makeProjectField({ id: 1, name: 'Project type', options: [makeProjectFieldOption({ id: 11 })] });
const AREA = makeProjectField({
  id: 2,
  name: 'Area',
  field_type: 'multiselect',
  sort_order: 1,
  options: [makeProjectFieldOption({ id: 21 })],
});
const NOTES = makeProjectField({ id: 3, name: 'Notes', field_type: 'number' });
const zurichTag = makeTag({ id: 2, name: 'Zurich', all_sites: false, site_ids: [2] });

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ ganttColorBy: {}, ganttGrouping: {}, collapsedGanttSections: {} });
  useAppStore.setState({
    projectFields: [AREA, NOTES, TYPE],
    tags: [makeTag({ id: 1, name: 'Pilot' }), zurichTag],
    currentSite: { id: 1, name: 'Basel' } as Site,
  });
});

function open() {
  fireEvent.click(screen.getByRole('button', { name: /^Colou?r(ed)? by/ }));
  return screen.getByRole('dialog', { name: 'Colour projects' });
}

function choiceLabels(dialog: HTMLElement) {
  const radiogroup = within(dialog).getByRole('radiogroup', { name: 'Colour projects by' });
  return within(radiogroup)
    .getAllByRole('radio')
    .map((r) => r.closest('label')!.textContent);
}

describe('ColorByDropdown', () => {
  it('renders nothing without a dropdown field or a tag at the site', () => {
    useAppStore.setState({ projectFields: [NOTES], tags: [zurichTag] });
    const { container } = render(<ColorByDropdown />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is disabled without a current site', () => {
    useAppStore.setState({ currentSite: null });
    render(<ColorByDropdown />);
    expect(screen.getByRole('button', { name: 'Colour by' })).toBeDisabled();
  });

  it('offers "Default", one radio per field in field order, then "Tags"', () => {
    render(<ColorByDropdown />);
    const trigger = screen.getByRole('button', { name: 'Colour by' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('title', 'Colour projects by a field or the tags');
    const dialog = open();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByText('Colour by')).toBeInTheDocument();
    expect(choiceLabels(dialog)).toEqual(['Default', 'Project type', 'Area', 'Tags']);
    expect(within(dialog).getByRole('radio', { name: 'Default' })).toBeChecked();
    // No footer controls
    expect(within(dialog).queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers only the fields while the site has no tag, and only "Tags" without a field', () => {
    useAppStore.setState({ tags: [zurichTag] });
    const { unmount } = render(<ColorByDropdown />);
    expect(choiceLabels(open())).toEqual(['Default', 'Project type', 'Area']);
    unmount();

    useAppStore.setState({ projectFields: [NOTES], tags: [makeTag({ id: 1, name: 'Pilot' })] });
    render(<ColorByDropdown />);
    expect(choiceLabels(open())).toEqual(['Default', 'Tags']);
  });

  it('colours the current site by the picked field or the tags and names the trigger after it', () => {
    render(<ColorByDropdown />);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Area' }));
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':1': 2 });
    // Group by untouched
    expect(useViewStore.getState().ganttGrouping).toEqual({});
    // Stays open, now showing the active state
    expect(within(dialog).getByRole('radio', { name: 'Area' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Coloured by Area' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Tags' }));
    expect(useViewStore.getState().ganttColorBy).toEqual({ ':1': 'tags' });
    expect(within(dialog).getByRole('radio', { name: 'Tags' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Coloured by Tags' })).toBeInTheDocument();

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
});
