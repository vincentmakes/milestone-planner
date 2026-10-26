/**
 * Phase / subphase staff bookings in the assignment dialog: "Follow the phase
 * dates" (on = linked, the default for a new booking) or own dates picked
 * inside the card (days outside it disabled). Creates send dates only for an
 * unlinked booking; edits send own dates, or null dates to follow the card
 * again; a refusal shows in place. Someone already on the card gets a second
 * booking the server places: the dialog says so, and sends no dates unless the
 * switch is turned off — also when the Gantt's "Assign me again…" opened it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/api/endpoints/projects', () => ({
  createStaffAssignment: vi.fn().mockResolvedValue({}),
  updateStaffAssignment: vi.fn().mockResolvedValue({ success: true }),
  deleteStaffAssignment: vi.fn().mockResolvedValue({}),
  createEquipmentAssignment: vi.fn().mockResolvedValue({}),
  updateEquipmentAssignment: vi.fn().mockResolvedValue({}),
  deleteEquipmentAssignment: vi.fn().mockResolvedValue({}),
  loadAllProjects: vi.fn().mockResolvedValue([]),
}));

import { AssignmentModal } from '../AssignmentModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { createStaffAssignment, loadAllProjects, updateStaffAssignment } from '@/api/endpoints/projects';
import { dateValue, dayButton, openDateField, pickRange, showMonth } from '@/test/datePicker';
import { makePhase, makeProject, makeSubphase, makeUser } from '@/test/factories';
import type { Project, StaffAssignment } from '@/types';
import { pickOption } from '@/test/searchableSelect';

function buildProject(): Project {
  return makeProject({
    id: 1,
    site_id: 1,
    pm_id: 42,
    start_date: '2026-09-01',
    end_date: '2026-12-31',
    phases: [
      makePhase({
        id: 3,
        name: 'Design',
        start_date: '2026-09-07',
        end_date: '2026-09-18',
        staffAssignments: [
          { id: 9, staff_id: 4, allocation: 40, start_date: '2026-09-07', end_date: '2026-09-18', linked: true },
          { id: 10, staff_id: 7, allocation: 30, start_date: '2026-09-09', end_date: '2026-09-10', linked: false },
        ],
        children: [makeSubphase({ id: 5, name: 'Prototype', start_date: '2026-09-07', end_date: '2026-09-11' })],
      }),
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    projects: [buildProject()],
    currentSite: { id: 1, name: 'Basel' } as never,
    staff: [
      { id: 7, name: 'Alice Anderson', site_id: 1, active: true },
      { id: 4, name: 'Bob Brown', site_id: 1, active: true },
      { id: 8, name: 'Carol Chen', site_id: 1, active: true },
    ] as never,
    currentUser: makeUser({ id: 1, role: 'admin' }),
  });
  useUIStore.setState({ editingStaffAssignment: null });
});

const follow = () => screen.getByRole('switch', { name: 'Follow the phase dates' });

const SECOND_BOOKING =
  'already booked on this phase. The new booking is placed automatically: the second half of a booking that covers the whole phase, or its largest free stretch. Turn off the switch to pick its dates.';

function openNew(context: { phaseId?: number; subphaseId?: number } = { phaseId: 3 }, who = 'Bob Brown') {
  useUIStore.getState().openModal('staffAssignment', { projectId: 1, ...context });
  render(<AssignmentModal mode="staff" />);
  pickOption(/^Staff Member/, who);
}

function openEdit(row: StaffAssignment) {
  useUIStore.setState({ editingStaffAssignment: { ...row, project_id: 1, phase_id: 3, subphase_id: null } });
  useUIStore.getState().openModal('staffAssignment', { projectId: 1, phaseId: 3 });
  render(<AssignmentModal mode="staff" />);
}

describe('AssignmentModal: new phase booking', () => {
  it('follows the phase by default and sends no dates', async () => {
    openNew(undefined, 'Carol Chen');
    expect(follow()).toBeChecked();
    expect(screen.getByText(/uses the phase's dates automatically/)).toBeInTheDocument();
    expect(screen.queryByText(/already booked on this phase/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Start Date *')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Assign Staff' }));

    await waitFor(() => expect(createStaffAssignment).toHaveBeenCalled());
    const body = vi.mocked(createStaffAssignment).mock.calls[0][0];
    expect(body).toMatchObject({ staff_id: 8, phase_id: 3, project_id: 1 });
    expect(body).not.toHaveProperty('start_date');
    expect(body).not.toHaveProperty('end_date');
  });

  it('with own dates: the fields start on the card, are bounded by it and the dates are sent', async () => {
    openNew();
    fireEvent.click(follow());
    expect(follow()).not.toBeChecked();
    expect(screen.queryByText(/uses the phase's dates automatically/)).not.toBeInTheDocument();
    expect(dateValue('Start Date *')).toBe('2026-09-07');
    expect(dateValue('End Date *')).toBe('2026-09-18');

    // Days outside the phase cannot be picked
    const panel = openDateField('Start Date *');
    showMonth(panel, '2026-09-01');
    expect(dayButton(panel, '2026-09-04')).toBeDisabled();
    expect(dayButton(panel, '2026-09-21')).toBeDisabled();
    expect(dayButton(panel, '2026-09-08')).not.toBeDisabled();
    fireEvent.keyDown(panel, { key: 'Escape' });

    pickRange('Start Date *', '2026-09-08', '2026-09-10');
    fireEvent.click(screen.getByRole('button', { name: 'Assign Staff' }));

    await waitFor(() => expect(createStaffAssignment).toHaveBeenCalled());
    expect(vi.mocked(createStaffAssignment).mock.calls[0][0]).toMatchObject({
      staff_id: 4,
      phase_id: 3,
      start_date: '2026-09-08',
      end_date: '2026-09-10',
    });
  });

  it('restarts own dates on the card when it moved meanwhile', () => {
    openNew();
    // A colleague moves the phase while the dialog is open
    act(() => {
      const project = buildProject();
      project.phases[0].start_date = '2026-09-21';
      project.phases[0].end_date = '2026-09-25';
      useAppStore.setState({ projects: [project] });
    });
    fireEvent.click(follow());
    expect(dateValue('Start Date *')).toBe('2026-09-21');
    expect(dateValue('End Date *')).toBe('2026-09-25');
  });

  it('books someone already on the phase again without dates, and shows a refused placement in place', async () => {
    const CARD_FULL = "This person's bookings already cover the whole card — shorten one of them first";
    vi.mocked(createStaffAssignment).mockRejectedValueOnce(new Error(CARD_FULL));
    // Bob (4) already holds a linked booking on the phase: the dialog still
    // offers him, says the server places the second one (or here refuses it).
    openNew();
    expect(screen.getByText(`This person is ${SECOND_BOOKING}`)).toBeInTheDocument();
    expect(screen.queryByText(/uses the phase's dates automatically/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Assign Staff' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(CARD_FULL);
    const body = vi.mocked(createStaffAssignment).mock.calls[0][0];
    expect(body).toMatchObject({ staff_id: 4, phase_id: 3 });
    expect(body).not.toHaveProperty('start_date');
    expect(useUIStore.getState().activeModal).toBe('staffAssignment');
  });

  it('names the subphase on a subphase booking', () => {
    openNew({ phaseId: 3, subphaseId: 5 });
    fireEvent.click(screen.getByRole('switch', { name: 'Follow the subphase dates' }));
    expect(dateValue('Start Date *')).toBe('2026-09-07');
    expect(dateValue('End Date *')).toBe('2026-09-11');
  });
});

describe('AssignmentModal: my own second booking ("Assign me again…")', () => {
  // Bob (4) books his own time and already holds a booking on the phase.
  function openMine() {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user', max_capacity: 70 }) });
    useUIStore.getState().openModal('staffAssignment', { projectId: 1, phaseId: 3, staffId: 4 });
    render(<AssignmentModal mode="staff" />);
  }

  it('is fixed to me, says the booking is placed, and sends no dates untouched', async () => {
    openMine();
    expect(screen.getByLabelText('Staff Member')).toHaveValue('You');
    expect(screen.getByText(`You are ${SECOND_BOOKING}`)).toBeInTheDocument();
    expect(follow()).toBeChecked();
    expect(screen.queryByLabelText('Start Date *')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Assign me' }));

    await waitFor(() => expect(createStaffAssignment).toHaveBeenCalled());
    const body = vi.mocked(createStaffAssignment).mock.calls[0][0];
    expect(body).toEqual({ staff_id: 4, allocation: 70, project_id: 1, phase_id: 3, subphase_id: undefined });
    await waitFor(() => expect(useUIStore.getState().activeModal).toBeNull());
  });

  it('sends both dates with the switch off, and shows a refused placement with the dialog still open', async () => {
    const OVERLAP = 'This person is already booked on this card for overlapping dates';
    vi.mocked(createStaffAssignment).mockRejectedValueOnce(new Error(OVERLAP));
    openMine();
    fireEvent.click(follow());
    expect(screen.queryByText(`You are ${SECOND_BOOKING}`)).not.toBeInTheDocument();
    expect(dateValue('Start Date *')).toBe('2026-09-07');
    expect(dateValue('End Date *')).toBe('2026-09-18');

    fireEvent.click(screen.getByRole('button', { name: 'Assign me' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(OVERLAP);
    expect(vi.mocked(createStaffAssignment).mock.calls[0][0]).toMatchObject({
      staff_id: 4,
      start_date: '2026-09-07',
      end_date: '2026-09-18',
    });
    expect(useUIStore.getState().activeModal).toBe('staffAssignment');
  });
});

describe('AssignmentModal: editing a phase booking', () => {
  it('keeps a linked booking linked: only the allocation is sent', async () => {
    openEdit(buildProject().phases[0].staffAssignments[0]);
    expect(follow()).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateStaffAssignment).toHaveBeenCalledWith(9, { allocation: 40 }, 'phase'));
  });

  it('gives a linked booking its own dates', async () => {
    vi.mocked(loadAllProjects).mockImplementationOnce(async () => useAppStore.getState().projects);
    openEdit(buildProject().phases[0].staffAssignments[0]);
    fireEvent.click(follow());
    pickRange('Start Date *', '2026-09-14', '2026-09-16');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(updateStaffAssignment).toHaveBeenCalledWith(
        9,
        { allocation: 40, start_date: '2026-09-14', end_date: '2026-09-16' },
        'phase'
      )
    );
    // Shown right away (the reload is a no-op in What-If)
    expect(useAppStore.getState().projects[0].phases[0].staffAssignments[0]).toMatchObject({
      linked: false,
      start_date: '2026-09-14',
      end_date: '2026-09-16',
    });
  });

  it('opens an unlinked booking on its own dates and relinks it with null dates', async () => {
    vi.mocked(loadAllProjects).mockImplementationOnce(async () => useAppStore.getState().projects);
    openEdit(buildProject().phases[0].staffAssignments[1]);
    expect(follow()).not.toBeChecked();
    expect(dateValue('Start Date *')).toBe('2026-09-09');
    expect(dateValue('End Date *')).toBe('2026-09-10');

    fireEvent.click(follow());
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(updateStaffAssignment).toHaveBeenCalledWith(10, { allocation: 30, start_date: null, end_date: null }, 'phase')
    );
    await waitFor(() =>
      expect(useAppStore.getState().projects[0].phases[0].staffAssignments[1]).toMatchObject({
        linked: true,
        start_date: '2026-09-07',
        end_date: '2026-09-18',
      })
    );
  });

  it('shows a refusal in place', async () => {
    vi.mocked(updateStaffAssignment).mockRejectedValueOnce(
      new Error('This person is already booked on this card for overlapping dates')
    );
    openEdit(buildProject().phases[0].staffAssignments[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This person is already booked on this card for overlapping dates'
    );
    expect(useUIStore.getState().activeModal).toBe('staffAssignment');
  });
});
