/**
 * ReorderContext
 * 
 * Provides drag-and-drop reordering state and handlers to ProjectPanel components.
 */

import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';
import { apiPut } from '@/api/client';
import { loadAllProjects } from '@/api/endpoints/projects';
import { useAppStore } from '@/stores/appStore';

export type ReorderItemType = 'phase' | 'subphase';

interface DragState {
  type: ReorderItemType;
  id: number;
  projectId: number;
  parentId?: number;
  parentType?: 'phase' | 'subphase';
}

interface DropTarget {
  type: ReorderItemType;
  id: number;
  position: 'before' | 'after';
}

interface ReorderContextValue {
  dragState: DragState | null;
  dropTarget: DropTarget | null;
  handleDragStart: (
    e: React.DragEvent,
    type: ReorderItemType,
    id: number,
    projectId: number,
    parentId?: number,
    parentType?: 'phase' | 'subphase'
  ) => void;
  handleDragOver: (e: React.DragEvent, type: ReorderItemType, id: number) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDrop: (
    e: React.DragEvent,
    type: ReorderItemType,
    id: number,
    siblings: { id: number }[],
    parentId?: number,
    parentType?: 'phase' | 'subphase'
  ) => void;
  handleDragEnd: (e: React.DragEvent) => void;
  isDragging: (type: ReorderItemType, id: number) => boolean;
  getDropPosition: (type: ReorderItemType, id: number) => 'before' | 'after' | null;
}

const ReorderContext = createContext<ReorderContextValue | null>(null);

export function ReorderProvider({ children }: { children: ReactNode }) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const dragImageRef = useRef<HTMLElement | null>(null);
  
  const setProjects = useAppStore((s) => s.setProjects);

  const cleanup = useCallback(() => {
    setDragState(null);
    setDropTarget(null);
    if (dragImageRef.current && dragImageRef.current.parentNode) {
      dragImageRef.current.parentNode.removeChild(dragImageRef.current);
      dragImageRef.current = null;
    }
  }, []);

  const handleDragStart = useCallback((
    e: React.DragEvent,
    type: ReorderItemType,
    id: number,
    projectId: number,
    parentId?: number,
    parentType?: 'phase' | 'subphase'
  ) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ type, id }));
    
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    
    // Create drag image
    const clone = target.cloneNode(true) as HTMLElement;
    clone.style.cssText = `
      position: absolute;
      top: -1000px;
      left: -1000px;
      width: ${rect.width}px;
      opacity: 0.9;
      background: var(--bg-tertiary);
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      pointer-events: none;
    `;
    document.body.appendChild(clone);
    dragImageRef.current = clone;
    e.dataTransfer.setDragImage(clone, 20, rect.height / 2);
    
    setDragState({ type, id, projectId, parentId, parentType });
    
    requestAnimationFrame(() => {
      target.style.opacity = '0.4';
    });
  }, []);

  const handleDragOver = useCallback((
    e: React.DragEvent,
    type: ReorderItemType,
    id: number
  ) => {
    if (!dragState || dragState.type !== type || dragState.id === id) return;
    
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = e.clientY < midY ? 'before' : 'after';
    
    setDropTarget({ type, id, position });
  }, [dragState]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const relatedTarget = e.relatedTarget as HTMLElement;
    const currentTarget = e.currentTarget as HTMLElement;
    if (!currentTarget.contains(relatedTarget)) {
      setDropTarget(null);
    }
  }, []);

  const handleDrop = useCallback(async (
    e: React.DragEvent,
    type: ReorderItemType,
    id: number,
    siblings: { id: number }[],
    parentId?: number,
    parentType?: 'phase' | 'subphase'
  ) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!dragState || !dropTarget || dragState.id === id) {
      cleanup();
      return;
    }
    
    const currentOrder = siblings.map(s => s.id);
    const dragIndex = currentOrder.indexOf(dragState.id);
    let dropIndex = currentOrder.indexOf(id);
    
    if (dragIndex === -1 || dropIndex === -1) {
      cleanup();
      return;
    }
    
    // Remove and reinsert
    currentOrder.splice(dragIndex, 1);
    dropIndex = currentOrder.indexOf(id);
    if (dropTarget.position === 'after') dropIndex += 1;
    currentOrder.splice(dropIndex, 0, dragState.id);
    
    try {
      if (type === 'phase') {
        await apiPut(`/api/projects/${dragState.projectId}/phases/reorder`, {
          phase_order: currentOrder
        });
      } else {
        await apiPut(`/api/subphases/${parentId}/reorder`, {
          parent_type: parentType,
          subphase_order: currentOrder
        });
      }
      
      // Reload projects to get updated order
      const updatedProjects = await loadAllProjects();
      setProjects(updatedProjects);
    } catch (err) {
      console.error('Failed to reorder:', err);
    }
    
    cleanup();
  }, [dragState, dropTarget, cleanup, setProjects]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.style.opacity = '';
    cleanup();
  }, [cleanup]);

  const isDragging = useCallback((type: ReorderItemType, id: number) => {
    return dragState?.type === type && dragState?.id === id;
  }, [dragState]);

  const getDropPosition = useCallback((type: ReorderItemType, id: number) => {
    if (dropTarget?.type === type && dropTarget?.id === id) {
      return dropTarget.position;
    }
    return null;
  }, [dropTarget]);

  return (
    <ReorderContext.Provider value={{
      dragState,
      dropTarget,
      handleDragStart,
      handleDragOver,
      handleDragLeave,
      handleDrop,
      handleDragEnd,
      isDragging,
      getDropPosition,
    }}>
      {children}
    </ReorderContext.Provider>
  );
}

export function useReorder() {
  const context = useContext(ReorderContext);
  if (!context) {
    throw new Error('useReorder must be used within ReorderProvider');
  }
  return context;
}
