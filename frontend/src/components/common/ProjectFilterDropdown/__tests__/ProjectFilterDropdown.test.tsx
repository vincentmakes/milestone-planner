import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ProjectFilterDropdown } from '../ProjectFilterDropdown';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { makeProjectField, makeProjectFieldOption, makeTag, makeTeam } from '@/test/factories';
import type { Site } from '@/types';

// Project type (select): Internal (10) / Customer (11)
// Area (multiselect, after Project type): Bio (20), only at site 2
// Notes (text): never offered
const TYPE = makeProjectField({
  id: 1,
  name: 'Project type',
  field_type: 'select',
  options: [
    makeProjectFieldOption({ id: 10, name: 'Internal', color: '#10b981' }),
    makeProjectFieldOption({ id: 11, name: 'Customer', color: '#f59e0b' }),
  ],
});
const AREA = makeProjectField({
  id: 2,
  name: 'Area',
  field_type: 'multiselect',
  sort_order: 1,
  options: [makeProjectFieldOption({ id: 20, name: 'Bio', all_sites: false, site_ids: [2] })],
});
const NOTES = makeProjectField({ id: 3, name: 'Notes', field_type: 'text' });
const tags = [
  makeTag({ id: 31, name: 'Urgent', sort_order: 1 }),
  makeTag({ id: 30, name: 'Pilot', sort_order: 0 }),
  makeTag({ id: 32, name: 'Zurich only', all_sites: false, site_ids: [2] }),
];

const empty = { optionIds: [], noneFieldIds: [], tagIds: [] };

function setSite(id: number) {
  useAppStore.setState({ currentSite: { id, name: `Site ${id}` } as Site });
}

function openDropdown() {
  fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
}

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({ projectFilters: {}, teamFilters: {} });
  useAppStore.setState({ tags, projectFields: [AREA, NOTES, TYPE], teams: [] });
  setSite(1);
});

describe('ProjectFilterDropdown', () => {
  it('renders one section per dropdown field with "(None)", then the tags', () => {
    render(<ProjectFilterDropdown />);
    const trigger = screen.getByRole('button', { name: 'Filter' });
    expect(trigger).toHaveAttribute('title', 'Filter projects');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('Filter');
    openDropdown();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const sections = screen.getAllByRole('group');
    // Area has no item at site 1, Notes is no dropdown
    expect(sections.map((g) => g.getAttribute('aria-label'))).toEqual(['Project type', 'Tags']);
    expect(within(sections[0]).getByLabelText('(None) in Project type')).toBeInTheDocument();
    expect(within(sections[0]).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual([
      '(None)',
      'Internal',
      'Customer',
    ]);
    // Tags in tag order, no "(None)"
    expect(within(sections[1]).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual([
      'Pilot',
      'Urgent',
    ]);
    // Items and tags of other sites are not offered
    expect(screen.queryByLabelText('Bio')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Zurich only')).not.toBeInTheDocument();
  });

  it('writes the filter for the current site only and shows a count and a badge', () => {
    render(<ProjectFilterDropdown />);
    openDropdown();
    fireEvent.click(screen.getByLabelText('Internal'));
    fireEvent.click(screen.getByLabelText('(None) in Project type'));
    fireEvent.click(screen.getByLabelText('Pilot'));
    expect(useViewStore.getState().projectFilters).toEqual({
      ':1': { optionIds: [10], noneFieldIds: [1], tagIds: [30] },
    });
    const trigger = screen.getByRole('button', { name: 'Filter (3 selected)' });
    expect(trigger).toHaveTextContent('3');
    expect(screen.getByLabelText('Internal')).toBeChecked();

    fireEvent.click(screen.getByLabelText('Internal'));
    fireEvent.click(screen.getByLabelText('(None) in Project type'));
    fireEvent.click(screen.getByLabelText('Pilot'));
    expect(useViewStore.getState().projectFilters).toEqual({});
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
  });

  it('keeps separate filters per site', () => {
    useViewStore.setState({ projectFilters: { ':2': { ...empty, optionIds: [20], tagIds: [32] } } });
    const { rerender } = render(<ProjectFilterDropdown />);
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();

    setSite(2);
    rerender(<ProjectFilterDropdown />);
    expect(screen.getByRole('button', { name: 'Filter (2 selected)' })).toBeInTheDocument();
    openDropdown();
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      'Project type',
      'Area',
      'Tags',
    ]);
    expect(screen.getByLabelText('Bio')).toBeChecked();
    expect(screen.getByLabelText('Zurich only')).toBeChecked();
  });

  it('Clear removes the site filter', () => {
    useViewStore.setState({
      projectFilters: { ':1': { ...empty, tagIds: [30] }, ':2': { ...empty, optionIds: [20] } },
    });
    render(<ProjectFilterDropdown />);
    openDropdown();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(useViewStore.getState().projectFilters).toEqual({ ':2': { ...empty, optionIds: [20] } });
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('ignores stale ids in the stored filter and drops them on the next write', () => {
    useViewStore.setState({ projectFilters: { ':1': { optionIds: [999, 20], noneFieldIds: [77, 2], tagIds: [32] } } });
    render(<ProjectFilterDropdown />);
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
    openDropdown();
    fireEvent.click(screen.getByLabelText('Customer'));
    expect(useViewStore.getState().projectFilters).toEqual({ ':1': { ...empty, optionIds: [11] } });
  });

  it('does not offer items and tags of teams the header team filter hides', () => {
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1, name: 'A' }), makeTeam({ id: 2, site_id: 1, name: 'B' })],
      projectFields: [
        { ...TYPE, options: [...TYPE.options, makeProjectFieldOption({ id: 12, name: 'Team B item', team_ids: [2] })] },
      ],
      tags: [...tags, makeTag({ id: 33, name: 'Team B tag', team_ids: [2] })],
    });
    useViewStore.setState({ teamFilters: { ':1': { teamIds: [1], noTeam: false } } });
    render(<ProjectFilterDropdown />);
    openDropdown();
    expect(screen.queryByLabelText('Team B item')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Team B tag')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Internal')).toBeInTheDocument();
  });

  it('shows the tags alone when the site has no dropdown field', () => {
    useAppStore.setState({ projectFields: [NOTES] });
    render(<ProjectFilterDropdown />);
    openDropdown();
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Tags']);
  });

  it('shows the fields alone when the site has no tag', () => {
    useAppStore.setState({ tags: [] });
    render(<ProjectFilterDropdown />);
    openDropdown();
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Project type']);
  });

  it('shows an empty state when the site has neither fields nor tags', () => {
    useAppStore.setState({ projectFields: [AREA, NOTES], tags: [tags[2]] });
    render(<ProjectFilterDropdown />);
    openDropdown();
    expect(screen.getByText('No fields or tags for this site')).toBeInTheDocument();
  });

  it('is disabled without a current site', () => {
    useAppStore.setState({ currentSite: null });
    render(<ProjectFilterDropdown />);
    expect(screen.getByRole('button', { name: 'Filter' })).toBeDisabled();
  });

  it('Escape closes the dropdown without reaching other key handlers', () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    render(<ProjectFilterDropdown />);
    openDropdown();
    expect(screen.getByRole('dialog', { name: 'Filter projects' })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText('Pilot'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Filter' })).toHaveFocus();
    document.removeEventListener('keydown', outer);
  });

  it('portals the panel out of its wrapper, where a mousedown keeps it open', () => {
    render(<ProjectFilterDropdown />);
    openDropdown();
    const panel = screen.getByRole('dialog', { name: 'Filter projects' });
    const wrapper = screen.getByRole('button', { name: 'Filter' }).parentElement as HTMLElement;
    expect(wrapper).not.toContainElement(panel);
    expect(panel.parentElement).toBe(document.body);
    fireEvent.mouseDown(screen.getByLabelText('Pilot'));
    fireEvent.mouseDown(panel);
    expect(screen.getByRole('dialog', { name: 'Filter projects' })).toBeInTheDocument();
  });

  it('closes on an outside mousedown', () => {
    render(
      <div>
        <ProjectFilterDropdown />
        <p>outside</p>
      </div>
    );
    openDropdown();
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('announces a dialog of checkboxes and points at it while open', () => {
    render(<ProjectFilterDropdown />);
    const trigger = screen.getByRole('button', { name: 'Filter' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).not.toHaveAttribute('aria-controls');
    openDropdown();
    const panel = screen.getByRole('dialog', { name: 'Filter projects' });
    expect(trigger).toHaveAttribute('aria-controls', panel.id);
  });

  it('closes when focus leaves the wrapper (Tab out), not when it moves inside', () => {
    render(
      <div>
        <ProjectFilterDropdown />
        <button type="button">next</button>
      </div>
    );
    openDropdown();
    const pilot = screen.getByLabelText('Pilot');
    fireEvent.blur(screen.getByLabelText('Internal'), { relatedTarget: pilot });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Focus dropping to the body (mousedown on option text) keeps it open too.
    fireEvent.blur(pilot, { relatedTarget: null });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.blur(pilot, { relatedTarget: screen.getByRole('button', { name: 'next' }) });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('drops a "(None)" selection whose field no longer shows at this site', () => {
    // Every item of "Project type" re-scoped to site 2: the field has no
    // checkbox at site 1, so its "(None)" must not count as selected.
    useAppStore.setState({
      projectFields: [
        { ...TYPE, options: [makeProjectFieldOption({ id: 10, name: 'Internal', all_sites: false, site_ids: [2] })] },
      ],
    });
    useViewStore.setState({ projectFilters: { ':1': { ...empty, noneFieldIds: [1] } } });
    render(<ProjectFilterDropdown />);
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
    openDropdown();
    expect(screen.queryByText('Project type')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('compact mode hides the visible label but keeps the accessible name', () => {
    render(<ProjectFilterDropdown compact align="right" />);
    const trigger = screen.getByRole('button', { name: 'Filter' });
    expect(trigger.textContent).toBe('');
    openDropdown();
    // Right edge on the trigger's right edge (AnchoredPanel align="end")
    expect(screen.getByRole('dialog')).toHaveAttribute('data-align', 'end');
  });

  it('scrolls the sections inside a body below the fixed header', () => {
    useViewStore.setState({ projectFilters: { ':1': { ...empty, tagIds: [30] } } });
    render(<ProjectFilterDropdown />);
    openDropdown();
    const dialog = screen.getByRole('dialog', { name: 'Filter projects' });
    const body = screen.getByRole('group', { name: 'Project type' }).parentElement as HTMLElement;
    // The body is a direct child of the panel and holds every section
    expect(body.parentElement).toBe(dialog);
    expect(body.className).toMatch(/scrollBody/);
    expect(within(body).getByRole('group', { name: 'Tags' })).toBeInTheDocument();
    // The title and Clear stay outside the scrolling body
    const clear = screen.getByRole('button', { name: 'Clear' });
    expect(body).not.toContainElement(clear);
    expect(body).not.toContainElement(screen.getByText('Filter projects'));
    expect(dialog).toContainElement(clear);
  });
});
