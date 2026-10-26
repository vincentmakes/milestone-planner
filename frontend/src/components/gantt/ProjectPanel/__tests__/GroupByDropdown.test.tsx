/**
 * GroupByDropdown: radios for "No grouping" + each dropdown project field
 * applying to the site (display order), writes the current site's grouping,
 * Collapse all / Expand all while grouped, and the shared close rules.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { GroupByDropdown } from '../GroupByDropdown';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { makeProjectField, makeProjectFieldOption, makeTag } from '@/test/factories';
import type { Site } from '@/types';

// Display order: Project type (sort 0) before Area (sort 1); Notes is text,
// Zurich has no item at site 1.
const TYPE = makeProjectField({
  id: 1,
  name: 'Project type',
  options: [makeProjectFieldOption({ id: 11, name: 'Internal' }), makeProjectFieldOption({ id: 12, name: 'Customer' })],
});
const AREA = makeProjectField({
  id: 2,
  name: 'Area',
  field_type: 'multiselect',
  sort_order: 1,
  options: [makeProjectFieldOption({ id: 21, name: 'Bio' })],
});
const NOTES = makeProjectField({ id: 3, name: 'Notes', field_type: 'text' });
const ZURICH = makeProjectField({
  id: 4,
  name: 'Zurich',
  options: [makeProjectFieldOption({ id: 41, all_sites: false, site_ids: [2] })],
});

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ ganttGrouping: {}, collapsedGanttSections: {} });
  useAppStore.setState({
    projectFields: [AREA, NOTES, ZURICH, TYPE],
    tags: [makeTag({ id: 1 })],
    currentSite: { id: 1, name: 'Basel' } as Site,
  });
});

function open() {
  fireEvent.click(screen.getByRole('button', { name: /^Group(ed)? by/ }));
  return screen.getByRole('dialog', { name: 'Group projects' });
}

describe('GroupByDropdown', () => {
  it('renders nothing when no dropdown field applies to the site (tags do not count)', () => {
    useAppStore.setState({ projectFields: [NOTES, ZURICH] });
    const { container } = render(<GroupByDropdown />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers "No grouping" and one radio per field, in field order', () => {
    render(<GroupByDropdown />);
    const trigger = screen.getByRole('button', { name: 'Group by' });
    expect(trigger).toHaveAttribute('title', 'Group projects by a field');
    const dialog = open();

    const radiogroup = within(dialog).getByRole('radiogroup', { name: 'Group projects by a field' });
    const radios = within(radiogroup).getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')!.textContent)).toEqual(['No grouping', 'Project type', 'Area']);
    expect(radios[0]).toBeChecked();
    // No collapse controls while not grouped
    expect(within(dialog).queryByRole('button', { name: 'Collapse all' })).not.toBeInTheDocument();
  });

  it('groups the current site by the picked field and names the trigger after it', () => {
    render(<GroupByDropdown />);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Area' }));
    expect(useViewStore.getState().ganttGrouping).toEqual({ ':1': 2 });
    // Stays open, now showing the active state
    expect(within(dialog).getByRole('radio', { name: 'Area' })).toBeChecked();
    const trigger = screen.getByRole('button', { name: 'Grouped by Area' });
    expect(trigger).toHaveAttribute('title', 'Grouped by Area');

    fireEvent.click(within(dialog).getByRole('radio', { name: 'No grouping' }));
    expect(useViewStore.getState().ganttGrouping).toEqual({});
    expect(screen.getByRole('button', { name: 'Group by' })).toBeInTheDocument();
  });

  it('collapses all sections of the field and expands them again', () => {
    useViewStore.setState({ ganttGrouping: { ':1': 1 } });
    render(<GroupByDropdown />);
    const dialog = open();
    const expandAll = within(dialog).getByRole('button', { name: 'Expand all' });
    expect(expandAll).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Collapse all' }));
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':1': ['field-11', 'field-12', 'none'] });
    expect(expandAll).toBeEnabled();

    fireEvent.click(expandAll);
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('is disabled without a current site', () => {
    useAppStore.setState({ currentSite: null });
    render(<GroupByDropdown />);
    // No site: no field applies except all-sites ones, still listed but disabled
    expect(screen.getByRole('button', { name: 'Group by' })).toBeDisabled();
  });
});
