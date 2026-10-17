/**
 * Absences and equipment blocks in What-If mode.
 *
 * They are not part of the What-If snapshot: a create would only be queued,
 * the follow-up GET is real so nothing appears, and the row would be created
 * for real on Apply. Creating is therefore blocked with the same message as
 * the other create dialogs; editing stays allowed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { VacationModal } from '../VacationModal';
import { MyAbsencesModal } from '../MyAbsencesModal';
import { EquipmentBlockModal } from '../EquipmentBlockModal';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import type { AbsenceType, EquipmentBlock, Vacation } from '@/types';

const vacationsApi = vi.hoisted(() => ({
  createVacation: vi.fn(),
  updateVacation: vi.fn(),
  deleteVacation: vi.fn(),
  getVacations: vi.fn(),
  importVacations: vi.fn(),
}));
vi.mock('@/api/endpoints/vacations', () => vacationsApi);

const blocksApi = vi.hoisted(() => ({
  createEquipmentBlock: vi.fn(),
  updateEquipmentBlock: vi.fn(),
  deleteEquipmentBlock: vi.fn(),
  getEquipmentBlocks: vi.fn(),
}));
vi.mock('@/api', () => blocksApi);

const BLOCKED = /is unavailable while What-If mode is active\. Apply or discard your What-If changes first\./;

const TYPES: AbsenceType[] = [
  { id: 1, name: 'Holidays', color: '#8b5cf6', counts_as_unavailable: true, sort_order: 0, is_active: true },
];

const vacation: Vacation = {
  id: 3,
  staff_id: 7,
  start_date: '2026-08-10',
  end_date: '2026-08-14',
  description: 'Beach week',
  absence_type_id: 1,
};

const block: EquipmentBlock = {
  id: 4,
  equipment_id: 11,
  start_date: '2026-08-10',
  end_date: '2026-08-12',
  reason: 'maintenance',
  description: 'Maintenance',
};

beforeEach(() => {
  for (const fn of [...Object.values(vacationsApi), ...Object.values(blocksApi)]) fn.mockReset();
  vacationsApi.getVacations.mockResolvedValue([]);
  vacationsApi.updateVacation.mockResolvedValue({});
  blocksApi.getEquipmentBlocks.mockResolvedValue([]);
  blocksApi.updateEquipmentBlock.mockResolvedValue({});
  act(() => useUIStore.getState().closeModal());
  useAppStore.setState({
    currentUser: {
      id: 7,
      name: 'Una User',
      email: 'una@demo.local',
      first_name: 'Una',
      last_name: 'User',
      role: 'admin',
      active: true,
      site_ids: [1],
    },
    staff: [],
    vacations: [],
    absenceTypes: TYPES,
    currentSite: { id: 1, name: 'Basel' } as never,
    equipment: [{ id: 11, name: 'HPLC 1', type: 'Analytical Device', site_id: 1, active: true }] as never,
  });
  useWhatIfStore.setState({ whatIfMode: true });
});

describe('VacationModal in What-If mode', () => {
  it('blocks adding an absence', () => {
    act(() => useUIStore.getState().openVacationModal(undefined, 7));
    render(<VacationModal />);

    expect(screen.getByRole('status')).toHaveTextContent(BLOCKED);
    expect(screen.getByRole('status')).toHaveTextContent(/^Adding absences/);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save & Export/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(vacationsApi.createVacation).not.toHaveBeenCalled();
  });

  it('still allows editing an absence', async () => {
    act(() => useUIStore.getState().openVacationModal(vacation, 7));
    render(<VacationModal />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vacationsApi.updateVacation).toHaveBeenCalledWith(3, expect.any(Object)));
  });

  it('allows adding again once What-If ends', () => {
    useWhatIfStore.setState({ whatIfMode: false });
    act(() => useUIStore.getState().openVacationModal(undefined, 7));
    render(<VacationModal />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

describe('MyAbsencesModal in What-If mode', () => {
  it('disables "Add absence" and says why', () => {
    act(() => useUIStore.getState().openModal('myAbsences'));
    render(<MyAbsencesModal />);

    const add = screen.getByRole('button', { name: 'Add absence' });
    expect(add).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(BLOCKED);
    fireEvent.click(add);
    expect(useUIStore.getState().activeModal).toBe('myAbsences');
  });
});

describe('EquipmentBlockModal in What-If mode', () => {
  it('blocks creating a block', () => {
    act(() => useUIStore.getState().openEquipmentBlockModal(undefined, 11));
    render(<EquipmentBlockModal />);

    expect(screen.getByRole('status')).toHaveTextContent(/^Blocking equipment/);
    const save = screen.getByRole('button', { name: 'Block Equipment' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(blocksApi.createEquipmentBlock).not.toHaveBeenCalled();
  });

  it('still allows editing a block', async () => {
    act(() => useUIStore.getState().openEquipmentBlockModal(block, 11));
    render(<EquipmentBlockModal />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // Shared Input / Select fields, reachable through their visible labels
    const equipment = screen.getByLabelText('Equipment') as HTMLSelectElement;
    expect(equipment).toBeDisabled();
    expect(equipment.value).toBe('11');
    expect(Array.from(equipment.options).map((o) => o.text)).toEqual(['Select equipment…', 'HPLC 1 (Analytical Device)']);
    expect(screen.getByLabelText('Reason')).toHaveValue('maintenance');
    expect(screen.getByLabelText('Start Date')).toHaveValue('2026-08-10');
    expect(screen.getByLabelText('End Date')).toHaveValue('2026-08-12');
    expect(screen.getByLabelText('Description')).toHaveValue('Maintenance');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(blocksApi.updateEquipmentBlock).toHaveBeenCalledWith(4, expect.any(Object)));
  });
});
