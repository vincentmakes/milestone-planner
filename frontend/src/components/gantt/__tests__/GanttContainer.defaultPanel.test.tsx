/**
 * GanttContainer opens the admin's default overview panel (Settings →
 * Features & defaults) each time it mounts, for those who get the panels;
 * the user may close it, and a later settings refetch does not reopen it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { GanttContainer } from '../GanttContainer';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { makeUser } from '@/test/factories';
import type { InstanceSettings, Project, Site } from '@/types';

vi.mock('../ProjectPanel', async () => {
  const { forwardRef } = await import('react');
  return { ProjectPanel: forwardRef(() => null) };
});
vi.mock('../Timeline', async () => {
  const { forwardRef } = await import('react');
  return { Timeline: forwardRef(() => null) };
});
vi.mock('@/hooks', () => ({
  useScrollSync: () => {},
  useTagFilteredProjects: (projects: Project[]) => projects,
}));
vi.mock('@/components/views/StaffView/StaffView', () => ({ StaffView: () => <div>Staff overview</div> }));
vi.mock('@/components/views/EquipmentView/EquipmentView', () => ({
  EquipmentView: () => <div>Equipment overview</div>,
}));

const projects = [{ id: 1, name: 'Alpha', site_id: 1, confirmed: true, pm_id: 7, tags: [] }] as unknown as Project[];

function seed(panel: string | null, user = makeUser({ id: 9, role: 'admin' })) {
  const settings: InstanceSettings | null = panel === null ? null : { gantt_default_panel: panel };
  useAppStore.setState({
    projects,
    tags: [],
    tagGroups: [],
    teams: [],
    currentSite: { id: 1, name: 'Basel' } as Site,
    currentUser: user,
    instanceSettings: settings,
  });
}

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState({
    ganttGrouping: {},
    collapsedGanttSections: {},
    teamFilters: {},
    showStaffOverview: false,
    showEquipmentOverview: false,
  });
});

describe('GanttContainer default overview panel', () => {
  it('opens the Staff panel when the default is staff', () => {
    seed('staff');
    render(<GanttContainer />);
    expect(screen.getByText('Staff overview')).toBeInTheDocument();
    expect(useViewStore.getState().showStaffOverview).toBe(true);
  });

  it('opens the Equipment panel, closing the Staff one, when the default is equipment', () => {
    useViewStore.setState({ showStaffOverview: true });
    seed('equipment');
    render(<GanttContainer />);
    expect(screen.getByText('Equipment overview')).toBeInTheDocument();
    expect(screen.queryByText('Staff overview')).not.toBeInTheDocument();
    expect(useViewStore.getState()).toMatchObject({ showEquipmentOverview: true, showStaffOverview: false });
  });

  it('keeps the browser\'s own choice when the default is none', () => {
    useViewStore.setState({ showStaffOverview: true });
    seed('none');
    render(<GanttContainer />);
    expect(useViewStore.getState()).toMatchObject({ showStaffOverview: true, showEquipmentOverview: false });
  });

  it('opens nothing for someone who does not get the overview panels', () => {
    seed('staff', makeUser({ id: 9, role: 'user' }));
    render(<GanttContainer />);
    expect(useViewStore.getState().showStaffOverview).toBe(false);
    expect(screen.queryByText('Staff overview')).not.toBeInTheDocument();
  });

  it('opens it for the project manager of a project', () => {
    seed('equipment', makeUser({ id: 7, role: 'user' }));
    render(<GanttContainer />);
    expect(useViewStore.getState().showEquipmentOverview).toBe(true);
  });

  it('waits for the settings to load, then applies the default once', () => {
    seed(null);
    render(<GanttContainer />);
    expect(useViewStore.getState().showStaffOverview).toBe(false);

    act(() => useAppStore.getState().setInstanceSettings({ gantt_default_panel: 'staff' }));
    expect(useViewStore.getState().showStaffOverview).toBe(true);
  });

  it('lets the user close it: a settings refetch does not reopen it, the next opening does', () => {
    seed('staff');
    const { unmount } = render(<GanttContainer />);
    act(() => useViewStore.getState().setShowStaffOverview(false));

    act(() => useAppStore.getState().setInstanceSettings({ gantt_default_panel: 'staff', show_weekends: 'true' }));
    act(() => useAppStore.getState().setInstanceSettings({ gantt_default_panel: 'equipment' }));
    expect(useViewStore.getState()).toMatchObject({ showStaffOverview: false, showEquipmentOverview: false });

    unmount();
    render(<GanttContainer />);
    expect(useViewStore.getState().showEquipmentOverview).toBe(true);
  });
});
