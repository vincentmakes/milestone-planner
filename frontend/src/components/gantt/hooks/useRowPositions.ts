/**
 * useRowPositions
 * Hook to track the positions of phase/subphase rows for dependency rendering
 */

import { useState, useCallback, useRef, useEffect } from 'react';

export interface RowPosition {
  top: number;
  height: number;
}

export function useRowPositions() {
  const [rowPositions, setRowPositions] = useState<Map<string, RowPosition>>(new Map());
  const pendingUpdates = useRef<Map<string, RowPosition>>(new Map());
  const rafId = useRef<number | null>(null);

  // Batch updates using requestAnimationFrame
  const flushUpdates = useCallback(() => {
    if (pendingUpdates.current.size > 0) {
      setRowPositions((prev) => {
        const next = new Map(prev);
        pendingUpdates.current.forEach((pos, key) => {
          next.set(key, pos);
        });
        return next;
      });
      pendingUpdates.current.clear();
    }
    rafId.current = null;
  }, []);

  // Register a row position
  const registerRow = useCallback((key: string, top: number, height: number) => {
    pendingUpdates.current.set(key, { top, height });
    
    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(flushUpdates);
    }
  }, [flushUpdates]);

  // Unregister a row
  const unregisterRow = useCallback((key: string) => {
    pendingUpdates.current.delete(key);
    setRowPositions((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // Clear all positions (e.g., when projects change)
  const clearPositions = useCallback(() => {
    pendingUpdates.current.clear();
    setRowPositions(new Map());
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, []);

  return {
    rowPositions,
    registerRow,
    unregisterRow,
    clearPositions,
  };
}
