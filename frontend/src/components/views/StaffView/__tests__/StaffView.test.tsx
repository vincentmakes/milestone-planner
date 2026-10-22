/**
 * Staff overview: the left panel lists the site's active staff with today's
 * availability, a role/skill filter, expandable rows (absences + assignments
 * collected from every level of the project tree) and a confirmed delete
 * for absences.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { StaffView } from '../StaffView';
import { resetAllStores, useAppStore, useUIStore, useViewStore } from '@/stores';
import { tagFilterKey } from '@/utils/tags';
import { deleteVacation, getVacations } from '@/api/endpoints/vacations';
import { formatDateISO } from '@/utils/date';
import { buildEventDateSet } from '@/api';
import type { CompanyEvent } from '@/types';
import { stubConfirm } from '@/test/confirmDialog';
import { USER_DEFAULTS } from '@/test/permissionFixtures';
import {
  makePhase,
  makeProject,
  makeSite,
  makeStaff,
  makeSubphase,
  makeTeam,
  makeUser,
  makeVacation,
} from '@/test/factories';

vi.mock('@/api/endpoints/vacations', () => ({
  deleteVacation: vi.fn(),
  getVacations: vi.fn(),
}));

function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return formatDateISO(d);
}

const site = makeSite({ id: 1 });
const alice = makeStaff({
  id: 4,
  name: 'Alice Ames',
  role: 'Scientist',
  skills: [{ id: 7, name: 'HPLC', color: '#f00' }],
});
const bob = makeStaff({ id: 5, name: 'Bob Brown', role: 'Technician', max_capacity: 80 });
const carl = makeStaff({ id: 6, name: 'Carl Cole', role: 'Scientist', site_id: 2 }); // other site
const dora = makeStaff({ id: 8, name: 'Dora Diaz', role: 'Scientist', active: false });

function seed(role: 'admin' | 'superuser' | 'user' = 'admin', userId = 1) {
  const subphase = makeSubphase({
    id: 30,
    name: 'Column screening',
    start_date: isoOffset(-3),
    end_date: isoOffset(3),
    staffAssignments: [{ id: 301, staff_id: 4, allocation: 20, start_date: '', end_date: '' }],
    children: [
      makeSubphase({
        id: 31,
        name: 'Nested run',
        staffAssignments: [
          { id: 311, staff_id: 4, allocation: 10, start_date: '2025-01-01', end_date: '2025-01-10' },
        ],
      }),
    ],
  });
  const phase = makePhase({
    id: 20,
    name: 'Feasibility',
    start_date: isoOffset(-10),
    end_date: isoOffset(10),
    staffAssignments: [{ id: 201, staff_id: 4, allocation: 30, start_date: '', end_date: '' }],
    children: [subphase],
  });
  const project = makeProject({
    id: 10,
    name: 'Bioprocess Scale-Up',
    staffAssignments: [
      { id: 101, staff_id: 5, allocation: 50, start_date: isoOffset(-1), end_date: isoOffset(1) },
    ],
    phases: [phase],
  });
  const archived = makeProject({
    id: 11,
    name: 'Old archived',
    archived: true,
    staffAssignments: [
      { id: 111, staff_id: 4, allocation: 90, start_date: isoOffset(-1), end_date: isoOffset(1) },
    ],
  });

  useAppStore.setState({
    currentSite: site,
    currentUser: makeUser({ id: userId, role }),
    staff: [bob, alice, carl, dora],
    projects: [project, archived],
    skills: [{ id: 7, name: 'HPLC', color: '#f00' }],
    vacations: [
      makeVacation({
        id: 61,
        staff_id: 5,
        start_date: isoOffset(20),
        end_date: isoOffset(22),
        description: 'Ski trip',
      }),
      makeVacation({
        id: 62,
        staff_id: 5,
        start_date: isoOffset(30),
        end_date: isoOffset(60),
        description: '[R:1,3] Course',
      }),
    ],
  });
}

const rowFor = (name: string) => screen.getByText(name).closest('[draggable]') as HTMLElement;
const panelOf = () =>
  screen.getByText('Staff Overview').parentElement!.parentElement!.parentElement as HTMLElement;

beforeEach(() => {
  resetAllStores();
  vi.mocked(deleteVacation).mockReset();
  vi.mocked(getVacations).mockReset();
});

describe('StaffView panel', () => {
  it("lists only active staff of the current site, sorted by name, with today's availability", () => {
    seed();
    render(<StaffView />);

    expect(screen.getByText('Staff Overview')).toBeInTheDocument();
    const names = screen
      .getAllByText(/^(Alice Ames|Bob Brown|Carl Cole|Dora Diaz)$/)
      .map((n) => n.childNodes[0].textContent);
    expect(names).toEqual(['Alice Ames', 'Bob Brown']);

    // Alice: phase 30 % + subphase 20 % active today (archived project ignored,
    // the nested past assignment does not count)
    expect(within(rowFor('Alice Ames')).getByText('50% available')).toBeInTheDocument();
    // Bob is part-time (80 %) with 50 % allocated today
    const bobRow = rowFor('Bob Brown');
    expect(within(bobRow).getByText('80%')).toBeInTheDocument();
    expect(within(bobRow).getByText('30% available')).toHaveAttribute(
      'title',
      '30% of 80% max capacity'
    );
  });

  it('leaves bookings awaiting approval out of the availability and marks their bars', () => {
    seed();
    const state = useAppStore.getState();
    const [project, archived] = state.projects;
    useAppStore.setState({
      projects: [
        {
          ...project,
          staffAssignments: [
            ...project.staffAssignments,
            { id: 102, staff_id: 5, allocation: 30, start_date: isoOffset(-1), end_date: isoOffset(1), approval_status: 'pending' },
          ],
        },
        archived,
      ],
    });
    render(<StaffView />);
    // Bob: 50 % approved of 80 %; the pending 30 % does not count.
    expect(within(rowFor('Bob Brown')).getByText('30% available')).toBeInTheDocument();
    const pendingBar = screen.getByTestId('staff-bar-assignment-102');
    expect(pendingBar.className).toMatch(/pendingBar/);
    expect(pendingBar).toHaveAttribute('title', expect.stringContaining('pending approval'));
    expect(screen.getByTestId('staff-bar-assignment-101').className).not.toMatch(/pendingBar/);
  });

  it('does not let a user without assignments.self_create drag their own row', () => {
    seed('user', 4);
    useAppStore.setState({
      currentUser: makeUser({
        id: 4,
        role: 'user',
        permissions: USER_DEFAULTS.filter((k) => k !== 'assignments.self_create'),
      }),
    });
    render(<StaffView />);
    expect(rowFor('Alice Ames')).toHaveAttribute('draggable', 'false');
  });

  it('reports zero availability for someone absent today', () => {
    seed();
    useAppStore.setState({
      vacations: [
        makeVacation({ id: 70, staff_id: 4, start_date: isoOffset(-1), end_date: isoOffset(1) }),
      ],
    });
    render(<StaffView />);
    expect(within(rowFor('Alice Ames')).getByText('0% available')).toBeInTheDocument();
  });

  it('shows the empty state when the site has no staff', () => {
    useAppStore.setState({ currentSite: site, currentUser: makeUser(), staff: [] });
    render(<StaffView />);
    expect(screen.getByText('No staff found')).toBeInTheDocument();
  });

  it('filters by role and skill and clears the filters', () => {
    seed();
    render(<StaffView />);

    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(screen.getByText('Roles')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Technician' }));
    expect(screen.queryByText('Alice Ames')).not.toBeInTheDocument();
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('1 filter')).toBeInTheDocument();

    // untick the role, tick the skill instead
    fireEvent.click(screen.getByRole('checkbox', { name: 'Technician' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'HPLC' }));
    expect(screen.getByText('Alice Ames')).toBeInTheDocument();
    expect(screen.queryByText('Bob Brown')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Scientist' }));
    expect(screen.getByText('2 filters')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Clear all filters'));
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
    expect(screen.getByText('Filter')).toBeInTheDocument();

    // clicking outside closes the dropdown
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Roles')).not.toBeInTheDocument();
  });

  it("starts with the admin's default skills that still exist, ignoring unknown ids; Clear works for the session", () => {
    seed();
    // 99 was deleted since
    useAppStore.setState({ instanceSettings: { staff_panel_default_skills: '[7,99]' } });
    const { unmount } = render(<StaffView />);

    expect(screen.getByText('Alice Ames')).toBeInTheDocument();
    expect(screen.queryByText('Bob Brown')).not.toBeInTheDocument();
    expect(screen.getByText('1 filter')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /1 filter/ }));
    expect(screen.getByRole('checkbox', { name: 'HPLC' })).toBeChecked();
    fireEvent.click(screen.getByText('Clear all filters'));
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();

    // The next opening applies the default again
    unmount();
    render(<StaffView embedded />);
    expect(screen.queryByText('Bob Brown')).not.toBeInTheDocument();
  });

  it('starts unfiltered when none of the default skills exists any more', () => {
    seed();
    useAppStore.setState({ instanceSettings: { staff_panel_default_skills: '[99]' } });
    render(<StaffView />);
    expect(screen.getByText('Filter')).toBeInTheDocument();
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
  });

  it('opens the filter as a dialog that Escape closes, focus back on the trigger', () => {
    seed();
    render(<StaffView />);
    const trigger = screen.getByRole('button', { name: /Filter/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Filter staff' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Filter staff' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('shows placeholders when no roles or skills exist', () => {
    useAppStore.setState({
      currentSite: site,
      currentUser: makeUser(),
      staff: [makeStaff({ id: 9, name: 'No Role', role: undefined })],
      skills: [],
    });
    render(<StaffView />);
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(screen.getByText('No roles defined')).toBeInTheDocument();
    expect(screen.getByText('No skills defined')).toBeInTheDocument();
    expect(screen.getByText('No title')).toBeInTheDocument();
  });

  it('with an active team filter, hides non-matching staff and keeps matching ones', () => {
    seed();
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1 })],
      staff: [{ ...alice, team_ids: [1] }, { ...bob, team_ids: [] }],
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
    render(<StaffView />);
    expect(screen.getByText('Alice Ames')).toBeInTheDocument();
    expect(screen.queryByText('Bob Brown')).not.toBeInTheDocument();
  });

  it('with an active team filter, drops company events of other teams from the timeline', () => {
    seed();
    const teamEvents: CompanyEvent[] = [
      { id: 81, site_id: 1, site_ids: [1], date: isoOffset(2), end_date: null, name: 'Team B review', team_ids: [2] },
      { id: 82, site_id: 1, site_ids: [1], date: isoOffset(3), end_date: null, name: 'Site audit', team_ids: [] },
    ];
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1, name: 'A' }), makeTeam({ id: 2, site_id: 1, name: 'B' })],
      companyEvents: teamEvents,
      companyEventDates: buildEventDateSet(teamEvents),
    });
    useViewStore.setState({
      viewMode: 'month',
      currentDate: new Date(),
      teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } },
    });
    render(<StaffView />);
    expect(screen.getAllByTitle('Site audit').length).toBeGreaterThan(0);
    expect(screen.queryAllByTitle('Team B review')).toHaveLength(0);

    act(() => useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [2], noTeam: false } } }));
    expect(screen.getAllByTitle('Team B review').length).toBeGreaterThan(0);
  });
});

describe('StaffView expanded rows', () => {
  it('lists absences (with recurring days) and assignments at every level', () => {
    seed();
    render(<StaffView />);

    fireEvent.click(rowFor('Bob Brown'));
    const panel = within(panelOf());
    expect(panel.getByText('Ski trip')).toBeInTheDocument();
    expect(panel.getByText('Course')).toBeInTheDocument();
    expect(screen.getByText('Recurring')).toBeInTheDocument();
    expect(screen.getByText('Add vacation / time off')).toBeInTheDocument();
    // project-level assignment
    expect(screen.getByText('Bioprocess Scale-Up')).toBeInTheDocument();

    fireEvent.click(rowFor('Alice Ames'));
    // phase + subphase + nested subphase assignments carry the phase name
    expect(panel.getAllByText(/Bioprocess Scale-Up › Feasibility/)).toHaveLength(3);
    expect(panel.getByText('30%')).toBeInTheDocument();
    expect(panel.getByText('20%')).toBeInTheDocument();
    expect(panel.getByText('10%')).toBeInTheDocument();

    // collapse again
    fireEvent.click(rowFor('Bob Brown'));
    expect(panel.queryByText('Ski trip')).not.toBeInTheDocument();
  });

  it('opens the absence editor from a row and from the add placeholder', () => {
    seed();
    render(<StaffView />);
    fireEvent.click(rowFor('Bob Brown'));

    fireEvent.click(within(panelOf()).getByText('Ski trip'));
    expect(useUIStore.getState().activeModal).toBe('vacation');
    expect(useUIStore.getState().editingVacation?.id).toBe(61);

    useUIStore.setState({ activeModal: null, editingVacation: null });
    fireEvent.click(screen.getByText('Add vacation / time off'));
    expect(useUIStore.getState().activeModal).toBe('vacation');
    expect(useUIStore.getState().editingVacation).toBeNull();
    expect(useUIStore.getState().modalContext).toMatchObject({ staffId: 5 });
  });

  it('lets a plain user manage only their own absences', () => {
    seed('user', 5);
    render(<StaffView />);

    // A user who manages no project can only drag their own row
    expect(rowFor('Bob Brown')).toHaveAttribute('draggable', 'true');
    expect(rowFor('Alice Ames')).toHaveAttribute('draggable', 'false');

    fireEvent.click(rowFor('Alice Ames'));
    expect(screen.queryByText('Add vacation / time off')).not.toBeInTheDocument();
    fireEvent.click(rowFor('Bob Brown'));
    expect(screen.getByText('Add vacation / time off')).toBeInTheDocument();
  });

  it('shows "No assignments" for a read-only row with nothing in it', () => {
    useAppStore.setState({
      currentSite: site,
      currentUser: makeUser({ id: 99, role: 'user' }),
      staff: [makeStaff({ id: 12, name: 'Idle Ida' })],
    });
    render(<StaffView />);
    fireEvent.click(rowFor('Idle Ida'));
    expect(screen.getByText('No assignments')).toBeInTheDocument();
  });

  it('deletes an absence after confirmation and reloads the list', async () => {
    seed();
    const confirm = stubConfirm(true);
    vi.mocked(deleteVacation).mockResolvedValue(undefined as never);
    vi.mocked(getVacations).mockResolvedValue([]);
    render(<StaffView />);
    fireEvent.click(rowFor('Bob Brown'));

    fireEvent.click(screen.getAllByTitle('Delete vacation')[0]);
    expect(confirm).toHaveBeenCalledWith({
      title: 'Delete absence',
      message: 'Are you sure you want to delete Ski trip for Bob Brown?\n\nThis action cannot be undone.',
      destructive: true,
    });
    await waitFor(() => expect(useAppStore.getState().vacations).toEqual([]));
    expect(deleteVacation).toHaveBeenCalledWith(61);
    // The shared dialog replaced the hand-rolled one
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('deletes nothing when the confirmation is cancelled', async () => {
    seed();
    const confirm = stubConfirm(false);
    render(<StaffView />);
    fireEvent.click(rowFor('Bob Brown'));

    await act(async () => {
      fireEvent.click(screen.getAllByTitle('Delete vacation')[0]);
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteVacation).not.toHaveBeenCalled();
    expect(useAppStore.getState().vacations).toHaveLength(2);
  });

  it('reports a failed delete in the flash notice and keeps the absences', async () => {
    seed();
    stubConfirm(true);
    vi.mocked(deleteVacation).mockRejectedValue(new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<StaffView />);
    fireEvent.click(rowFor('Bob Brown'));

    fireEvent.click(screen.getAllByTitle('Delete vacation')[0]);
    await waitFor(() =>
      expect(useUIStore.getState().flashNotice).toEqual(
        expect.objectContaining({ message: 'Failed to delete the absence: boom', tone: 'error' })
      )
    );
    expect(getVacations).not.toHaveBeenCalled();
    expect(useAppStore.getState().vacations).toHaveLength(2);
    err.mockRestore();
  });

  it('falls back to a plain flash message when the failure has no text', async () => {
    seed();
    stubConfirm(true);
    vi.mocked(deleteVacation).mockRejectedValue('offline');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<StaffView />);
    fireEvent.click(rowFor('Bob Brown'));

    fireEvent.click(screen.getAllByTitle('Delete vacation')[0]);
    await waitFor(() =>
      expect(useUIStore.getState().flashNotice).toEqual(
        expect.objectContaining({ message: 'Failed to delete the absence', tone: 'error' })
      )
    );
    err.mockRestore();
  });
});

describe('StaffView layout', () => {
  it('resizes the panel between 200 and 500 px in standalone mode', () => {
    seed();
    render(<StaffView />);
    const panel = panelOf();
    expect(panel.style.width).toBe('320px');

    const resizer = panel.nextElementSibling as HTMLElement;
    fireEvent.mouseDown(resizer, { clientX: 100 });
    expect(document.body.style.cursor).toBe('col-resize');
    fireEvent.mouseMove(document, { clientX: 1000 });
    expect(panel.style.width).toBe('500px');
    fireEvent.mouseMove(document, { clientX: -1000 });
    expect(panel.style.width).toBe('200px');
    fireEvent.mouseUp(document);
    expect(document.body.style.cursor).toBe('');
  });

  it('reports width changes to the parent when embedded', () => {
    seed();
    const onPanelWidthChange = vi.fn();
    const { container } = render(
      <StaffView embedded panelWidth={304} height={250} onPanelWidthChange={onPanelWidthChange} />
    );
    expect((container.firstChild as HTMLElement).style.height).toBe('250px');
    const panel = panelOf();
    expect(panel.style.width).toBe('300px');

    fireEvent.mouseDown(panel.nextElementSibling as HTMLElement, { clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 50 });
    fireEvent.mouseUp(document);
    expect(onPanelWidthChange).toHaveBeenCalledWith(350);
    expect(panel.style.width).toBe('300px');
  });

  it('toggles the bank-holiday and company-event rows', () => {
    seed();
    useAppStore.setState({
      bankHolidays: [{ id: 1, site_id: 1, date: '2026-08-01', name: 'National Day', is_custom: false }],
    });
    render(<StaffView />);
    expect(screen.queryByText('National Day')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Bank Holidays'));
    expect(screen.getByText('National Day')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Company Events'));
    expect(screen.getByText('No company events')).toBeInTheDocument();
  });
});
