/**
 * Settings › Absence types: a changed inline edit or a typed new type name is
 * unsaved input for the Settings hub; Enter pressed twice adds one type.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AbsenceTypesPanel } from '../panels/AbsenceTypesPanel';
import { stubConfirm } from '@/test/confirmDialog';
import type { AbsenceType } from '@/types';

const absenceTypesApi = vi.hoisted(() => ({
  getAll: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  reorder: vi.fn(),
}));
vi.mock('@/api', () => ({ absenceTypesApi }));

const TYPES: AbsenceType[] = [
  { id: 1, name: 'Holidays', color: '#8b5cf6', counts_as_unavailable: true, sort_order: 0, is_active: true },
  { id: 2, name: 'Home Office', color: '#0ea5e9', counts_as_unavailable: false, sort_order: 1, is_active: true },
];

beforeEach(() => {
  for (const fn of Object.values(absenceTypesApi)) fn.mockReset();
  absenceTypesApi.getAll.mockResolvedValue(TYPES);
});

describe('AbsenceTypesPanel', () => {
  it('reports a changed inline edit as unsaved, and a cancelled one as clean', async () => {
    const onDirtyChange = vi.fn();
    render(<AbsenceTypesPanel onDirtyChange={onDirtyChange} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Holidays' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(screen.getByLabelText('Absence type name'), { target: { value: 'Vacation' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('reports a typed new type name as unsaved', async () => {
    const onDirtyChange = vi.fn();
    render(<AbsenceTypesPanel onDirtyChange={onDirtyChange} />);
    await screen.findByText('Holidays');
    fireEvent.change(screen.getByLabelText('New absence type name'), { target: { value: 'Parental leave' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('adds one type when the add form is submitted twice', async () => {
    let finish!: () => void;
    absenceTypesApi.create.mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<AbsenceTypesPanel />);
    await screen.findByText('Holidays');

    const input = screen.getByLabelText('New absence type name');
    fireEvent.change(input, { target: { value: 'Parental leave' } });
    const form = input.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(absenceTypesApi.create).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it('deletes a type only after confirmation and reloads the list', async () => {
    const confirm = stubConfirm(false);
    absenceTypesApi.remove.mockResolvedValue(undefined);
    render(<AbsenceTypesPanel />);
    const del = await screen.findByRole('button', { name: 'Delete Home Office' });

    await act(async () => {
      fireEvent.click(del);
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Delete the absence type "Home Office"?', destructive: true })
    );
    expect(absenceTypesApi.remove).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    absenceTypesApi.getAll.mockClear();
    await act(async () => {
      fireEvent.click(del);
    });
    expect(absenceTypesApi.remove).toHaveBeenCalledWith(2);
    expect(absenceTypesApi.getAll).toHaveBeenCalled();
  });
});
