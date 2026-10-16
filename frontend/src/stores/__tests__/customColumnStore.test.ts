/**
 * customColumnStore: value map keyed "{columnId}-{entityType}-{entityId}",
 * per-column filters (with the `__empty__` sentinel for blank cells) and the
 * persisted visibility state (a Set serialised as an array).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCustomColumnStore } from '../customColumnStore';
import { makeCustomColumn } from '@/test/factories';

const KEY = 'milestone-custom-columns-storage-v1';
const cc = () => useCustomColumnStore.getState();

beforeEach(() => {
  localStorage.clear();
  cc().resetCustomColumns();
});

describe('values and filters', () => {
  it('stores columns and values', () => {
    const column = makeCustomColumn();
    cc().setCustomColumns([column]);
    cc().setCustomColumnValues({ '1-project-1': 'High' });
    cc().setCustomColumnValue(1, 'phase', 5, 'Low');
    expect(cc().customColumns).toEqual([column]);
    expect(cc().customColumnValues).toEqual({ '1-project-1': 'High', '1-phase-5': 'Low' });
  });

  it('passes everything when no filter is active', () => {
    expect(cc().entityPassesFilters('project', 1)).toBe(true);
    cc().setCustomColumnFilter(1, []);
    expect(cc().entityPassesFilters('project', 1)).toBe(true);
  });

  it('matches selected values and the __empty__ sentinel, across columns (AND)', () => {
    cc().setCustomColumnValues({ '1-project-1': 'High', '1-project-2': 'Low', '2-project-1': 'true' });
    cc().setCustomColumnFilter(1, ['High', '__empty__']);
    expect(cc().entityPassesFilters('project', 1)).toBe(true);
    expect(cc().entityPassesFilters('project', 2)).toBe(false);
    expect(cc().entityPassesFilters('project', 3)).toBe(true); // blank cell

    cc().setCustomColumnFilter(2, ['true']);
    expect(cc().entityPassesFilters('project', 1)).toBe(true);
    expect(cc().entityPassesFilters('project', 3)).toBe(false); // blank, no sentinel on col 2

    cc().clearCustomColumnFilter(2);
    expect(cc().customColumnFilters).toEqual({ 1: ['High', '__empty__'] });
    cc().clearAllCustomColumnFilters();
    expect(cc().customColumnFilters).toEqual({});
  });
});

describe('visibility and persistence', () => {
  it('toggles per-column visibility and the master switch', () => {
    cc().toggleCustomColumnVisibility(3);
    expect(cc().hiddenCustomColumns).toEqual(new Set([3]));
    cc().toggleCustomColumnVisibility(3);
    expect(cc().hiddenCustomColumns.size).toBe(0);
    cc().setShowAllCustomColumns(false);
    expect(cc().showAllCustomColumns).toBe(false);
  });

  it('persists only visibility, with the hidden Set as an array', async () => {
    cc().setCustomColumnValue(1, 'project', 1, 'x');
    cc().toggleCustomColumnVisibility(4);
    cc().setShowAllCustomColumns(false);
    const raw = JSON.parse(localStorage.getItem(KEY) as string);
    expect(raw.state).toEqual({ showAllCustomColumns: false, hiddenCustomColumns: [4] });

    cc().resetCustomColumns();
    localStorage.setItem(KEY, JSON.stringify(raw));
    await useCustomColumnStore.persist.rehydrate();
    expect(cc().showAllCustomColumns).toBe(false);
    expect(cc().hiddenCustomColumns).toEqual(new Set([4]));
  });

  it('ignores a malformed hidden list and logs hydration errors', async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: { hiddenCustomColumns: 'x' }, version: 0 }));
    await useCustomColumnStore.persist.rehydrate();
    expect(cc().hiddenCustomColumns.size).toBe(0);
    expect(cc().showAllCustomColumns).toBe(true);

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(KEY, '{bad');
    await useCustomColumnStore.persist.rehydrate();
    expect(error).toHaveBeenCalledWith('[CustomColumnStore] Hydration error:', expect.anything());
    error.mockRestore();
  });
});
