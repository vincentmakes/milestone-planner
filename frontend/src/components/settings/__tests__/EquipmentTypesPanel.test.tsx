/**
 * Settings › Equipment types: the list is derived from the equipment itself.
 * A misplaced `return` once skipped that derivation, leaving the section
 * empty while equipment with types existed.
 *
 * Types only exist through equipment, so there is no "Add type" (it used to
 * be a no-op), and Delete goes through DELETE /equipment-types/{name}: the
 * backend refuses while equipment still uses the type, and that is shown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EquipmentTypesPanel } from '../panels/EquipmentTypesPanel';
import { useAppStore } from '@/stores/appStore';
import type { Equipment } from '@/types';

const apiGet = vi.fn();
const apiPut = vi.fn();
const apiDelete = vi.fn();
vi.mock('@/api/client', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPut: (...args: unknown[]) => apiPut(...args),
  apiDelete: (...args: unknown[]) => apiDelete(...args),
}));

const equipment: Equipment[] = [
  { id: 1, name: 'HPLC 1', type: 'Analytical Device', site_id: 1, site_ids: [1], active: true },
  { id: 2, name: 'HPLC 2', type: 'Analytical Device', site_id: 1, site_ids: [1, 2], active: true },
  { id: 3, name: 'Reactor', type: 'Pilot Plant', site_id: 2, site_ids: [2], active: true },
];

describe('EquipmentTypesPanel', () => {
  beforeEach(() => {
    apiGet.mockReset().mockResolvedValue(equipment);
    apiPut.mockReset().mockResolvedValue({});
    apiDelete.mockReset().mockResolvedValue({ success: true });
    useAppStore.setState({ equipment: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers no "Add type" (types are created through equipment)', async () => {
    render(<EquipmentTypesPanel />);
    await screen.findByText('Pilot Plant');
    expect(screen.queryByRole('button', { name: /Add Type/i })).not.toBeInTheDocument();
  });

  it('deletes a type through the API after confirmation and reloads the list', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<EquipmentTypesPanel />);
    await screen.findByText('Pilot Plant');

    // The reactor was moved to another type elsewhere in the meantime
    apiGet.mockResolvedValue(equipment.filter((e) => e.id !== 3));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Pilot Plant' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Delete the equipment type "Pilot Plant"?'));
    await waitFor(() => expect(screen.queryByText('Pilot Plant')).not.toBeInTheDocument());
    expect(apiDelete).toHaveBeenCalledWith('/api/equipment-types/Pilot%20Plant');
    expect(screen.getByText('1 type')).toBeInTheDocument();
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<EquipmentTypesPanel />);
    await screen.findByText('Pilot Plant');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Pilot Plant' }));
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('shows why the backend refused to delete a type that is still in use', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiDelete.mockRejectedValue(
      new Error("Cannot delete type 'Analytical Device': 2 equipment item(s) still use this type")
    );
    render(<EquipmentTypesPanel />);
    await screen.findByText('Analytical Device');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Analytical Device' }));
    expect(
      await screen.findByText('"Analytical Device" is still used by equipment — change their type in Equipment first.')
    ).toBeInTheDocument();
    expect(screen.getByText('Analytical Device')).toBeInTheDocument();
  });

  it('lists every type with how much equipment uses it', async () => {
    render(<EquipmentTypesPanel />);

    expect(await screen.findByText('Analytical Device')).toBeInTheDocument();
    expect(screen.getByText('2 equipment items')).toBeInTheDocument();
    expect(screen.getByText('Pilot Plant')).toBeInTheDocument();
    expect(screen.getByText('1 equipment item')).toBeInTheDocument();
    expect(screen.getByText('2 types')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/api/equipment/all');
  });

  it('renames a type and refreshes the equipment in the store', async () => {
    render(<EquipmentTypesPanel />);
    await screen.findByText('Pilot Plant');

    fireEvent.click(screen.getAllByTitle('Rename type')[1]);
    const name = screen.getByLabelText('Name *');
    fireEvent.change(name, { target: { value: 'Pilot Line' } });

    const renamed = equipment.map((e) => (e.id === 3 ? { ...e, type: 'Pilot Line' } : e));
    apiGet.mockResolvedValue(renamed);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Type' }));

    expect(await screen.findByText('Pilot Line')).toBeInTheDocument();
    expect(apiPut).toHaveBeenCalledWith('/api/equipment-types/Pilot%20Plant?new_type=Pilot%20Line');
    expect(useAppStore.getState().equipment).toEqual(renamed);
  });
});
