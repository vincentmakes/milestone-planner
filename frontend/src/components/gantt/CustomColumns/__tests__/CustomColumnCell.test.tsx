/**
 * A value set on a phase cascades to all its descendants (F2-18). The
 * cascade is saved as one batch request instead of N sequential PUTs, and a
 * failed save restores every cell it touched instead of leaving the local
 * values diverged from the server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { CustomColumnCell } from '../CustomColumnCell';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import type { CustomColumn } from '@/types';

const { setCustomColumnValue, setCustomColumnValuesBatch } = vi.hoisted(() => ({
  setCustomColumnValue: vi.fn().mockResolvedValue({}),
  setCustomColumnValuesBatch: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api')>()),
  setCustomColumnValue,
  setCustomColumnValuesBatch,
}));

const column: CustomColumn = {
  id: 3,
  name: 'Approved',
  column_type: 'boolean',
  list_options: null,
  site_id: null,
  display_order: 0,
  width: 80,
} as unknown as CustomColumn;

const children = [
  { entityType: 'subphase' as const, entityId: 11 },
  { entityType: 'subphase' as const, entityId: 12 },
];

function renderCell(childEntities = children) {
  const utils = render(
    <CustomColumnCell column={column} entityType="phase" entityId={1} childEntities={childEntities} />
  );
  return utils.container.querySelector('[class*="booleanCell"]') as HTMLElement;
}

const values = () => useCustomColumnStore.getState().customColumnValues;

beforeEach(() => {
  vi.clearAllMocks();
  useCustomColumnStore.setState({
    customColumnValues: { '3-phase-1': 'false', '3-subphase-11': 'false' },
  });
});

describe('CustomColumnCell cascade', () => {
  it('saves the entity and its descendants in one batch', async () => {
    const cell = renderCell();
    await act(async () => {
      fireEvent.click(cell);
    });

    expect(setCustomColumnValue).not.toHaveBeenCalled();
    expect(setCustomColumnValuesBatch).toHaveBeenCalledTimes(1);
    expect(setCustomColumnValuesBatch).toHaveBeenCalledWith([
      { custom_column_id: 3, entity_type: 'phase', entity_id: 1, value: 'true' },
      { custom_column_id: 3, entity_type: 'subphase', entity_id: 11, value: 'true' },
      { custom_column_id: 3, entity_type: 'subphase', entity_id: 12, value: 'true' },
    ]);
    expect(values()).toMatchObject({ '3-phase-1': 'true', '3-subphase-11': 'true', '3-subphase-12': 'true' });
  });

  it('restores every touched cell when the save fails', async () => {
    setCustomColumnValuesBatch.mockRejectedValueOnce(new Error('500'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cell = renderCell();
    await act(async () => {
      fireEvent.click(cell);
    });

    expect(values()['3-phase-1']).toBe('false');
    expect(values()['3-subphase-11']).toBe('false');
    expect(values()['3-subphase-12'] ?? null).toBeNull();
  });

  it('rolls back a single-entity save too', async () => {
    setCustomColumnValue.mockRejectedValueOnce(new Error('500'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cell = renderCell([]);
    await act(async () => {
      fireEvent.click(cell);
    });

    expect(setCustomColumnValue).toHaveBeenCalledTimes(1);
    expect(values()['3-phase-1']).toBe('false');
  });
});
