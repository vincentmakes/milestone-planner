/**
 * useResize - Hook for resizing phases/subphases/assignments on the timeline
 * Handles left/right edge resizing (mouse and touch) and calculates date
 * changes. The bars hand the start functions a mouse-like event (a touch is
 * converted with toMouseLikeEvent); the document listeners take both.
 */

import { useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { updatePhase, updateSubphase, updateStaffAssignment, updateEquipmentAssignment } from '@/api/endpoints/projects';
import { parseLocalDate, addDaysToDateString, daysBetweenDateStrings } from '@/utils/date';
import { recoverFromPersistFailure } from '@/utils/persistFailure';
import { getPointerClientX, NON_PASSIVE } from '@/utils/touchEvents';
import { useUndoStore } from '@/stores/undoStore';
import {
  processPhaseMove,
  processSubphaseMove,
  savePendingUpdates,
  cloneProject
} from '@/components/gantt/utils';
import type { PendingUpdate } from '@/components/gantt/utils';
import { canEditProjectById, canEditAssignment } from '@/utils/permissions';
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
  /** The element's inline `left` / `width` at resize start, restored on cancel. */
  originalInlineLeft: string;
  originalInlineWidth: string;
  originalStartDate: string;
  originalEndDate: string;
}

export function useResize() {
  // Selectors only (useShallow): a whole-store subscription re-rendered every
  // host of this hook on each tooltip move / indicator update.
  const { isResizing, resizeEdge, resizeItemId, resizeItemType, startResize, endResize, showResizeIndicator, hideIndicator } = useUIStore(
    useShallow((s) => ({
      isResizing: s.isResizing,
      resizeEdge: s.resizeEdge,
      resizeItemId: s.resizeItemId,
      resizeItemType: s.resizeItemType,
      startResize: s.startResize,
      endResize: s.endResize,
      showResizeIndicator: s.showResizeIndicator,
      hideIndicator: s.hideIndicator,
    }))
  );
  const projects = useAppStore((s) => s.projects);
  const setProjects = useAppStore((s) => s.setProjects);
  const currentUser = useAppStore((s) => s.currentUser);
  // Per-project rights: admins, superusers and the project's manager may
  // resize schedule items; a staff booking may also be resized by the person
  // it books.
  const canEditProjectId = useCallback(
    (projectId: number) => canEditProjectById(currentUser, projects, projectId),
    [currentUser, projects]
  );
  const canEditStaffAssignment = useCallback(
    (projectId: number, staffId?: number) =>
      canEditAssignment(currentUser, projects.find((p) => p.id === projectId), staffId),
    [currentUser, projects]
  );
  const { cellWidth, currentView, viewMode } = useViewStore(
    useShallow((s) => ({ cellWidth: s.cellWidth, currentView: s.currentView, viewMode: s.viewMode }))
  );
  const saveState = useUndoStore((s) => s.saveState);
  
  const resizeDataRef = useRef<ResizeData | null>(null);
  const currentXRef = useRef(0);

  // Document listeners for an active resize (mouse and touch): registered
  // once at resize start, removed only on mouse-up / touch-end / touch-cancel
  // or unmount. Stable trampolines call the LATEST handlers through refs, so
  // a `projects` change mid-gesture (WebSocket refetch) no longer strips the
  // live listeners and abandons the resize.
  const pointerMoveHandlerRef = useRef<(e: MouseEvent | TouchEvent) => void>(() => {});
  const pointerUpHandlerRef = useRef<() => Promise<void>>(async () => {});
  const cancelHandlerRef = useRef<() => void>(() => {});
  const onDocumentPointerMove = useCallback((e: MouseEvent | TouchEvent) => {
    pointerMoveHandlerRef.current(e);
  }, []);
  const onDocumentPointerUp = useCallback((e: MouseEvent | TouchEvent) => {
    // A handled touchend must not also produce the synthesized
    // mousedown/mouseup/click (which would restart the gesture or click).
    if (e.type === 'touchend' && e.cancelable) e.preventDefault();
    void pointerUpHandlerRef.current();
  }, []);
  const onDocumentTouchCancel = useCallback(() => {
    cancelHandlerRef.current();
  }, []);
  const attachResizeListeners = useCallback(() => {
    document.addEventListener('mousemove', onDocumentPointerMove);
    document.addEventListener('mouseup', onDocumentPointerUp);
    document.addEventListener('touchmove', onDocumentPointerMove, NON_PASSIVE);
    document.addEventListener('touchend', onDocumentPointerUp);
    document.addEventListener('touchcancel', onDocumentTouchCancel);
  }, [onDocumentPointerMove, onDocumentPointerUp, onDocumentTouchCancel]);
  const detachResizeListeners = useCallback(() => {
    document.removeEventListener('mousemove', onDocumentPointerMove);
    document.removeEventListener('mouseup', onDocumentPointerUp);
    document.removeEventListener('touchmove', onDocumentPointerMove, NON_PASSIVE);
    document.removeEventListener('touchend', onDocumentPointerUp);
    document.removeEventListener('touchcancel', onDocumentTouchCancel);
  }, [onDocumentPointerMove, onDocumentPointerUp, onDocumentTouchCancel]);
  
  // Refs to hold current values - prevents stale closure issues in event handlers
  const cellWidthRef = useRef(cellWidth);
  const viewModeRef = useRef(viewMode);
  
  // Keep refs in sync with store values
  useEffect(() => {
    cellWidthRef.current = cellWidth;
  }, [cellWidth]);
  
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);
  
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
  
  // Calculate date from pixel position (inverse of calculateBarPosition).
  //
  // The forward path renders the right edge of a bar at the boundary between
  // two cells (e.g., end_date = Jan 3 → right edge ≈ start of Jan 4 cell).
  // To stay consistent on the way back, the right edge of a bar at pixel P
  // must resolve to the cell BEFORE round(P/cw), not the cell AT it.
  const calculateDateFromPosition = useCallback((
    leftPx: number,
    cells: { date: string; dateEnd?: string }[],
    cw: number,
    vm: ViewMode,
    edge: ResizeEdge
  ): string | null => {
    if (cells.length === 0) return null;

    // For week/month view, snap to the nearest cell (day)
    if (vm === 'week' || vm === 'month') {
      const rawIndex = Math.round(leftPx / cw) - (edge === 'right' ? 1 : 0);
      const clampedIndex = Math.max(0, Math.min(cells.length - 1, rawIndex));
      return cells[clampedIndex].date;
    }

    // For quarter/year view, use proportional calculation
    // data-date attributes are yyyy-MM-dd: parse as LOCAL midnight, matching
    // the forward path (calculateBarPosition parses dates locally).
    const fcd = parseLocalDate(cells[0].date);
    fcd.setHours(0, 0, 0, 0);

    let lcd: Date;
    const lastCell = cells[cells.length - 1];

    if (vm === 'quarter' && lastCell.dateEnd) {
      lcd = parseLocalDate(lastCell.dateEnd);
      lcd.setHours(23, 59, 59, 999);
    } else if (vm === 'year') {
      lcd = parseLocalDate(lastCell.date);
      lcd = new Date(lcd.getFullYear(), lcd.getMonth() + 1, 0, 23, 59, 59, 999);
    } else {
      lcd = parseLocalDate(lastCell.date);
      lcd.setHours(23, 59, 59, 999);
    }

    const totalMs = lcd.getTime() - fcd.getTime();
    const tw = cells.length * cw;

    const msOffset = (leftPx / tw) * totalMs;
    const newDate = new Date(fcd.getTime() + msOffset);

    // Right-edge boundary lands on the start of the next unit; step back one day
    // so the date represents the inclusive end of the bar.
    if (edge === 'right') {
      newDate.setDate(newDate.getDate() - 1);
    }

    return formatDateLocal(newDate);
  }, [formatDateLocal]);
  
  // Handle pointer (mouse or touch) move during resize
  const handlePointerMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!resizeDataRef.current) return;
    
    // The finger resizes the bar, not the page.
    if ('touches' in e && e.cancelable) e.preventDefault();
    
    const clientX = getPointerClientX(e);
    currentXRef.current = clientX;
    const data = resizeDataRef.current;
    
    // Get current values from refs to avoid stale closures
    const currentCellWidth = cellWidthRef.current;
    const currentViewMode = viewModeRef.current;
    
    let deltaX = clientX - data.startX;
    
    // For week/month view, snap to day boundaries (cellWidth increments)
    if (currentViewMode === 'week' || currentViewMode === 'month') {
      deltaX = Math.round(deltaX / currentCellWidth) * currentCellWidth;
    }
    
    let newLeft = data.originalLeft;
    let newWidth = data.originalWidth;
    
    // Update element size/position visually
    if (data.element) {
      if (data.edge === 'left') {
        // Resizing from left: move left edge, adjust width
        newLeft = data.originalLeft + deltaX;
        newWidth = data.originalWidth - deltaX;
        if (newWidth >= currentCellWidth) { // Minimum 1 cell width
          data.element.style.left = `${newLeft}px`;
          data.element.style.width = `${newWidth}px`;
        }
      } else {
        // Resizing from right: just adjust width
        newWidth = data.originalWidth + deltaX;
        if (newWidth >= currentCellWidth) { // Minimum 1 cell width
          data.element.style.width = `${newWidth}px`;
        }
      }
    }
    
    // Calculate and show resize indicator
    const cells = getTimelineCellsFromDOM();
    if (cells && cells.length > 0 && newWidth >= currentCellWidth && data.element) {
      const dateStr = data.edge === 'left'
        ? calculateDateFromPosition(newLeft, cells, currentCellWidth, currentViewMode, 'left')
        : calculateDateFromPosition(newLeft + newWidth, cells, currentCellWidth, currentViewMode, 'right');

      if (dateStr) {
        // Calculate duration
        const startDateStr = data.edge === 'left'
          ? dateStr
          : calculateDateFromPosition(newLeft, cells, currentCellWidth, currentViewMode, 'left') || data.originalStartDate;
        const endDateStr = data.edge === 'left'
          ? calculateDateFromPosition(newLeft + newWidth, cells, currentCellWidth, currentViewMode, 'right') || data.originalEndDate
          : dateStr;
        
        const durationDays = daysBetweenDateStrings(startDateStr, endDateStr) + 1;
        
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
  }, [showResizeIndicator, getTimelineCellsFromDOM, calculateDateFromPosition]);
  
  // Handle mouse up - commit the resize
  const handleMouseUp = useCallback(async () => {
    // Hide indicator first
    hideIndicator();
    
    if (!resizeDataRef.current) {
      endResize();
      return;
    }
    
    const data = resizeDataRef.current;
    
    // Get current values from refs to avoid stale closures
    const currentCellWidth = cellWidthRef.current;
    const currentViewMode = viewModeRef.current;
    
    // Clean up listeners first
    detachResizeListeners();
    
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
        const calculatedStart = calculateDateFromPosition(finalLeft, cells, currentCellWidth, currentViewMode, 'left');
        if (calculatedStart) {
          newStartDate = calculatedStart;
          // Ensure start doesn't go past end
          if (daysBetweenDateStrings(newEndDate, newStartDate) >= 0) {
            newStartDate = addDaysToDateString(newEndDate, -1);
          }
        }
      } else {
        // Right resize: calculate new end date from right edge position
        const rightPosition = finalLeft + finalWidth;
        const calculatedEnd = calculateDateFromPosition(rightPosition, cells, currentCellWidth, currentViewMode, 'right');
        if (calculatedEnd) {
          newEndDate = calculatedEnd;
          // Ensure end doesn't go before start
          if (daysBetweenDateStrings(newStartDate, newEndDate) <= 0) {
            newEndDate = addDaysToDateString(newStartDate, 1);
          }
        }
      }
    } else {
      // Fallback to delta-based calculation
      const deltaX = currentXRef.current - data.startX;
      let daysPerCell: number;
      switch (currentViewMode) {
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
      
      const daysDelta = Math.round((deltaX / currentCellWidth) * daysPerCell);
      
      if (data.edge === 'left') {
        newStartDate = addDaysToDateString(data.originalStartDate, daysDelta);
        if (daysBetweenDateStrings(newEndDate, newStartDate) >= 0) {
          newStartDate = addDaysToDateString(newEndDate, -1);
        }
      } else {
        newEndDate = addDaysToDateString(data.originalEndDate, daysDelta);
        if (daysBetweenDateStrings(newStartDate, newEndDate) <= 0) {
          newEndDate = addDaysToDateString(newStartDate, 1);
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
      let pendingUpdates: PendingUpdate[] = [];
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
        await savePendingUpdates(pendingUpdates);
      }
    } catch (err) {
      // Optimistic-write failure protocol: reload + clear the undo stack.
      await recoverFromPersistFailure('Resize', err);
    }
    
    resizeDataRef.current = null;
    endResize();
  }, [endResize, detachResizeListeners, saveState, setProjects, projects, hideIndicator, getTimelineCellsFromDOM, calculateDateFromPosition]);

  // Abandon the resize without saving (touchcancel, unmount): the bar gets
  // its original position and size back and no API call is made.
  const cancelResize = useCallback(() => {
    detachResizeListeners();
    const data = resizeDataRef.current;
    if (!data) return;
    if (data.element) {
      data.element.style.left = data.originalInlineLeft;
      data.element.style.width = data.originalInlineWidth;
      data.element.classList.remove('resizing');
    }
    document.body.style.cursor = '';
    resizeDataRef.current = null;
    useUIStore.getState().hideIndicator();
    useUIStore.getState().endResize();
  }, [detachResizeListeners]);

  // Keep the document trampolines pointing at the latest handlers.
  useLayoutEffect(() => {
    pointerMoveHandlerRef.current = handlePointerMove;
    pointerUpHandlerRef.current = handleMouseUp;
    cancelHandlerRef.current = cancelResize;
  });
  
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
    if (!canEditProjectId(projectId)) return;

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
      originalInlineLeft: element.style.left,
      originalInlineWidth: element.style.width,
      originalStartDate: startDate,
      originalEndDate: endDate,
    };
    
    currentXRef.current = e.clientX;
    
    // Add resizing class
    element.classList.add('resizing');
    
    // Set cursor for entire document
    document.body.style.cursor = 'ew-resize';
    
    startResize('phase', phaseId, edge);
    
    attachResizeListeners();
  }, [canEditProjectId, currentView, attachResizeListeners, startResize]);
  
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
    if (!canEditProjectId(projectId)) return;

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
      originalInlineLeft: element.style.left,
      originalInlineWidth: element.style.width,
      originalStartDate: startDate,
      originalEndDate: endDate,
    };
    
    currentXRef.current = e.clientX;
    
    // Add resizing class
    element.classList.add('resizing');
    
    // Set cursor for entire document
    document.body.style.cursor = 'ew-resize';
    
    startResize('subphase', subphaseId, edge);
    
    attachResizeListeners();
  }, [canEditProjectId, currentView, attachResizeListeners, startResize]);
  
  // Start resizing a staff assignment
  const startStaffAssignmentResize = useCallback((
    e: React.MouseEvent,
    assignmentId: number,
    projectId: number,
    edge: ResizeEdge,
    startDate: string,
    endDate: string,
    targetElement?: HTMLElement,
    staffId?: number
  ) => {
    if (!canEditStaffAssignment(projectId, staffId)) return;

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
      originalInlineLeft: element.style.left,
      originalInlineWidth: element.style.width,
      originalStartDate: startDate,
      originalEndDate: endDate,
    };
    
    currentXRef.current = e.clientX;
    
    // Add resizing class
    element.classList.add('resizing');
    
    // Set cursor for entire document
    document.body.style.cursor = 'ew-resize';
    
    startResize('staffAssignment', assignmentId, edge);

    attachResizeListeners();
  }, [canEditStaffAssignment, currentView, attachResizeListeners, startResize]);
  
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
    if (!canEditProjectId(projectId)) return;

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
      originalInlineLeft: element.style.left,
      originalInlineWidth: element.style.width,
      originalStartDate: startDate,
      originalEndDate: endDate,
    };
    
    currentXRef.current = e.clientX;
    
    // Add resizing class
    element.classList.add('resizing');
    
    // Set cursor for entire document
    document.body.style.cursor = 'ew-resize';
    
    startResize('equipmentAssignment', assignmentId, edge);
    
    attachResizeListeners();
  }, [canEditProjectId, currentView, attachResizeListeners, startResize]);
  
  // Cleanup on unmount only: an unmount mid-resize abandons it cleanly.
  useEffect(() => cancelResize, [cancelResize]);
  
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
