/**
 * Custom Column Store
 * Manages custom columns, their values, filtering, and visibility.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  CustomColumn,
  CustomColumnValuesMap,
} from '@/types';

// =============================================================================
// STATE INTERFACE
// =============================================================================

interface CustomColumnState {
  // ---------------------------------------------
  // DATA
  // ---------------------------------------------
  customColumns: CustomColumn[];
  customColumnValues: CustomColumnValuesMap;
  customColumnFilters: Record<number, string[]>; // columnId -> selected values to filter by
  showAllCustomColumns: boolean; // Master toggle for all custom columns
  hiddenCustomColumns: Set<number>; // Set of column IDs that are individually hidden

  // ---------------------------------------------
  // ACTIONS - Data Setters
  // ---------------------------------------------
  setCustomColumns: (columns: CustomColumn[]) => void;
  setCustomColumnValues: (values: CustomColumnValuesMap) => void;
  setCustomColumnValue: (columnId: number, entityType: string, entityId: number, value: string | null) => void;

  // ---------------------------------------------
  // ACTIONS - Filtering
  // ---------------------------------------------
  setCustomColumnFilter: (columnId: number, values: string[]) => void;
  clearCustomColumnFilter: (columnId: number) => void;
  clearAllCustomColumnFilters: () => void;
  entityPassesFilters: (entityType: string, entityId: number) => boolean;

  // ---------------------------------------------
  // ACTIONS - Visibility
  // ---------------------------------------------
  setShowAllCustomColumns: (show: boolean) => void;
  toggleCustomColumnVisibility: (columnId: number) => void;

  // ---------------------------------------------
  // ACTIONS - Reset
  // ---------------------------------------------
  resetCustomColumns: () => void;
}

// =============================================================================
// INITIAL STATE
// =============================================================================

const initialCustomColumnState = {
  customColumns: [] as CustomColumn[],
  customColumnValues: {} as CustomColumnValuesMap,
  customColumnFilters: {} as Record<number, string[]>,
  showAllCustomColumns: true,
  hiddenCustomColumns: new Set<number>(),
};

// =============================================================================
// STORE CREATION
// =============================================================================

export const useCustomColumnStore = create<CustomColumnState>()(
  persist(
    (set, get) => ({
      ...initialCustomColumnState,

      // -----------------------------------------
      // DATA SETTERS
      // -----------------------------------------
      setCustomColumns: (columns) => set({ customColumns: columns }),

      setCustomColumnValues: (values) => set({ customColumnValues: values }),

      setCustomColumnValue: (columnId, entityType, entityId, value) => set((state) => ({
        customColumnValues: {
          ...state.customColumnValues,
          [`${columnId}-${entityType}-${entityId}`]: value,
        },
      })),

      // -----------------------------------------
      // FILTERING ACTIONS
      // -----------------------------------------
      setCustomColumnFilter: (columnId, values) => set((state) => ({
        customColumnFilters: {
          ...state.customColumnFilters,
          [columnId]: values,
        },
      })),

      clearCustomColumnFilter: (columnId) => set((state) => {
        const newFilters = { ...state.customColumnFilters };
        delete newFilters[columnId];
        return { customColumnFilters: newFilters };
      }),

      clearAllCustomColumnFilters: () => set({ customColumnFilters: {} }),

      entityPassesFilters: (entityType, entityId) => {
        const state = get();
        const { customColumnFilters, customColumnValues } = state;

        // If no filters are active, pass
        const activeFilterColumns = Object.keys(customColumnFilters).filter(
          colId => customColumnFilters[Number(colId)]?.length > 0
        );

        if (activeFilterColumns.length === 0) return true;

        // Check each active filter
        for (const colIdStr of activeFilterColumns) {
          const colId = Number(colIdStr);
          const filterValues = customColumnFilters[colId];
          const valueKey = `${colId}-${entityType}-${entityId}`;
          const cellValue = customColumnValues[valueKey] ?? null;

          // Check if this cell value is in the filter set
          if (cellValue === null) {
            // Empty values pass only if '__empty__' is in the filter
            if (!filterValues.includes('__empty__')) {
              return false;
            }
          } else {
            if (!filterValues.includes(cellValue)) {
              return false;
            }
          }
        }

        return true;
      },

      // -----------------------------------------
      // VISIBILITY ACTIONS
      // -----------------------------------------
      setShowAllCustomColumns: (show) => set({ showAllCustomColumns: show }),

      toggleCustomColumnVisibility: (columnId) => set((state) => {
        const newHidden = new Set(state.hiddenCustomColumns);
        if (newHidden.has(columnId)) {
          newHidden.delete(columnId);
        } else {
          newHidden.add(columnId);
        }
        return { hiddenCustomColumns: newHidden };
      }),

      // -----------------------------------------
      // RESET
      // -----------------------------------------
      resetCustomColumns: () => set(initialCustomColumnState),
    }),
    {
      name: 'milestone-custom-columns-storage-v1',
      storage: createJSONStorage(() => localStorage),
      // Only persist visibility settings (not data or filters)
      partialize: (state) => ({
        showAllCustomColumns: state.showAllCustomColumns,
        hiddenCustomColumns: Array.from(state.hiddenCustomColumns),
      }),
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            console.error('[CustomColumnStore] Hydration error:', error);
          }
        };
      },
      merge: (persistedState, currentState) => {
        const persisted = ((persistedState as Record<string, unknown>)?.state ?? persistedState) as Record<string, unknown>;

        return {
          ...currentState,
          showAllCustomColumns: (persisted?.showAllCustomColumns as boolean) ?? currentState.showAllCustomColumns,
          hiddenCustomColumns: Array.isArray(persisted?.hiddenCustomColumns)
            ? new Set(persisted.hiddenCustomColumns as number[])
            : currentState.hiddenCustomColumns,
        };
      },
    }
  )
);
