/**
 * The card badge on a phase / subphase booking row holds two controls. The
 * pin toggles between following the card's dates (PinIcon, linked) and own
 * dates inside it (PinOffIcon, unlinked) for whoever may change the booking,
 * and stays in place, disabled, for anyone else and on a pending booking. An
 * unlink starts from the card's dates, a relink sends null dates; a 202 files
 * a request instead, a failure reloads and says why. The card name scrolls
 * the timeline to the booking: its own start when unlinked, the card's start
 * when linked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/api/endpoints/projects', () => ({
  updateStaffAssignment: vi.fn(async () => ({ success: true })),
  loadAllProjects: vi.fn(async () => []),
}));
vi.mock('@/api/endpoints/roles', () => ({
  rolesApi: { getAll: vi.fn(() => new Promise(() => {})), getApprovalPolicies: vi.fn(() => new Promise(() => {})) },
}));

import { AssignmentRow } from '../AssignmentRow';
import { resetAllStores, useAppStore, useUIStore, useUndoStore } from '@/stores';
import { loadAllProjects, updateStaffAssignment } from '@/api/endpoints/projects';
import { makePhase, makeProject, makeSubphase, makeUser } from '@/test/factories';
import type { AssignmentApproval, Project } from '@/types';

function buildProject(): Project {
  return makeProject({
    id: 1,
    pm_id: 12,
    phases: [
      makePhase({
        id: 3,
        start_date: '2026-03-02',
        end_date: '2026-03-13',
        staffAssignments: [
          { id: 9, staff_id: 4, allocation: 40, start_date: '2026-03-02', end_date: '2026-03-13', linked: true },
        ],
        children: [
          makeSubphase({
            id: 5,
            start_date: '2026-03-02',
            end_date: '2026-03-06',
            staffAssignments: [
              { id: 9, staff_id: 4, allocation: 20, start_date: '2026-03-03', end_date: '2026-03-04', linked: false },
            ],
          }),
        ],
      }),
    ],
  });
}

const rowAt = (level: 'phase' | 'subphase') => {
  const phase = useAppStore.getState().projects[0].phases[0];
  return level === 'phase' ? phase.staffAssignments[0] : phase.children[0].staffAssignments[0];
};

function renderPhaseRow(props: Partial<React.ComponentProps<typeof AssignmentRow>> = {}) {
  return render(
    <AssignmentRow
      type="phase-staff"
      assignmentId={9}
      projectId={1}
      phaseId={3}
      staffId={4}
      name="Bob Brown"
      allocation={40}
      depth={1}
      phaseType="Design"
      startDate="2026-03-02"
      endDate="2026-03-13"
      linked
      cardStartDate="2026-03-02T00:00:00.000Z"
      cardEndDate="2026-03-13"
      {...props}
    />
  );
}

const pin = () => screen.getByRole('button', { name: 'Own dates for Bob Brown' });
const cardName = (name = 'Design') => screen.getByRole('button', { name });
const LINKED_ICON = '[data-testid="PushPinIcon"]';
const UNLINKED_ICON = '[data-testid="PushPinOutlinedIcon"]';

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  useAppStore.setState({
    projects: [buildProject()],
    currentUser: makeUser({ id: 1, role: 'admin' }),
    approvalPolicies: [],
    roles: [],
  });
});

describe('AssignmentRow pin', () => {
  it('unlinks a linked booking with the card dates, at its level', async () => {
    renderPhaseRow();
    expect(pin()).toHaveAttribute('aria-pressed', 'false');
    expect(pin()).toHaveAttribute('title', 'Follows the phase dates — click to give it its own dates');
    expect(pin().querySelector(LINKED_ICON)).not.toBeNull();
    expect(pin()).toBeEnabled();
    expect(cardName()).toHaveAttribute('title', 'Scroll to this booking');

    fireEvent.click(pin());

    expect(updateStaffAssignment).toHaveBeenCalledWith(9, { start_date: '2026-03-02', end_date: '2026-03-13' }, 'phase');
    // Optimistic: the row has its own dates now; undo can take it back
    expect(rowAt('phase')).toMatchObject({ linked: false, start_date: '2026-03-02', end_date: '2026-03-13' });
    expect(useUndoStore.getState().canUndo).toBe(true);
    // The other level's row with the same id is untouched
    expect(rowAt('subphase').linked).toBe(false);
    await waitFor(() => expect(useUIStore.getState().flashNotice).toBeNull());
  });

  it('relinks an unlinked subphase booking with null dates', () => {
    render(
      <AssignmentRow
        type="subphase-staff"
        assignmentId={9}
        projectId={1}
        phaseId={3}
        subphaseId={5}
        staffId={4}
        name="Bob Brown"
        allocation={20}
        depth={2}
        startDate="2026-03-03"
        endDate="2026-03-04"
        linked={false}
        cardStartDate="2026-03-02"
        cardEndDate="2026-03-06"
      />
    );
    expect(pin()).toHaveAttribute('aria-pressed', 'true');
    expect(pin()).toHaveAttribute('title', 'Own dates — click to follow the subphase dates again');
    expect(pin().querySelector(UNLINKED_ICON)).not.toBeNull();
    expect(cardName('Subphase')).toBeInTheDocument();

    fireEvent.click(pin());

    expect(updateStaffAssignment).toHaveBeenCalledWith(9, { start_date: null, end_date: null }, 'subphase');
    expect(rowAt('subphase')).toMatchObject({ linked: true, start_date: '2026-03-02', end_date: '2026-03-06' });
  });

  it('keeps a disabled pin for someone who may not change the booking', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 2, role: 'user' }) });
    renderPhaseRow();
    expect(pin()).toBeDisabled();
    expect(pin()).toHaveAttribute('title', 'Follows the phase dates');
    expect(pin().querySelector(LINKED_ICON)).not.toBeNull();
    fireEvent.click(pin());
    expect(updateStaffAssignment).not.toHaveBeenCalled();
    // The card name still scrolls
    expect(cardName()).toBeEnabled();
  });

  it('keeps a disabled pin on a pending booking and on one with my own request open', () => {
    const request: AssignmentApproval = {
      request_id: 31,
      action: 'assignments.self_update',
      requester_id: 1,
      requested: { allocation: 60 },
      previous: { allocation: 40 },
      created_at: null,
      can_decide: false,
    };
    const { unmount } = renderPhaseRow({ approvalStatus: 'pending', linked: false });
    expect(pin()).toBeDisabled();
    expect(pin()).toHaveAttribute('title', 'Own dates');
    expect(pin().querySelector(UNLINKED_ICON)).not.toBeNull();
    unmount();
    renderPhaseRow({ approval: request });
    expect(pin()).toBeDisabled();
    fireEvent.click(pin());
    expect(updateStaffAssignment).not.toHaveBeenCalled();
  });

  it("scrolls to an unlinked booking's own start from the card name", () => {
    renderPhaseRow({ linked: false, startDate: '2026-03-09T00:00:00.000Z', endDate: '2026-03-11' });
    fireEvent.click(cardName());
    expect(useUIStore.getState().scrollToDateTrigger?.date).toBe('2026-03-09');
    expect(updateStaffAssignment).not.toHaveBeenCalled();
  });

  it("scrolls to the card's start for a linked booking", () => {
    renderPhaseRow({ startDate: '2026-03-05', cardStartDate: '2026-03-02T00:00:00.000Z' });
    fireEvent.click(cardName());
    expect(useUIStore.getState().scrollToDateTrigger?.date).toBe('2026-03-02');
  });

  it('does not scroll when the pin is clicked, and neither click reaches the row', () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <AssignmentRow
          type="phase-staff"
          assignmentId={9}
          projectId={1}
          phaseId={3}
          staffId={4}
          name="Bob Brown"
          depth={1}
          phaseType="Design"
          linked
          cardStartDate="2026-03-02"
          cardEndDate="2026-03-13"
        />
      </div>
    );
    fireEvent.click(pin());
    expect(useUIStore.getState().scrollToDateTrigger).toBeNull();
    fireEvent.click(cardName());
    expect(useUIStore.getState().scrollToDateTrigger?.date).toBe('2026-03-02');
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('opens the row menu on a right-click on the badge', () => {
    renderPhaseRow();
    fireEvent.contextMenu(cardName());
    expect(useUIStore.getState().contextMenu).toMatchObject({ visible: true, type: 'staffAssignment', targetId: 9 });
  });

  it('files a request on a 202: the row keeps its dates and shows the open change', async () => {
    vi.mocked(updateStaffAssignment).mockResolvedValueOnce({ success: true, pending: true, request_id: 44, id: 9 });
    renderPhaseRow();

    fireEvent.click(pin());

    await waitFor(() => expect(useUIStore.getState().flashNotice?.message).toBe('Sent for approval'));
    expect(rowAt('phase')).toMatchObject({
      linked: true,
      approval: expect.objectContaining({
        request_id: 44,
        action: 'assignments.self_update',
        requested: { start_date: '2026-03-02', end_date: '2026-03-13' },
      }),
    });
  });

  it('reloads and says why when the server refuses it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(updateStaffAssignment).mockRejectedValueOnce(
      new Error('This person is already booked on this card for overlapping dates')
    );
    const server = buildProject();
    vi.mocked(loadAllProjects).mockResolvedValueOnce([server]);
    renderPhaseRow();

    fireEvent.click(pin());

    await waitFor(() =>
      expect(useUIStore.getState().flashNotice?.message).toBe(
        'This person is already booked on this card for overlapping dates'
      )
    );
    await waitFor(() => expect(useAppStore.getState().projects).toEqual([server]));
    expect(useUndoStore.getState().canUndo).toBe(false);
  });

  it('hands the context menu the booking dates and its linked state', () => {
    const { container } = renderPhaseRow({ linked: false, startDate: '2026-03-04', endDate: '2026-03-05' });
    fireEvent.contextMenu(container.firstElementChild!);
    expect(useUIStore.getState().contextMenu.assignmentData).toMatchObject({
      startDate: '2026-03-04',
      endDate: '2026-03-05',
      linked: false,
    });
  });
});
