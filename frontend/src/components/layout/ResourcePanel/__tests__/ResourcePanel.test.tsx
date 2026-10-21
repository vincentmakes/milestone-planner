/**
 * Resource panel: staff/equipment tabs, site filtering, today's availability
 * per card (assignments, absences, equipment bookings/blocks) and who may drag
 * a card onto the Gantt (managers anything, everyone else only themselves).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ResourcePanel } from '../ResourcePanel';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useViewStore } from '@/stores/viewStore';
import { resetAllStores } from '@/stores';
import { formatDateISO } from '@/utils/date';
import {
  makeEquipment,
  makePhase,
  makeProject,
  makeSite,
  makeStaff,
  makeSubphase,
  makeTeam,
  makeUser,
  makeVacation,
} from '@/test/factories';
import type { StaffAssignment } from '@/types';
import { tagFilterKey } from '@/utils/tags';
import { USER_DEFAULTS } from '@/test/permissionFixtures';

const today = formatDateISO(new Date());
const assignment = (staffId: number, allocation: number): StaffAssignment => ({
  id: staffId * 10 + allocation,
  staff_id: staffId,
  allocation,
  start_date: today,
  end_date: today,
});

function card(name: string) {
  return screen.getByText(name).closest('[draggable]') as HTMLElement;
}

beforeEach(() => {
  resetAllStores();
  useViewStore.getState().resetView();
  useAppStore.setState({
    currentSite: makeSite({ id: 1 }),
    currentUser: makeUser({ id: 1, role: 'admin' }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResourcePanel', () => {
  it('lists active staff of the current site and switches to equipment', async () => {
    useAppStore.setState({
      staff: [
        makeStaff({ id: 4, name: 'Bob Brown', role: 'Scientist' }),
        makeStaff({ id: 5, name: 'Off Site', site_id: 2 }),
        makeStaff({ id: 6, name: 'Former', active: false }),
        makeStaff({ id: 7, name: 'No Role', role: '' }),
      ],
      equipment: [makeEquipment({ id: 1, name: 'Bioreactor 50L' }), makeEquipment({ id: 2, name: 'HPLC', type: '' })],
    });
    render(<ResourcePanel />);
    expect(screen.getByRole('heading', { name: 'Resources' })).toBeInTheDocument();
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
    expect(screen.getByText('Scientist')).toBeInTheDocument();
    expect(screen.getByText('No role')).toBeInTheDocument();
    expect(screen.queryByText('Off Site')).not.toBeInTheDocument();
    expect(screen.queryByText('Former')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Equipment' }));
    expect(useViewStore.getState().currentResourceTab).toBe('equipment');
    expect(screen.getByText('Bioreactor 50L')).toBeInTheDocument();
    expect(screen.getByText('No type')).toBeInTheDocument();
    expect(screen.queryByText('Bob Brown')).not.toBeInTheDocument();
  });

  it('shows an empty state per tab', async () => {
    render(<ResourcePanel />);
    expect(screen.getByText('No staff found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Equipment' }));
    expect(screen.getByText('No equipment found')).toBeInTheDocument();
  });

  it('collapses and expands', async () => {
    render(<ResourcePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }));
    expect(useViewStore.getState().resourcePanelCollapsed).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }));
    expect(useViewStore.getState().resourcePanelCollapsed).toBe(false);
  });

  it("sums today's allocations at every level into the remaining availability", () => {
    const sub = makeSubphase({
      start_date: today,
      end_date: today,
      staffAssignments: [assignment(4, 10)],
      children: [makeSubphase({ id: 2, start_date: today, end_date: today, staffAssignments: [assignment(4, 5)] })],
    });
    const phase = makePhase({ start_date: today, end_date: today, staffAssignments: [assignment(4, 20)], children: [sub] });
    useAppStore.setState({
      staff: [makeStaff({ id: 4, name: 'Bob Brown' }), makeStaff({ id: 8, name: 'Full Time', max_capacity: 60 })],
      projects: [
        makeProject({
          staffAssignments: [assignment(4, 30), { ...assignment(4, 50), start_date: '2000-01-01', end_date: '2000-01-02' }],
          phases: [phase],
        }),
        makeProject({ id: 2, staffAssignments: [assignment(8, 60)] }),
      ],
    });
    render(<ResourcePanel />);
    expect(card('Bob Brown')).toHaveTextContent('35%');
    expect(card('Full Time')).toHaveTextContent('40%');
  });

  it("leaves bookings awaiting approval out of today's availability", () => {
    const sub = makeSubphase({
      start_date: today,
      end_date: today,
      staffAssignments: [{ ...assignment(4, 10), approval_status: 'pending' }],
    });
    const phase = makePhase({
      start_date: today,
      end_date: today,
      staffAssignments: [{ ...assignment(4, 20), approval_status: 'pending' }],
      children: [sub],
    });
    useAppStore.setState({
      staff: [makeStaff({ id: 4, name: 'Bob Brown' })],
      projects: [
        makeProject({
          staffAssignments: [assignment(4, 30), { ...assignment(4, 50), approval_status: 'pending' }],
          phases: [phase],
        }),
      ],
    });
    render(<ResourcePanel />);
    // Only the approved 30 % counts.
    expect(card('Bob Brown')).toHaveTextContent('70%');
  });

  it('does not let a user without assignments.self_create drag their own card', () => {
    useAppStore.setState({
      currentUser: makeUser({
        id: 4,
        role: 'user',
        permissions: USER_DEFAULTS.filter((k) => k !== 'assignments.self_create'),
      }),
      staff: [makeStaff({ id: 4, name: 'Bob Brown' })],
    });
    render(<ResourcePanel />);
    expect(card('Bob Brown')).toHaveAttribute('draggable', 'false');
  });

  it('lets a user whose own bookings need approval drag their own card', () => {
    useAppStore.setState({
      currentUser: makeUser({
        id: 4,
        role: 'user',
        permissions: USER_DEFAULTS.filter((k) => k !== 'assignments.self_create'),
        approval_required: ['assignments.self_create'],
      }),
      staff: [makeStaff({ id: 4, name: 'Bob Brown' })],
    });
    render(<ResourcePanel />);
    expect(card('Bob Brown')).toHaveAttribute('draggable', 'true');
  });

  it('shows over-allocated staff as negative availability', () => {
    useAppStore.setState({
      staff: [makeStaff({ id: 4, name: 'Bob Brown' })],
      projects: [makeProject({ staffAssignments: [assignment(4, 80), { ...assignment(4, 40), id: 99 }] })],
    });
    render(<ResourcePanel />);
    expect(card('Bob Brown')).toHaveTextContent('-20%');
  });

  it('treats staff on vacation today as fully booked', () => {
    useAppStore.setState({
      staff: [makeStaff({ id: 4, name: 'Bob Brown' })],
      vacations: [makeVacation({ staff_id: 4, start_date: today, end_date: today })],
    });
    render(<ResourcePanel />);
    expect(card('Bob Brown')).toHaveTextContent('0%');
  });

  it('marks equipment booked today as unavailable and flags overlaps', async () => {
    useViewStore.setState({ currentResourceTab: 'equipment' });
    useAppStore.setState({
      equipment: [makeEquipment({ id: 1, name: 'Bioreactor 50L' }), makeEquipment({ id: 2, name: 'HPLC' })],
      projects: [
        makeProject({
          equipmentAssignments: [
            { id: 1, equipment_id: 1, start_date: today, end_date: today },
            { id: 2, equipment_id: 1, start_date: today, end_date: today },
          ],
        }),
      ],
    });
    render(<ResourcePanel />);
    expect(card('Bioreactor 50L')).toHaveTextContent('0%');
    expect(card('HPLC')).toHaveTextContent('100%');
    expect(screen.getByTitle('This equipment has overlapping bookings or blocks')).toBeInTheDocument();
  });

  it('lets managers drag any card and starts a resource drag', () => {
    useAppStore.setState({ staff: [makeStaff({ id: 4, name: 'Bob Brown' })] });
    render(<ResourcePanel />);
    const el = card('Bob Brown');
    expect(el).toHaveAttribute('draggable', 'true');
    const setData = vi.fn();
    fireEvent.dragStart(el, { dataTransfer: { setData, effectAllowed: '' } });
    expect(setData).toHaveBeenCalledWith(
      'application/json',
      JSON.stringify({ type: 'staff', resourceId: 4, resourceName: 'Bob Brown' })
    );
    expect(useUIStore.getState().resourceDrag).toMatchObject({ active: true, type: 'staff', resourceId: 4 });
    fireEvent.dragEnd(el);
    expect(useUIStore.getState().resourceDrag.active).toBe(false);
  });

  it('lets a regular user drag only their own card', () => {
    useAppStore.setState({
      currentUser: makeUser({ id: 4, role: 'user' }),
      staff: [makeStaff({ id: 4, name: 'Bob Brown' }), makeStaff({ id: 5, name: 'Carol Chen' })],
    });
    render(<ResourcePanel />);
    expect(card('Bob Brown')).toHaveAttribute('draggable', 'true');
    expect(card('Carol Chen')).toHaveAttribute('draggable', 'false');
  });

  it('with an active team filter, hides non-matching staff and equipment and keeps matching ones', () => {
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1 }), makeTeam({ id: 2, site_id: 1, name: 'Process' })],
      staff: [
        makeStaff({ id: 4, name: 'Bob Brown', team_ids: [1] }),
        makeStaff({ id: 5, name: 'Carol White', team_ids: [2] }),
      ],
      equipment: [
        makeEquipment({ id: 1, name: 'Bioreactor 50L', team_ids: [1] }),
        makeEquipment({ id: 2, name: 'HPLC', team_ids: [2] }),
      ],
    });
    useViewStore.setState({ teamFilters: { [tagFilterKey(1)]: { teamIds: [1], noTeam: false } } });
    render(<ResourcePanel />);
    expect(screen.getByText('Bob Brown')).toBeInTheDocument();
    expect(screen.queryByText('Carol White')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Equipment' }));
    expect(screen.getByText('Bioreactor 50L')).toBeInTheDocument();
    expect(screen.queryByText('HPLC')).not.toBeInTheDocument();
  });

  it('applies a team-restricted closure to team members only, a whole-site closure to everyone', () => {
    useAppStore.setState({
      teams: [makeTeam({ id: 1, site_id: 1 }), makeTeam({ id: 2, site_id: 1, name: 'Process' })],
      staff: [
        makeStaff({ id: 4, name: 'Bob Brown', team_ids: [1] }),
        makeStaff({ id: 5, name: 'Carol White', team_ids: [2] }),
        makeStaff({ id: 6, name: 'Dave Doe', team_ids: [] }),
      ],
    });
    const event = { id: 3, site_id: 1, site_ids: [1], date: today, name: 'Team offsite', counts_as_unavailable: true };
    act(() => useAppStore.getState().setCompanyEvents([{ ...event, team_ids: [1] }], new Set([today])));
    render(<ResourcePanel />);
    expect(within(card('Bob Brown')).getByText('0%')).toBeInTheDocument();
    // Same site, not in the team
    expect(within(card('Carol White')).getByText('100%')).toBeInTheDocument();
    expect(within(card('Dave Doe')).getByText('100%')).toBeInTheDocument();

    act(() => useAppStore.getState().setCompanyEvents([{ ...event, team_ids: [] }], new Set([today])));
    for (const name of ['Bob Brown', 'Carol White', 'Dave Doe']) {
      expect(within(card(name)).getByText('0%')).toBeInTheDocument();
    }
  });
});
