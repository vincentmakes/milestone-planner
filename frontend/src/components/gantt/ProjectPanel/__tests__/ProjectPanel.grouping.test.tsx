/**
 * ProjectPanel with Group-by sections: one SectionRow per section (pill +
 * count, chevron with aria-expanded), project rows only for expanded
 * sections, and the Group-by trigger between the Tags trigger and the
 * header divider. The section header's class names must not contain "row"
 * (drag/resize hooks look rows up with [class*="row"]).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ProjectPanel } from '../ProjectPanel';
import { useGanttGrouping } from '@/hooks/useGanttGrouping';
import { buildGanttRows, buildProjectSections, flatGanttRows } from '../../utils/projectSections';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import type { Project, Site } from '@/types';
import type { TagGroup, LegacyGroupedTag } from '@/utils/tags';
import { makeUser } from '@/test/factories';

vi.mock('@/api', () => ({}));
vi.mock('@/hooks', () => ({
  useDataLoader: () => ({ refreshCustomColumns: vi.fn() }),
}));
vi.mock('@/components/modals', () => ({
  CustomColumnModal: () => null,
  CustomColumnsManagerModal: () => null,
}));
// The project tree rows themselves are covered elsewhere.
vi.mock('../ProjectRow', () => ({
  ProjectRow: ({ project, onReorder }: { project: Project; onReorder?: unknown }) => (
    <div data-testid="project-row" data-reorder={onReorder ? 'yes' : 'no'}>{project.name}</div>
  ),
}));

const TYPE: TagGroup = { id: 1, name: 'Project type', single_select: true, sort_order: 0 };
const tags: LegacyGroupedTag[] = [
  { id: 1, name: 'Internal', color: '#fde047', group_id: 1, all_sites: true, site_ids: [], sort_order: 0 },
  { id: 2, name: 'Customer', color: '#1d4ed8', group_id: 1, all_sites: true, site_ids: [], sort_order: 1 },
];

function project(id: number, name: string, tagIds: number[]): Project {
  return { id, name, site_id: 1, tags: tagIds.map((t) => ({ id: t })) } as unknown as Project;
}
const projects = [
  project(1, 'Bioprocess Scale-Up', [2]),
  project(2, 'Catalyst Optimization', [1]),
  project(3, 'Quality System Upgrade', []),
  project(4, 'Analytical Method Transfer', [2]),
];

/** What GanttContainer does: the hook's grouping → rows → ProjectPanel. */
function GroupedPanel() {
  const { group, siteTags, collapsedKeys, toggleSection } = useGanttGrouping();
  const rows = group
    ? buildGanttRows(buildProjectSections(projects, group, siteTags), collapsedKeys)
    : flatGanttRows(projects);
  return (
    <ProjectPanel
      projects={projects}
      rows={rows}
      onToggleSection={toggleSection}
      width={320}
      onProjectReorder={group ? undefined : () => {}}
    />
  );
}

beforeEach(() => {
  localStorage.clear();
  useCustomColumnStore.setState({ customColumns: [], customColumnValues: {}, customColumnFilters: {} });
  useViewStore.setState({ ganttGrouping: { ':1': 1 }, collapsedGanttSections: {}, ganttColorBy: {}, tagFilters: {} });
  useAppStore.setState({
    tags,
    tagGroups: [TYPE],
    currentUser: makeUser({ id: 1, name: 'Someone', role: 'superuser' }),
    currentSite: { id: 1, name: 'Basel' } as Site,
  });
});

const rowNames = () => screen.queryAllByTestId('project-row').map((r) => r.textContent);

describe('ProjectPanel grouped by a tag group', () => {
  it('renders a section header per section with pill and count, projects under it', () => {
    const { container } = render(<GroupedPanel />);
    const headers = [...container.querySelectorAll('[data-section-key]')];
    expect(headers.map((h) => h.getAttribute('data-section-key'))).toEqual(['tag-1', 'tag-2', 'none']);
    expect(headers.map((h) => h.textContent)).toEqual([
      'Internal1 project',
      'Customer2 projects',
      'No Project type1 project',
    ]);
    // Tag colour + contrasting text on the pill
    const pill = screen.getByText('Internal');
    expect(pill).toHaveStyle({ backgroundColor: '#fde047', color: '#111827' });

    expect(rowNames()).toEqual([
      'Catalyst Optimization',
      'Bioprocess Scale-Up',
      'Analytical Method Transfer',
      'Quality System Upgrade',
    ]);
    // Header count still counts projects, not rows
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('keeps "row" out of section class names and carries no entity data attributes', () => {
    const { container } = render(<GroupedPanel />);
    for (const header of container.querySelectorAll('[data-section-key]')) {
      for (const el of [header, ...header.querySelectorAll('*')]) {
        expect(el.getAttribute('class') ?? '').not.toMatch(/row/);
        expect(el.hasAttribute('data-project-id')).toBe(false);
        expect(el.hasAttribute('data-phase-id')).toBe(false);
      }
    }
  });

  it('collapsing a section hides its projects and persists; expanding brings them back', () => {
    render(<GroupedPanel />);
    const chevron = screen.getByRole('button', { name: 'Collapse Customer' });
    expect(chevron).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(chevron);
    expect(useViewStore.getState().collapsedGanttSections).toEqual({ ':1': ['tag-2'] });
    expect(rowNames()).toEqual(['Catalyst Optimization', 'Quality System Upgrade']);
    const expand = screen.getByRole('button', { name: 'Expand Customer' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');

    // A click anywhere on the header toggles too (once, not twice)
    fireEvent.click(screen.getByText('Customer'));
    expect(rowNames()).toHaveLength(4);
    expect(useViewStore.getState().collapsedGanttSections).toEqual({});
  });

  it('hides the reorder handle while grouped', () => {
    render(<GroupedPanel />);
    expect(screen.getAllByTestId('project-row').every((r) => r.dataset.reorder === 'no')).toBe(true);
    act(() => useViewStore.getState().setGanttGrouping(1, null));
    expect(screen.queryByRole('button', { name: /^Collapse/ })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('project-row').every((r) => r.dataset.reorder === 'yes')).toBe(true);
  });

  it('orders the view controls Tags, Group by, Colour by, then the divider', () => {
    render(<GroupedPanel />);
    const tagsTrigger = screen.getByRole('button', { name: 'Tags' });
    const groupTrigger = screen.getByRole('button', { name: 'Grouped by Project type' });
    const colorTrigger = screen.getByRole('button', { name: 'Colour by' });
    const divider = screen.getByTestId('header-divider');
    const follows = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(follows(tagsTrigger, groupTrigger)).toBeTruthy();
    expect(follows(groupTrigger, colorTrigger)).toBeTruthy();
    expect(follows(colorTrigger, divider)).toBeTruthy();
  });

  it('falls back to one row per project without rows', () => {
    render(<ProjectPanel projects={projects} width={320} />);
    expect(rowNames()).toHaveLength(4);
    expect(document.querySelector('[data-section-key]')).toBeNull();
  });
});
