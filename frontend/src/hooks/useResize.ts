/**
 * useResize - Hook for resizing phases/subphases/assignments on the timeline
 * Handles left/right edge resizing and calculates date changes
 */

import { useCallback, useRef, useEffect } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { updatePhase, updateSubphase, updateStaffAssignment, updateEquipmentAssignment, loadAllProjects } from '@/api/endpoints/projects';
import { useUndoStore } from '@/stores/undoStore';
import { 
  processPhaseMove, 
  processSubphaseMove, 
  savePendingUpdates,
  cloneProject 
} from '@/components/gantt/utils';
import type { ViewMode, Subphase } from '@/types';

type ResizeEdge = 'left' | 'right';

interface ResizeData {
  id: number;
  type: 'phase' | 'subphase' | 'staffAssignment' | 'equipmentAssignment';
  projectId: number;
  edge: ResizeEdge;
  startX: number;
  element: HTMLElement | null;
  originalLeft: number;
  originalWidth: number;
  originalStartDate: string;
  originalEndDate: string;
}

export function useResize() {
  const { isResizing, resizeEdge, resizeItemId, resizeItemType, startResize, endResize, showResizeIndicator, hideIndicator } = useUIStore();
  const { projects, setProjects, cellWidth, currentView, viewMode } = useAppStore();
  const { saveState } = useUndoStore();
  
  const resizeDataRef = useRef<ResizeData | null>(null);
  const currentXRef = useRef(0);
  
  // Format date as YYYY-MM-DD
  const formatDateLocal = useCallback((date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }, []);
  
  // Get timeline cells from DOM
  const getTimelineCellsFromDOM = useCallback((): { date: string; dateEnd?: string }[] | null => {
    const headerCells = document.querySelectorAll('[data-date]');
    if (headerCells.length === 0) return null;
    
    const cells: { date: string; dateEnd?: string }[] = [];
    headerCells.forEach((cell) => {
      const dateAttr = cell.getAttribute('data-date');
      const dateEndAttr = cell.getAttribute('data-date-end');
      if (dateAttr) {
        cells.push({ 
          date: dateAttr,
          dateEnd: dateEndAttr || undefined
        });
      }
    });
    
    return cells.length > 0 ? cells : null;
  }, []);
  
  // Calculate date from pixel position (inverse of calculateBarPosition)
  const calculateDateFromPosition = useCallback((
    leftPx: number, 
    cells: { date: string; dateEnd?: string }[], 
    cw: number, 
    vm: ViewMode
  ): string | null => {
    if (cells.length === 0) return null;
    
    // For week/month view, snap to the nearest cell (day)
    if (vm === 'week' || vm === 'month') {
      const cellIndex = Math.round(leftPx / cw);
      const clampedIndex = Math.max(0, Math.min(cells.length - 1, cellIndex));
      return cells[clampedIndex].date;
    }
    
    // For quarter/year view, use proportional calculation
    const fcd = new Date(cells[0].date);
    fcd.setHours(0, 0, 0, 0);
    
    let lcd: Date;
    const lastCell = cells[cells.length - 1];
    
    if (vm === 'quarter' && lastCell.dateEnd) {
      lcd = new Date(lastCell.dateEnd);
      lcd.setHours(23, 59, 59, 999);
    } else if (vm === 'year') {
      lcd = new Date(lastCell.date);
      lcd = new Date(lcd.getFullYear(), lcd.getMonth() + 1, 0, 23, 59, 59, 999);
    } else {
      lcd = new Date(lastCell.date);
      lcd.setHours(23, 59, 59, 999);
    }
    
    const totalMs = lcd.getTime() - fcd.getTime();
    const tw = cells.length * cw;
    
    const msOffset = (leftPx / tw) * totalMs;
    const newDate = new Date(fcd.getTime() + msOffset);
    
    return formatDateLocal(newDate);
  }, [formatDateLocal]);
  
  // Handle mouse move during resize
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!resizeDataRef.current) return;
    
    currentXRef.current = e.clientX;
    const data = resizeDataRef.current;
    const deltaX = e.clientX - data.startX;
    
    let newLeft = data.originalLeft;
    let newWidth = data.originalWidth;
    
    // Update element size/position visually
    if (data.element) {
      if (data.edge === 'left') {
        // Resizing from left: move left edge, adjust width
        newLeft = data.originalLeft + deltaX;
        newWidth = data.originalWidth - deltaX;
        if (newWidth >= cellWidth) { // Minimum 1 cell width
          data.element.style.left = `${newLeft}px`;
          data.element.style.width = `${newWidth}px`;
        }
      } else {
        // Resizing from right: just adjust width
        newWidth = data.originalWidth + deltaX;
        if (newWidth >= cellWidth) { // Minimum 1 cell width
          data.element.style.width = `${newWidth}px`;
        }
      }
    }
    
    // Calculate and show resize indicator
    const cells = getTimelineCellsFromDOM();
    if (cells && cells.length > 0 && newWidth >= cellWidth && data.element) {
      const dateStr = data.edge === 'left' 
        ? calculateDateFromPosition(newLeft, cells, cellWidth, viewMode)
        : calculateDateFromPosition(newLeft + newWidth, cells, cellWidth, viewMode);
      
      if (dateStr) {
        // Calculate duration
        const startDateStr = data.edge === 'left' 
          ? dateStr 
          : calculateDateFromPosition(newLeft, cells, cellWidth, viewMode) || data.originalStartDate;
        const endDateStr = data.edge === 'left'
          ? calculateDateFromPosition(newLeft + newWidth, cells, cellWidth, viewMode) || data.originalEndDate
          : dateStr;
        
        const startMs = new Date(startDateStr).getTime();
        const endMs = new Date(endDateStr).getTime();
        const durationDays = Math.round((endMs - startMs) / 86400000) + 1;
        
        // Calculate position relative to timeline body
        const row = data.element.closest('[class*="row"]');
        if (row) {
          const rowTop = (row as HTMLElement).offsetTop;
          // Position at left or right edge of bar
          const indicatorLeft = data.edge === 'left' 
            ? newLeft 
            : newLeft + newWidth;
          const indicatorTop = rowTop - 28;  // Above the row
          
          showResizeIndicator(indicatorLeft, indicatorTop, dateStr, durationDays, data.edge);
        }
      }
    }
  }, [cellWidth, viewMode, showResizeIndicator, getTimelineCellsFromDOM, calculateDateFromPosition]);
  
  // Handle mouse up - commit the resize
  const handleMouseUp = useCallback(async () => {
    // Hide indicator first
    hideIndicator();
    
    if (!resizeDataRef.current) {
      endResize();
      return;
    }
    
    const data = resizeDataRef.current;
    
    // Clean up listeners first
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    
    // Remove resize cursor
    document.body.style.cursor = '';
    
    // Remove resizing class
    if (data.element) {
      data.element.classList.remove('resizing');
    }
    
    // Get current element position/size
    const finalLeft = data.element ? parseFloat(data.element.style.left) || 0 : data.originalLeft;
    const finalWidth = data.element ? parseFloat(data.element.style.width) || data.originalWidth : data.originalWidth;
    
    // Check if there was any significant change
    const leftDelta = Math.abs(finalLeft - data.originalLeft);
    const widthDelta = Math.abs(finalWidth - data.originalWidth);
    
    if (leftDelta < 2 && widthDelta < 2) {
      // No significant change, reset and cleanup
      if (data.element) {
        data.element.style.left = `${data.originalLeft}px`;
        data.element.style.width = `${data.originalWidth}px`;
      }
      resizeDataRef.current = null;
      endResize();
      return;
    }
    
    // Get timeline cells for inverse calculation
    const cells = getTimelineCellsFromDOM();
    
    let newStartDate = data.originalStartDate;
    let newEndDate = data.originalEndDate;
    
    if (cells && cells.length > 0) {
      // Use inverse of calculateBarPosition
      if (data.edge === 'left') {
        // Left resize: calculate new start date from new left position
        const calculatedStart = calculateDateFromPosition(finalLeft, cells, cellWidth, viewMode);
        if (calculatedStart) {
          newStartDate = calculatedStart;
          // Ensure start doesn't go past end
          if (new Date(newStartDate) >= new Date(newEndDate)) {
            const endDate = new Date(newEndDate);
            endDate.setDate(endDate.getDate() - 1);
            newStartDate = formatDateLocal(endDate);
          }
        }
      } else {
        // Right resize: calculate new end date from right edge position
        const rightPosition = finalLeft + finalWidth;
        const calculatedEnd = calculateDateFromPosition(rightPosition, cells, cellWidth, viewMode);
        if (calculatedEnd) {
          newEndDate = calculatedEnd;
          // Ensure end doesn't go before start
          if (new Date(newEndDate) <= new Date(newStartDate)) {
            const startDate = new Date(newStartDate);
            startDate.setDate(startDate.getDate() + 1);
            newEndDate = formatDateLocal(startDate);
          }
        }
      }
    } else {
      // Fallback to delta-based calculation
      const deltaX = currentXRef.current - data.startX;
      let daysPerCell: number;
      switch (viewMode) {
        case 'week':
        case 'month':
          daysPerCell = 1;
          break;
        case 'quarter':
          daysPerCell = 7;
          break;
        case 'year':
          daysPerCell = 30;
          break;
        default:
          daysPerCell = 1;
      }
      
      const daysDelta = Math.round((deltaX / cellWidth) * daysPerCell);
      
      const addDays = (dateStr: string, days: number): string => {
        const date = new Date(dateStr);
        date.setDate(date.getDate() + days);
        return date.toISOString().split('T')[0];
      };
      
      if (data.edge === 'left') {
        newStartDate = addDays(data.originalStartDate, daysDelta);
        if (new Date(newStartDate) >= new Date(newEndDate)) {
          newStartDate = addDays(newEndDate, -1);
        }
      } else {
        newEndDate = addDays(data.originalEndDate, daysDelta);
        if (new Date(newEndDate) <= new Date(newStartDate)) {
          newEndDate = addDays(newStartDate, 1);
        }
      }
    }
    
    try {
      // Save undo state
      saveState(projects, 'resize');
      
      // Find the project containing this item
      const projectIndex = projects.findIndex(p => p.id === data.projectId);
      if (projectIndex === -1) {
        console.error('Project not found:', data.projectId);
        resizeDataRef.current = null;
        endResize();
        return;
      }
      
      // Clone the project for mutations
      const projectCopy = cloneProject(projects[projectIndex]);
      
      // First, update the resized item itself
      if (data.type === 'phase') {
        const phase = (projectCopy.phases ?? []).find(p => p.id === data.id);
        if (phase) {
          phase.start_date = newStartDate;
          phase.end_date = newEndDate;
        }
      } else if (data.type === 'subphase') {
        // Update subphase in tree
        const updateInTree = (children: Subphase[]): boolean => {
          for (const child of children) {
            if (child.id === data.id) {
              child.start_date = newStartDate;
              child.end_date = newEndDate;
              return true;
            }
            if (child.children?.length && updateInTree(child.children)) {
              return true;
            }
          }
          return false;
        };
        
        for (const phase of projectCopy.phases ?? []) {
          if (phase.children?.length && updateInTree(phase.children)) {
            break;
          }
        }
      } else if (data.type === 'staffAssignment') {
        const assignment = projectCopy.staffAssignments?.find(a => a.id === data.id);
        if (assignment) {
          assignment.start_date = newStartDate;
          assignment.end_date = newEndDate;
        }
      } else if (data.type === 'equipmentAssignment') {
        const assignment = projectCopy.equipmentAssignments?.find(a => a.id === data.id);
        if (assignment) {
          assignment.start_date = newStartDate;
          assignment.end_date = newEndDate;
        }
      }
      
      // Process auto-calculations (cascading) - only for phases/subphases
      let pendingUpdates: any[] = [];
      if (data.type === 'phase') {
        pendingUpdates = processPhaseMove(
          projectCopy, 
          data.id, 
          data.originalEndDate, 
          newEndDate
        );
      } else if (data.type === 'subphase') {
        pendingUpdates = processSubphaseMove(
          projectCopy, 
          data.id, 
          data.originalEndDate, 
          newEndDate
        );
      }
      // Assignments don't have auto-calculations
      
      // Update local state with all changes (including cascaded)
      const updatedProjects = projects.map((p, idx) => 
        idx === projectIndex ? projectCopy : p
      );
      setProjects(updatedProjects);
      
      // Persist the resized item to server
      if (data.type === 'phase') {
        await updatePhase(data.id, {
          start_date: newStartDate,
          end_date: newEndDate,
        });
      } else if (data.type === 'subphase') {
        await updateSubphase(data.id, {
          start_date: newStartDate,
          end_date: newEndDate,
        });
      } else if (data.type === 'staffAssignment') {
        // Staff assignment requires allocation field
        const assignment = projectCopy.staffAssignments?.find(a => a.id === data.id);
        await updateStaffAssignment(data.id, {
          start_date: newStartDate,
          end_date: newEndDate,
          allocation: assignment?.allocation ?? 100,
        });
      } else if (data.type === 'equipmentAssignment') {
        await updateEquipmentAssignment(data.id, {
          start_date: newStartDate,
          end_date: newEndDate,
        });
      }
      
      // Save all cascaded updates to server
      if (pendingUpdates.length > 0) {
        console.log(`Cascading ${pendingUpdates.length} updates:`, pendingUpdates);
        await savePendingUpdates(pendingUpdates);
      }
    } catch (err) {
      console.error('Failed to resize item:', err);
      // On error, reload to get correct state
      const reloadedProjects = await loadAllProjects();
      setProjects(reloadedProjects);
    }
    
    resizeDataRef.current = null;
    endResize();
  }, [cellWidth, viewMode, endResize, handleMouseMove, saveState, setProjects, projects, hideIndicator]);
  
  // Helper to recursively update subphase in tree
  const updateSubphaseInTree = (
    subphases: Subphase[], 
    targetId: number, 
    newStartDate: string, 
    newEndDate: string
  ): Subphase[] => {
    return subphases.map(sp => {
      if (sp.id === targetId) {
        return { ...sp, start_date: newStartDate, end_date: newEndDate };
      }
      if (sp.children?.length) {
        return {
          ...sp,
          children: updateSubphaseInTree(sp.children, targetId, newStartDate, newEndDate)
        };
      }
      return sp;
    });
  };
  
  // Start resizing a phase
  const startPhaseResize = useCallback((
    e: React.MouseEvent,
    phaseId: number,
    projectId: number,
    edge: ResizeEdge,
    startDate: string,
    endDate: string,
    element: HTMLElement
  ) => {
    // Don't allow resizing in equipment view (read-only)
    if (currentView === 'equipment') return;
    
    // Don't allow resizing in staff view
    if (currentView === 'staff') return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    
    resizeDataRef.current = {
      id: phaseId,
      type: 'phase',
      projectId,
      edge,
      startX: e.clientX,
      element,
      originalLeft: parseFloat(style.left) || 0,
      originalWidth: rect.width,
      originalStartDate: startDate,
      originalEndDate: endDate,
    };
    
    currentXRef.current = e.clientX;
    
    // Add resizing class
    element.classList.add('resizing');
    
    // Set cursor for entire document
    document.body.style.cursor = 'ew-resize';
    
    startResize('phase', phaseId, edge);
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [currentView, handleMouseMove, handleMouseUp, startResize]);
  
  // Start resizing a subphase
  const startSubphaseResize = useCallback((
    e: React.MouseEvent,
    subphaseId: number,
    projectId: number,
    edge: ResizeEdge,
    startDate: string,
    endDate: string,
    element: HTMLElement
  ) => {
    // Don't allow resizing in equipment view (read-only)
    if (currentView === 'equipment') return;
    
    // Don't allow resizing in staff view
    if (currentView === 'staff') return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    
    resizeDataRef.current = {
      id: subphaseId,
      type: 'subphase',
      projectId,
      edge,
      startX: e.clientX,
      element,
      originalLeft: parseFloat(style.left) || 0,
      originalWidth: rect.width,
      originalStartDate: startDate,
      originalEndDate: endDate,
    };
    
    currentXRef.current = e.clientX;
    
    // Add resizing class
    element.classList.add('resizing');
    
    // Set cursor for entire document
    document.body.style.cursor = 'ew-resize';
    
    startResize('subphase', subphaseId, edge);
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [currentView, handleMouseMove, handleMouseUp, startResize]);
  
  // Start resizing a staff assignment
  const startStaffAssignmentResize = useCallback((
    e: React.MouseEvent,
    assignmentId: number,
    projectId: number,
    edge: ResizeEdge,
    startDate: string,
    endDate: string,
    targetElement?: HTMLElement
  ) => {
    // Don't allow resizing in equipment view (read-only)
    if (currentView === 'equipment') return;
    
    // Don't allow resizing in staff view (read-only)
    if (currentView === 'staff') return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const element = targetElement || (e.currentTarget as HTMLElement).closest('[data-assignment-id]') as HTMLElement;
    if (!element) return;
    
    resizeDataRef.current = {
      id: assignmentId,
      type: 'staffAssignment',
      projectId,
      edge,
      startX: e.clientX,
      element,
      originalLeft: parseInt(element.style.left || '0') || 0,
      originalWidth: parseInt(element.style.width || '0') || element.offsetWidth,
      originalStartDate: startDate,
      originalEndDate: endDate,
    };
    
    currentXRef.current = e.clientX;
    
    // Add resizing class
    element.classList.add('resizing');
    
    // Set cursor for entire document
    document.body.style.cursor = 'ew-resize';
    
    startResize('staffAssignment', assignmentId, edge);
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [currentView, handleMouseMove, handleMouseUp, startResize]);
  
  // Start resizing an equipment assignment
  const startEquipmentAssignmentResize = useCallback((
    e: React.MouseEvent,
    assignmentId: number,
    projectId: number,
    edge: ResizeEdge,
    startDate: string,
    endDate: string,
    targetElement?: HTMLElement
  ) => {
    // Don't allow resizing in equipment view (read-only)
    if (currentView === 'equipment') return;
    
    // Don't allow resizing in staff view (read-only)
    if (currentView === 'staff') return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const element = targetElement || (e.currentTarget as HTMLElement).closest('[data-assignment-id]') as HTMLElement;
    if (!element) return;
    
    resizeDataRef.current = {
      id: assignmentId,
      type: 'equipmentAssignment',
      projectId,
      edge,
      startX: e.clientX,
      element,
      originalLeft: parseInt(element.style.left || '0') || 0,
      originalWidth: parseInt(element.style.width || '0') || element.offsetWidth,
      originalStartDate: startDate,
      originalEndDate: endDate,
    };
    
    currentXRef.current = e.clientX;
    
    // Add resizing class
    element.classList.add('resizing');
    
    // Set cursor for entire document
    document.body.style.cursor = 'ew-resize';
    
    startResize('equipmentAssignment', assignmentId, edge);
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [currentView, handleMouseMove, handleMouseUp, startResize]);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
    };
  }, [handleMouseMove, handleMouseUp]);
  
  return {
    isResizing,
    resizeEdge,
    resizeItemId,
    resizeItemType,
    startPhaseResize,
    startSubphaseResize,
    startStaffAssignmentResize,
    startEquipmentAssignmentResize,
  };
}
