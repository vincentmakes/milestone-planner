/**
 * ProjectModal teams: the project's teams are ticked from its site's teams
 * (the field is hidden on a site without teams), sent as team_ids on create
 * and edit, decide which team-restricted tags are offered (and kept on save),
 * and a new project starts with the header team filter's teams.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ProjectModal } from '../ProjectModal';
import { TAG_PICKER_PLACEHOLDER } from '../TagPicker';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { createProject, updateProject } from '@/api/endpoints/projects';
import { makeProjectField, makeTeam } from '@/test/factories';
import { tagFilterKey } from '@/utils/tags';
import type { Project, Site, Tag } from '@/types';

vi.mock('@/api/endpoints/projects', () => ({
  createProject: vi.fn().mockResolvedValue({}),
  updateProject: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn(async () => (await import('@/stores/appStore')).useAppStore.getState().projects),
}));
vi.mock('@/api/endpoints/settings', () => ({ getPredefinedPhases: vi.fn(async () => []) }));

const project = {
  id: 9,
  name: 'Bioprocess Scale-Up',
  site_id: 1,
  customer: null,
  pm_id: null,
  sales_pm: null,
  volume: null,
  confirmed: false,
  archived: false,
  start_date: '2026-09-01',
  end_date: '2026-10-01',
  tags: [],
  team_ids: [],
  phases: [],
  staffAssignments: [],
  equipmentAssignments: [],
} as unknown as Project;

const analytics = makeTeam({ id: 1, site_id: 1, name: 'Analytics' });
const processTeam = makeTeam({ id: 2, site_id: 1, name: 'Process' });
const zurichLab = makeTeam({ id: 3, site_id: 2, name: 'Zurich lab' });
const analyticsOnly: Tag = {
  id: 7,
  name: 'Analytics only',
  color: '#3b82f6',
  all_sites: true,
  site_ids: [],
  team_ids: [1],
  sort_order: 0,
};

const teamsGroup = () => screen.queryByRole('group', { name: 'Project teams' });
const sentData = (fn: typeof createProject | typeof updateProject) => {
  const calls = vi.mocked(fn).mock.calls;
  const last = calls[calls.length - 1];
  return (fn === createProject ? last[0] : last[1]) as { team_ids?: number[]; tag_ids?: number[] };
};
function offeredTags() {
  fireEvent.click(screen.getByPlaceholderText(TAG_PICKER_PLACEHOLDER));
  return screen.queryAllByRole('option').map((o) => o.textContent);
}

beforeEach(() => {
  vi.mocked(createProject).mockClear();
  vi.mocked(updateProject).mockClear();
  useViewStore.setState({ teamFilters: {} });
  useAppStore.setState({
    currentSite: { id: 1, name: 'Basel' } as Site,
    currentUser: { id: 1, name: 'Ada Admin', role: 'admin' } as never,
    staff: [],
    projects: [project],
    tags: [analyticsOnly],
    projectFields: [],
    teams: [analytics, processTeam, zurichLab],
  });
});

afterEach(() => {
  useUIStore.getState().closeModal();
  useViewStore.setState({ teamFilters: {} });
});

describe('ProjectModal teams', () => {
  it('places Teams after every project field and right before Tags', () => {
    useAppStore.setState({
      projectFields: [
        makeProjectField({ id: 1, name: 'Budget', field_type: 'number', sort_order: 0 }),
        makeProjectField({ id: 2, name: 'Reference', field_type: 'text', sort_order: 1 }),
      ],
    });
    act(() => useUIStore.getState().openProjectModal());
    render(<ProjectModal />);
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const lastField = screen.getByLabelText('Reference');
    const teams = teamsGroup()!;
    const tags = screen.getByPlaceholderText(TAG_PICKER_PLACEHOLDER);
    expect(follows(screen.getByLabelText('Budget'), lastField)).toBe(true);
    expect(follows(lastField, teams)).toBe(true);
    expect(follows(teams, tags)).toBe(true);
  });

  it('hides the teams field on a site without teams', () => {
    useAppStore.setState({ teams: [zurichLab] });
    act(() => useUIStore.getState().openProjectModal());
    render(<ProjectModal />);
    expect(teamsGroup()).not.toBeInTheDocument();
    expect(screen.queryByText('Teams')).not.toBeInTheDocument();
  });

  it("offers the site's teams and sends the ticked ones on create", async () => {
    act(() => useUIStore.getState().openProjectModal());
    render(<ProjectModal />);
    expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual([
      'Analytics',
      'Process',
    ]);
    fireEvent.change(screen.getByLabelText('Project Name *'), { target: { value: 'New study' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Process' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    expect(sentData(createProject).team_ids).toEqual([2]);
  });

  it('preloads the teams on edit and sends the changed list', async () => {
    act(() => useUIStore.getState().openProjectModal({ ...project, team_ids: [1] }));
    render(<ProjectModal />);
    expect(screen.getByRole('checkbox', { name: 'Analytics' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Process' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Process' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(sentData(updateProject).team_ids).toEqual([1, 2]);
    expect(useAppStore.getState().projects.find((p) => p.id === 9)?.team_ids).toEqual([1, 2]);
  });

  it('does not send a ticked team deleted while the dialog is open (an inactive one is kept)', async () => {
    useAppStore.setState({ teams: [analytics, { ...processTeam, active: false }, zurichLab] });
    act(() => useUIStore.getState().openProjectModal({ ...project, team_ids: [1, 2] }));
    render(<ProjectModal />);
    act(() => useAppStore.setState({ teams: [{ ...processTeam, active: false }, zurichLab] }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(sentData(updateProject).team_ids).toEqual([2]);
  });

  it('offers a team-restricted tag once its team is ticked and drops it on save when unticked', async () => {
    act(() => useUIStore.getState().openProjectModal(project));
    render(<ProjectModal />);
    expect(offeredTags()).not.toContain('Analytics only');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    expect(offeredTags()).toContain('Analytics only');
    fireEvent.click(screen.getByRole('option', { name: 'Analytics only' }));
    expect(screen.getByLabelText('Remove Analytics only')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Analytics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(sentData(updateProject)).toMatchObject({ team_ids: [], tag_ids: [] });
  });

  it("starts a new project with the header filter's teams", () => {
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [2], noTeam: true } } });
    act(() => useUIStore.getState().openProjectModal());
    render(<ProjectModal />);
    expect(screen.getByRole('checkbox', { name: 'Process' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Analytics' })).not.toBeChecked();
  });
});
