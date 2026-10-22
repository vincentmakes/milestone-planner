/**
 * "My absences" is the self-service entry point for every role, so it must
 * only ever show the signed-in user's own absences, and its delete must go
 * through the API (the backend enforces the own-user rule) and refetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MyAbsencesModal } from '../MyAbsencesModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { deleteVacation, getVacations } from '@/api/endpoints/vacations';
import { formatDateISO } from '@/utils/date';
import type { AbsenceType, Vacation } from '@/types';
import { stubConfirm } from '@/test/confirmDialog';

vi.mock('@/api/endpoints/vacations', () => ({
  deleteVacation: vi.fn().mockResolvedValue(undefined),
  getVacations: vi.fn().mockResolvedValue([]),
  importVacations: vi.fn(),
}));

const TYPES: AbsenceType[] = [
  { id: 1, name: 'Holidays', color: '#8b5cf6', counts_as_unavailable: true, sort_order: 0, is_active: true },
  { id: 2, name: 'Home Office', color: '#0ea5e9', counts_as_unavailable: false, sort_order: 1, is_active: true },
];

const inDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return formatDateISO(d);
};

const VACATIONS: Vacation[] = [
  { id: 1, staff_id: 7, start_date: inDays(10), end_date: inDays(14), description: 'Beach week', absence_type_id: 1 },
  { id: 2, staff_id: 7, start_date: inDays(-20), end_date: inDays(-1), description: '[R:1,3] Remote days', absence_type_id: 2 },
  { id: 3, staff_id: 8, start_date: inDays(2), end_date: inDays(3), description: 'Someone else', absence_type_id: 1 },
  { id: 4, staff_id: 7, start_date: inDays(-200), end_date: inDays(-190), description: 'Long ago', absence_type_id: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    currentUser: {
      id: 7,
      name: 'Una User',
      email: 'una@demo.local',
      first_name: 'Una',
      last_name: 'User',
      role: 'user',
      active: true,
      is_resource: true,
      site_ids: [1],
    },
    vacations: VACATIONS,
    absenceTypes: TYPES,
  });
  useUIStore.setState({ activeModal: 'myAbsences', modalContext: {} });
});

describe('MyAbsencesModal', () => {
  it('lists only the signed-in user\'s upcoming and recent absences', () => {
    render(<MyAbsencesModal />);

    const rows = screen.getAllByTestId('my-absence-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('Beach week')).toBeInTheDocument();
    expect(screen.getByText('Remote days')).toBeInTheDocument();
    expect(screen.getByText('Recurring: Mon, Wed')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Home Office')).toBeInTheDocument();
    expect(screen.queryByText('Someone else')).not.toBeInTheDocument();
    expect(screen.queryByText('Long ago')).not.toBeInTheDocument();
  });

  it('deletes through the API after confirmation and refetches', async () => {
    const confirm = stubConfirm(true);
    vi.mocked(getVacations).mockResolvedValue(VACATIONS.filter((v) => v.id !== 1));
    render(<MyAbsencesModal />);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Delete Holidays ${inDays(10)}`) }));

    await waitFor(() => expect(deleteVacation).toHaveBeenCalledWith(1));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Delete this absence?', destructive: true })
    );
    await waitFor(() => expect(screen.queryByText('Beach week')).not.toBeInTheDocument());
    expect(getVacations).toHaveBeenCalled();
  });

  it('does nothing when the deletion is not confirmed', async () => {
    const confirm = stubConfirm(false);
    render(<MyAbsencesModal />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Delete Holidays ${inDays(10)}`) }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(deleteVacation).not.toHaveBeenCalled();
  });

  it('opens the vacation dialog for edit and add, returning here afterwards', () => {
    render(<MyAbsencesModal />);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Edit Holidays ${inDays(10)}`) }));
    let ui = useUIStore.getState();
    expect(ui.activeModal).toBe('vacation');
    expect(ui.editingVacation?.id).toBe(1);
    expect(ui.modalContext).toMatchObject({ staffId: 7, returnTo: 'myAbsences' });

    // VacationModal closed: back to My absences
    act(() => {
      useUIStore.getState().closeModal();
      useUIStore.getState().openModal('myAbsences');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add absence' }));
    ui = useUIStore.getState();
    expect(ui.activeModal).toBe('vacation');
    expect(ui.editingVacation).toBeNull();
    expect(ui.modalContext).toMatchObject({ staffId: 7, returnTo: 'myAbsences' });
  });


  it('deletes once when Delete is clicked twice before the first delete settles', async () => {
    stubConfirm(true);
    let finish: () => void = () => {};
    vi.mocked(deleteVacation).mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }));
    render(<MyAbsencesModal />);

    const remove = screen.getByRole('button', { name: new RegExp(`^Delete Holidays ${inDays(10)}`) });
    await act(async () => {
      fireEvent.click(remove);
      fireEvent.click(remove);
    });
    expect(deleteVacation).toHaveBeenCalledTimes(1);
    expect(remove).toHaveAttribute('aria-busy', 'true');

    await act(async () => finish());
    await waitFor(() => expect(getVacations).toHaveBeenCalled());
    expect(deleteVacation).toHaveBeenCalledTimes(1);
  });
});
