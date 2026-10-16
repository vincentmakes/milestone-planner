/**
 * Manage Custom Columns: a failed delete is shown (it used to be logged to the
 * console only), and a reorder is one request that a second drop cannot
 * interleave with.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { CustomColumnsManagerModal } from '../CustomColumnsManagerModal';
import { useAppStore } from '@/stores/appStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import type { CustomColumn } from '@/api';

const api = vi.hoisted(() => ({
  reorderCustomColumns: vi.fn(),
  deleteCustomColumn: vi.fn(),
  getCustomColumnsWithValues: vi.fn(),
  updateCustomColumn: vi.fn(),
  createCustomColumn: vi.fn(),
}));
vi.mock('@/api', () => api);

const columns = [
  { id: 1, name: 'Owner', column_type: 'text', site_id: null, display_order: 0, width: 120 },
  { id: 2, name: 'Approved', column_type: 'boolean', site_id: 1, display_order: 1, width: 80 },
] as CustomColumn[];

/** Drag row `from` onto row `to` */
function drag(from: HTMLElement, to: HTMLElement) {
  fireEvent.dragStart(from, { dataTransfer: { effectAllowed: '' } });
  fireEvent.dragOver(to);
  fireEvent.drop(to);
}

const row = (name: string) => screen.getByText(name).closest('[draggable]') as HTMLElement;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getCustomColumnsWithValues.mockResolvedValue({ columns, values: [] });
  useAppStore.setState({ currentSite: { id: 1, name: 'Basel' } as never });
  useCustomColumnStore.setState({ customColumns: columns });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CustomColumnsManagerModal', () => {
  it('shows why a delete failed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.deleteCustomColumn.mockRejectedValue(new Error('Admin access required'));
    render(<CustomColumnsManagerModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getAllByTitle('Delete column')[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('Admin access required');
    expect(api.deleteCustomColumn).toHaveBeenCalledWith(1);
  });

  it('persists a reorder in one request and ignores a drop while it runs', async () => {
    let finish!: () => void;
    api.reorderCustomColumns.mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<CustomColumnsManagerModal isOpen onClose={vi.fn()} />);

    drag(row('Approved'), row('Owner'));
    expect(api.reorderCustomColumns).toHaveBeenCalledWith([2, 1]);
    expect(useCustomColumnStore.getState().customColumns.map((c) => c.id)).toEqual([2, 1]);

    // A second drag-and-drop before the first request settled
    drag(row('Owner'), row('Approved'));
    expect(api.reorderCustomColumns).toHaveBeenCalledTimes(1);
    expect(api.updateCustomColumn).not.toHaveBeenCalled();

    await act(async () => finish());
    await waitFor(() => expect(row('Owner')).toHaveAttribute('draggable', 'true'));
  });
});
