/**
 * FillDownContext
 * Manages fill-down operations for custom column cells (like Excel)
 */

import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { setCustomColumnValue as setCustomColumnValueApi } from '@/api';
import type { CustomColumnEntityType } from '@/types';

interface FillDownSource {
  columnId: number;
  entityType: CustomColumnEntityType;
  entityId: number;
  value: string | null;
  rect: DOMRect;
}

interface FillDownTarget {
  entityType: CustomColumnEntityType;
  entityId: number;
}

interface FillDownContextValue {
  // State
  isFillingDown: boolean;
  fillSource: FillDownSource | null;
  fillTargets: FillDownTarget[];
  
  // Actions
  startFillDown: (source: FillDownSource) => void;
  updateFillTargets: (targets: FillDownTarget[]) => void;
  completeFillDown: () => Promise<void>;
  cancelFillDown: () => void;
  
  // Registration for cells to participate in fill-down
  registerCell: (
    columnId: number,
    entityType: CustomColumnEntityType,
    entityId: number,
    element: HTMLElement | null
  ) => void;
  unregisterCell: (columnId: number, entityType: CustomColumnEntityType, entityId: number) => void;
}

const FillDownContext = createContext<FillDownContextValue | null>(null);

export function FillDownProvider({ children }: { children: ReactNode }) {
  const [isFillingDown, setIsFillingDown] = useState(false);
  const [fillSource, setFillSource] = useState<FillDownSource | null>(null);
  const [fillTargets, setFillTargets] = useState<FillDownTarget[]>([]);
  
  const setCustomColumnValueLocal = useCustomColumnStore((s) => s.setCustomColumnValue);
  
  // Registry of cell elements for hit testing during drag
  const cellRegistry = useRef<Map<string, { 
    columnId: number;
    entityType: CustomColumnEntityType; 
    entityId: number; 
    element: HTMLElement 
  }>>(new Map());
  
  const registerCell = useCallback((
    columnId: number,
    entityType: CustomColumnEntityType,
    entityId: number,
    element: HTMLElement | null
  ) => {
    const key = `${columnId}-${entityType}-${entityId}`;
    if (element) {
      cellRegistry.current.set(key, { columnId, entityType, entityId, element });
    } else {
      cellRegistry.current.delete(key);
    }
  }, []);
  
  const unregisterCell = useCallback((
    columnId: number,
    entityType: CustomColumnEntityType,
    entityId: number
  ) => {
    const key = `${columnId}-${entityType}-${entityId}`;
    cellRegistry.current.delete(key);
  }, []);
  
  const startFillDown = useCallback((source: FillDownSource) => {
    setIsFillingDown(true);
    setFillSource(source);
    setFillTargets([]);
  }, []);
  
  const updateFillTargets = useCallback((targets: FillDownTarget[]) => {
    setFillTargets(targets);
  }, []);
  
  const completeFillDown = useCallback(async () => {
    if (!fillSource || fillTargets.length === 0) {
      setIsFillingDown(false);
      setFillSource(null);
      setFillTargets([]);
      return;
    }
    
    // Apply value to all targets
    const promises = fillTargets.map(async (target) => {
      // Update local state
      setCustomColumnValueLocal(
        fillSource.columnId,
        target.entityType,
        target.entityId,
        fillSource.value
      );
      
      // Persist to server
      try {
        await setCustomColumnValueApi({
          custom_column_id: fillSource.columnId,
          entity_type: target.entityType,
          entity_id: target.entityId,
          value: fillSource.value,
        });
      } catch (err) {
        console.error('[FillDown] Failed to save value:', err);
      }
    });
    
    await Promise.all(promises);
    
    setIsFillingDown(false);
    setFillSource(null);
    setFillTargets([]);
  }, [fillSource, fillTargets, setCustomColumnValueLocal]);
  
  const cancelFillDown = useCallback(() => {
    setIsFillingDown(false);
    setFillSource(null);
    setFillTargets([]);
  }, []);
  
  return (
    <FillDownContext.Provider
      value={{
        isFillingDown,
        fillSource,
        fillTargets,
        startFillDown,
        updateFillTargets,
        completeFillDown,
        cancelFillDown,
        registerCell,
        unregisterCell,
      }}
    >
      {children}
    </FillDownContext.Provider>
  );
}

export function useFillDown() {
  const context = useContext(FillDownContext);
  if (!context) {
    throw new Error('useFillDown must be used within a FillDownProvider');
  }
  return context;
}

// Helper hook for individual cells
export function useFillDownCell(
  columnId: number,
  entityType: CustomColumnEntityType,
  entityId: number
) {
  const { fillSource, fillTargets, isFillingDown } = useFillDown();
  
  const isSource = fillSource?.columnId === columnId &&
    fillSource?.entityType === entityType &&
    fillSource?.entityId === entityId;
  
  const isTarget = isFillingDown && 
    fillSource?.columnId === columnId &&
    fillTargets.some(t => t.entityType === entityType && t.entityId === entityId);
  
  return { isSource, isTarget, isFillingDown };
}
