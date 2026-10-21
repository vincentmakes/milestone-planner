/**
 * GanttContainer wiring of "Group by tag group": both panes get the very same
 * row list (so they stack identically), the ProjectPanel can toggle sections,
 * and project reordering is switched off while grouped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { GanttContainer } from '../GanttContainer';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import type { GanttRow } from '../utils/projectSections';
import { tagFilterKey } from '@/utils/tags';
import { makeTeam } from '@/test/factories';
import type { Project, Site, Tag, TagGroup } from '@/types';

interface PanelProps { rows?: GanttRow[]; onProjectReorder?: unknown; onToggleSection?: (k: string) => void }
interface TimelineProps { rows?: GanttRow[]; projects: Project[] }

const mocks = vi.hoisted(() => ({
  ProjectPanel: vi.fn((_props: unknown) => null),
  Timeline: vi.fn((_props: unknown) => null),
}));
const panelProps = () => mocks.ProjectPanel.mock.lastCall?.[0] as PanelProps | undefined;
const timelineProps = () => mocks.Timeline.mock.lastCall?.[0] as TimelineProps | undefined;

// Both panes receive a ref, hence forwardRef stand-ins.
vi.mock('../ProjectPanel', async () => {
  const { forwardRef } = await import('react');
  return { ProjectPanel: forwardRef((props: object, _ref) => mocks.ProjectPanel(props)) };
});
vi.mock('../Timeline', async () => {
  const { forwardRef } = await import('react');
  return { Timeline: forwardRef((props: object, _ref) => mocks.Timeline(props)) };
});
vi.mock('@/hooks', () => ({
  useScrollSync: () => {},
  useTagFilteredProjects: (projects: Project[]) => projects,
}));
vi.mock('@/components/views/StaffView/StaffView', () => ({ StaffView: () => null }));
vi.mock('@/components/views/EquipmentView/EquipmentView', () => ({ EquipmentView: () => null }));

const TYPE: TagGroup = { id: 1, name: 'Project type', single_select: true, sort_order: 0 };
const tags: Tag[] = [
  { id: 1, name: 'Internal', color: '#fde047', group_id: 1, all_sites: true, site_ids: [], sort_order: 0 },
];
const projects = [
  { id: 1, name: 'Alpha', site_id: 1, confirmed: true, tags: [{ id: 1 }] },
  { id: 2, name: 'Beta', site_id: 1, confirmed: true, tags: [] },
] as unknown as Project[];

const describeRows = (rows: GanttRow[] | undefined) =>
  rows?.map((r) => (r.type === 'section' ? `${r.section.key}${r.collapsed ? ' (collapsed)' : ''}` : r.project.id));

beforeEach(() => {
  localStorage.clear();
  mocks.ProjectPanel.mockClear();
  mocks.Timeline.mockClear();
  useViewStore.setState({ ganttGrouping: {}, collapsedGanttSections: {}, teamFilters: {} });
  useAppStore.setState({
    projects,
    tags,
    tagGroups: [TYPE],
    teams: [],
    currentSite: { id: 1, name: 'Basel' } as Site,
    currentUser: { id: 9, name: 'Admin', role: 'admin' } as never,
  });
});

describe('GanttContainer grouping', () => {
  it('passes flat rows and reordering when not grouped', () => {
    render(<GanttContainer />);
    expect(describeRows(panelProps()?.rows)).toEqual([1, 2]);
    expect(panelProps()?.onProjectReorder).toBeTypeOf('function');
    expect(timelineProps()?.rows).toBe(panelProps()?.rows);
  });

  it('passes the same sectioned rows to both panes and disables reordering', () => {
    useViewStore.setState({ ganttGrouping: { ':1': 1 } });
    render(<GanttContainer />);
    expect(describeRows(panelProps()?.rows)).toEqual(['tag-1', 1, 'none', 2]);
    expect(timelineProps()?.rows).toBe(panelProps()?.rows);
    expect(panelProps()?.onProjectReorder).toBeUndefined();
    // The timeline still gets every project (dependency arrows, drop targets)
    expect(timelineProps()?.projects.map((p) => p.id)).toEqual([1, 2]);

    act(() => panelProps()?.onToggleSection?.('tag-1'));
    expect(describeRows(panelProps()?.rows)).toEqual(['tag-1 (collapsed)', 'none', 2]);
    expect(timelineProps()?.rows).toBe(panelProps()?.rows);
  });

  it('with an active team filter, hides non-matching projects and keeps matching ones', () => {
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1 })],
      projects: [{ ...projects[0], team_ids: [1] }, { ...projects[1], team_ids: [] }],
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
    render(<GanttContainer />);
    expect(describeRows(panelProps()?.rows)).toEqual([1]);
    expect(timelineProps()?.rows).toBe(panelProps()?.rows);
  });
});
