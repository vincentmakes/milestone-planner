/**
 * Staff overview: the left panel lists the site's active staff with today's
 * availability, a role/skill filter, expandable rows (absences + assignments
 * collected from every level of the project tree) and a delete confirmation
 * for absences.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { StaffView } from '../StaffView';
import { resetAllStores, useAppStore, useUIStore } from '@/stores';
import { deleteVacation, getVacations } from '@/api/endpoints/vacations';
import { formatDateISO } from '@/utils/date';
import {
  makePhase,
  makeProject,
  makeSite,
  makeStaff,
  makeSubphase,
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
    vi.mocked(deleteVacation).mockResolvedValue(undefined as never);
    vi.mocked(getVacations).mockResolvedValue([]);
    render(<StaffView />);
    fireEvent.click(rowFor('Bob Brown'));

    fireEvent.click(screen.getAllByTitle('Delete vacation')[0]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Ski trip')).toBeInTheDocument();
    expect(within(dialog).getByText('Bob Brown')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deleteVacation).toHaveBeenCalledWith(61);
    expect(useAppStore.getState().vacations).toEqual([]);
  });

  it('keeps the confirmation open when the delete fails, and cancels via the button or Escape', async () => {
    seed();
    vi.mocked(deleteVacation).mockRejectedValue(new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<StaffView />);
    fireEvent.click(rowFor('Bob Brown'));

    fireEvent.click(screen.getAllByTitle('Delete vacation')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(useAppStore.getState().vacations).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByTitle('Delete vacation')[1]);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
