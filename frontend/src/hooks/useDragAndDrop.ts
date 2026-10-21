/**
 * useDragAndDrop - Hook for dragging phases/subphases/assignments on the timeline
 * Handles mouse and touch events and calculates day offsets based on cell width.
 * The bars hand the start functions a mouse-like event (a touch is converted
 * with toMouseLikeEvent); the document listeners take mouse and touch alike.
 */

import { useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { updatePhase, updateSubphase, updateProject, updateStaffAssignment, updateEquipmentAssignment } from '@/api/endpoints/projects';
import { parseLocalDate, addDaysToDateString, daysBetweenDateStrings } from '@/utils/date';
import { recoverFromPersistFailure } from '@/utils/persistFailure';
import { getPointerClientX, NON_PASSIVE } from '@/utils/touchEvents';
import { useUndoStore } from '@/stores/undoStore';
import { 
  processPhaseMove, 
  processSubphaseMove, 
  savePendingUpdates,
  cloneProject,
  moveChildrenByOffset,
  movePhasesWithProject,
  resolveDependencyPredecessor,
} from '@/components/gantt/utils';
import type { PendingUpdate } from '@/components/gantt/utils';
import { canEditProjectById, canEditAssignment } from '@/utils/permissions';
import type { ViewMode, Subphase, Project } from '@/types';
import { confirmAction } from '@/utils/confirmDialog';

interface DragData {
  id: number;
  type: 'project' | 'phase' | 'subphase' | 'staffAssignment' | 'equipmentAssignment';
  projectId: number;
  phaseId?: number;
  startX: number;
  element: HTMLElement | null;
  originalLeft: number;
  /** The element's inline `left` at drag start, restored on cancel. */
  originalInlineLeft: string;
  originalStartDate: string;
  originalEndDate: string;
  isMilestone: boolean;
  // For project drag - track if user confirmed
  confirmed?: boolean;
}

export function useDragAndDrop() {
  // Selectors only (useShallow): a whole-store subscription re-rendered every
  // host of this hook on each tooltip move / indicator update.
  const { isDragging, dragType, dragItemId, startDrag, endDrag, showDragIndicator, hideIndicator } = useUIStore(
    useShallow((s) => ({
      isDragging: s.isDragging,
      dragType: s.dragType,
      dragItemId: s.dragItemId,
      startDrag: s.startDrag,
      endDrag: s.endDrag,
      showDragIndicator: s.showDragIndicator,
      hideIndicator: s.hideIndicator,
    }))
  );
  const projects = useAppStore((s) => s.projects);
  const setProjects = useAppStore((s) => s.setProjects);
  const currentUser = useAppStore((s) => s.currentUser);
  // Per-project rights: admins, superusers and the project's manager may move
  // schedule items; a staff booking may also be moved by the person it books.
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
  
  const dragDataRef = useRef<DragData | null>(null);
  const currentXRef = useRef(0);

  // Document listeners for an active drag (mouse and touch). They are
  // registered once at drag start and removed only on mouse-up / touch-end /
  // touch-cancel or unmount: stable trampolines that call the LATEST handlers
  // through refs. (Registering the handlers themselves and removing them from
  // an effect keyed on their deps silently abandoned the drag whenever
  // `projects` or `cellWidth` changed mid-gesture, e.g. on a WebSocket
  // refetch or a Ctrl+wheel zoom.)
  const pointerMoveHandlerRef = useRef<(e: MouseEvent | TouchEvent) => void>(() => {});
  const pointerUpHandlerRef = useRef<() => Promise<void>>(async () => {});
  const cancelHandlerRef = useRef<() => void>(() => {});
  const onDocumentPointerMove = useCallback((e: MouseEvent | TouchEvent) => {
    pointerMoveHandlerRef.current(e);
  }, []);
  const onDocumentPointerUp = useCallback((e: MouseEvent | TouchEvent) => {
    // A handled touchend must not also produce the synthesized
    // mousedown/mouseup/click (which would restart the drag or double-click).
    if (e.type === 'touchend' && e.cancelable) e.preventDefault();
    void pointerUpHandlerRef.current();
  }, []);
  const onDocumentTouchCancel = useCallback(() => {
    cancelHandlerRef.current();
  }, []);
  const attachDragListeners = useCallback(() => {
    document.addEventListener('mousemove', onDocumentPointerMove);
    document.addEventListener('mouseup', onDocumentPointerUp);
    document.addEventListener('touchmove', onDocumentPointerMove, NON_PASSIVE);
    document.addEventListener('touchend', onDocumentPointerUp);
    document.addEventListener('touchcancel', onDocumentTouchCancel);
  }, [onDocumentPointerMove, onDocumentPointerUp, onDocumentTouchCancel]);
  const detachDragListeners = useCallback(() => {
    document.removeEventListener('mousemove', onDocumentPointerMove);
    document.removeEventListener('mouseup', onDocumentPointerUp);
    document.removeEventListener('touchmove', onDocumentPointerMove, NON_PASSIVE);
    document.removeEventListener('touchend', onDocumentPointerUp);
    document.removeEventListener('touchcancel', onDocumentTouchCancel);
  }, [onDocumentPointerMove, onDocumentPointerUp, onDocumentTouchCancel]);
  
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
  
  // Calculate date from pixel position
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
    
    return formatDateLocal(newDate);
  }, [formatDateLocal]);
  
  // Calculate lag days for a phase based on dependencies
  const calculatePhaseLagDays = useCallback((
    phaseId: number,
    projectId: number,
    newStartDate: string
  ): number | null => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return null;
    
    const phase = (project.phases ?? []).find(p => p.id === phaseId);
    if (!phase) return null;
    
    const deps = phase.dependencies ?? [];
    if (deps.length === 0) return null;
    
    // Calculate original duration
    const origStart = parseLocalDate(phase.start_date);
    const origEnd = parseLocalDate(phase.end_date);
    const durationMs = origEnd.getTime() - origStart.getTime();
    
    const newStart = parseLocalDate(newStartDate);
    const newEnd = new Date(newStart.getTime() + durationMs);
    
    // Track worst lag
    let worstLagDays: number | null = null;
    
    for (const dep of deps) {
      // Resolve by `entity` (a phase may depend on a subphase); legacy
      // entries without it resolve phase-first.
      const depPhase = resolveDependencyPredecessor(project, dep)?.item;
      if (!depPhase) continue;
      
      const depStart = parseLocalDate(depPhase.start_date);
      const depEnd = parseLocalDate(depPhase.end_date);
      let lagDays: number;
      
      if (dep.type === 'SS') {
        lagDays = Math.round((newStart.getTime() - depStart.getTime()) / 86400000);
      } else if (dep.type === 'FF') {
        lagDays = Math.round((newEnd.getTime() - depEnd.getTime()) / 86400000);
      } else if (dep.type === 'SF') {
        lagDays = Math.round((newEnd.getTime() - depStart.getTime()) / 86400000);
      } else {
        // FS (default): successor start vs predecessor end + 1 day
        const expectedStart = new Date(depEnd);
        expectedStart.setDate(expectedStart.getDate() + 1);
        lagDays = Math.round((newStart.getTime() - expectedStart.getTime()) / 86400000);
      }
      
      if (worstLagDays === null || lagDays < worstLagDays) {
        worstLagDays = lagDays;
      }
    }
    
    return worstLagDays;
  }, [projects]);
  
  // Find subphase in project
  const findSubphaseInProject = useCallback((project: Project, subphaseId: number): Subphase | null => {
    const searchInChildren = (children: Subphase[]): Subphase | null => {
      for (const child of children) {
        if (child.id === subphaseId) return child;
        if (child.children?.length) {
          const found = searchInChildren(child.children);
          if (found) return found;
        }
      }
      return null;
    };
    
    for (const phase of project.phases ?? []) {
      if (phase.children?.length) {
        const found = searchInChildren(phase.children);
        if (found) return found;
      }
    }
    return null;
  }, []);
  
  // Calculate lag days for a subphase based on dependencies
  const calculateSubphaseLagDays = useCallback((
    subphaseId: number,
    projectId: number,
    newStartDate: string
  ): number | null => {
    const project = projects.find(p => p.id === projectId);
    if (!project) return null;
    
    const subphase = findSubphaseInProject(project, subphaseId);
    if (!subphase) return null;
    
    const deps = subphase.dependencies ?? [];
    if (deps.length === 0) return null;
    
    // Calculate original duration
    const origStart = parseLocalDate(subphase.start_date);
    const origEnd = parseLocalDate(subphase.end_date);
    const durationMs = origEnd.getTime() - origStart.getTime();
    
    const newStart = parseLocalDate(newStartDate);
    const newEnd = new Date(newStart.getTime() + durationMs);
    
    // Track worst lag
    let worstLagDays: number | null = null;
    
    for (const dep of deps) {
      // Find the predecessor by `entity` (phase or subphase); legacy entries
      // without it resolve phase-first, like every other dependency reader.
      const depSubphase = resolveDependencyPredecessor(project, dep)?.item;
      if (!depSubphase) continue;
      
      const depStart = parseLocalDate(depSubphase.start_date);
      const depEnd = parseLocalDate(depSubphase.end_date);
      let lagDays: number;
      
      if (dep.type === 'SS') {
        lagDays = Math.round((newStart.getTime() - depStart.getTime()) / 86400000);
      } else if (dep.type === 'FF') {
        lagDays = Math.round((newEnd.getTime() - depEnd.getTime()) / 86400000);
      } else if (dep.type === 'SF') {
        lagDays = Math.round((newEnd.getTime() - depStart.getTime()) / 86400000);
      } else {
        // FS (default)
        const expectedStart = new Date(depEnd);
        expectedStart.setDate(expectedStart.getDate() + 1);
        lagDays = Math.round((newStart.getTime() - expectedStart.getTime()) / 86400000);
      }
      
      if (worstLagDays === null || lagDays < worstLagDays) {
        worstLagDays = lagDays;
      }
    }
    
    return worstLagDays;
  }, [projects, findSubphaseInProject]);
  
  // Handle pointer (mouse or touch) move during drag
  const handlePointerMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!dragDataRef.current) return;
    
    // The finger moves the bar, not the page.
    if ('touches' in e && e.cancelable) e.preventDefault();
    
    const clientX = getPointerClientX(e);
    currentXRef.current = clientX;
    const data = dragDataRef.current;
    const deltaX = clientX - data.startX;
    let newLeft = data.originalLeft + deltaX;
    
    // Snap to cell boundaries in week and month views for cleaner movement
    if (viewMode === 'week' || viewMode === 'month') {
      // Round to nearest cell
      const cellIndex = Math.round(newLeft / cellWidth);
      newLeft = cellIndex * cellWidth;
    }
    
    // Update element position visually
    if (data.element) {
      data.element.style.left = `${newLeft}px`;
      data.element.style.opacity = '0.8';
      data.element.style.zIndex = '1000';
    }
    
    // Calculate estimated new start date and show lag indicator
    const cells = getTimelineCellsFromDOM();
    if (cells && cells.length > 0 && data.element) {
      const estimatedStartDate = calculateDateFromPosition(newLeft, cells, cellWidth, viewMode);
      
      if (estimatedStartDate) {
        // Calculate lag days based on item type
        const lagDays = data.type === 'phase'
          ? calculatePhaseLagDays(data.id, data.projectId, estimatedStartDate)
          : calculateSubphaseLagDays(data.id, data.projectId, estimatedStartDate);
        
        if (lagDays !== null) {
          // Calculate position relative to timeline body
          const row = data.element.closest('[class*="row"]');
          if (row) {
            const rowTop = (row as HTMLElement).offsetTop;
            const barWidth = data.element.offsetWidth;
            const indicatorLeft = newLeft + barWidth / 2;  // Center of bar
            const indicatorTop = rowTop - 22;  // Above the row
            
            showDragIndicator(indicatorLeft, indicatorTop, lagDays);
          }
        } else {
          hideIndicator();
        }
      }
    }
  }, [cellWidth, viewMode, getTimelineCellsFromDOM, calculateDateFromPosition, calculatePhaseLagDays, calculateSubphaseLagDays, showDragIndicator, hideIndicator]);
  
  // Helper to commit drag update
  const commitDragUpdate = useCallback(async (
    data: DragData, 
    newStartDate: string, 
    newEndDate: string
  ) => {
    try {
      // Find the project
      const projectIndex = projects.findIndex(p => p.id === data.projectId);
      if (projectIndex === -1) {
        console.error('Project not found:', data.projectId);
        dragDataRef.current = null;
        endDrag();
        return;
      }
      
      // Calculate offset for children movement
      const dayOffset = daysBetweenDateStrings(data.originalStartDate, newStartDate);
      
      // If no movement, just end drag
      if (dayOffset === 0) {
        dragDataRef.current = null;
        endDrag();
        return;
      }
      
      // For project drag, ask for confirmation
      if (data.type === 'project') {
        const project = projects[projectIndex];
        const phaseCount = project.phases?.length ?? 0;
        // The document listeners were detached in handleMouseUp before this
        // commit, so nothing reacts to the pointer while the dialog is open;
        // the bar stays at the dropped position until the answer.
        const confirmed = await confirmAction({
          title: 'Move project',
          message: `Move project by ${dayOffset > 0 ? '+' : ''}${dayOffset} days?\n\nThis will move all ${phaseCount} phase(s), their subphases, and all staff/equipment assignments.`,
          confirmLabel: 'Move',
        });
        
        if (!confirmed) {
          // Reset element position
          if (data.element) {
            data.element.style.left = `${data.originalLeft}px`;
            data.element.classList.remove('dragging');
          }
          dragDataRef.current = null;
          endDrag();
          return;
        }
      }
      
      // Save undo state
      saveState(projects, 'drag');
      
      // Clone the project for mutations
      const projectCopy = cloneProject(projects[projectIndex]);
      
      // Collect all pending updates (for children that need to be saved)
      const childUpdates: PendingUpdate[] = [];
      
      if (data.type === 'project') {
        // Dragging project - update project dates and move all phases with it
        projectCopy.start_date = newStartDate;
        projectCopy.end_date = newEndDate;
        
        // Move all phases and their children by the same offset
        if (dayOffset !== 0) {
          movePhasesWithProject(projectCopy, dayOffset, childUpdates);
        }
        
      } else if (data.type === 'phase') {
        const phase = (projectCopy.phases ?? []).find(p => p.id === data.id);
        if (phase) {
          phase.start_date = newStartDate;
          phase.end_date = newEndDate;
          
          // Move all children (subphases) by the same offset
          if (phase.children?.length && dayOffset !== 0) {
            moveChildrenByOffset(phase.children, dayOffset, childUpdates);
          }
        }
      } else {
        // Subphase - update in tree and move its children
        const updateInTree = (children: Subphase[]): boolean => {
          for (const child of children) {
            if (child.id === data.id) {
              child.start_date = newStartDate;
              child.end_date = newEndDate;
              
              // Move nested children by the same offset
              if (child.children?.length && dayOffset !== 0) {
                moveChildrenByOffset(child.children, dayOffset, childUpdates);
              }
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
      }
      
      // Process auto-calculations (parent expansion, project dates) - only for phases/subphases
      let pendingUpdates: typeof childUpdates = [];
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
      } else if (data.type === 'staffAssignment') {
        // Update staff assignment in the project copy
        const assignment = projectCopy.staffAssignments?.find(a => a.id === data.id);
        if (assignment) {
          assignment.start_date = newStartDate;
          assignment.end_date = newEndDate;
        }
      } else if (data.type === 'equipmentAssignment') {
        // Update equipment assignment in the project copy
        const assignment = projectCopy.equipmentAssignments?.find(a => a.id === data.id);
        if (assignment) {
          assignment.start_date = newStartDate;
          assignment.end_date = newEndDate;
        }
      }
      // For project drag, we don't need auto-calculations since we're moving everything
      
      // Merge child updates into pending updates
      pendingUpdates.push(...childUpdates);
      
      // Update local state with all changes (including moved children)
      const updatedProjects = projects.map((p, idx) => 
        idx === projectIndex ? projectCopy : p
      );
      setProjects(updatedProjects);
      
      // Persist the dragged item to server
      if (data.type === 'project') {
        await updateProject(data.id, {
          start_date: newStartDate,
          end_date: newEndDate,
        });
      } else if (data.type === 'phase') {
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
      
      // Save all cascaded updates (children) to server
      if (pendingUpdates.length > 0) {
        await savePendingUpdates(pendingUpdates);
      }
      
    } catch (err) {
      // Optimistic-write failure protocol: reload + clear the undo stack.
      await recoverFromPersistFailure('Drag', err);
    }
    
    dragDataRef.current = null;
    endDrag();
  }, [saveState, setProjects, projects, endDrag]);
  
  // Handle mouse up - commit the drag
  const handleMouseUp = useCallback(async () => {
    // Hide indicator first
    hideIndicator();
    
    if (!dragDataRef.current) {
      endDrag();
      return;
    }
    
    const data = dragDataRef.current;
    
    // Reset element style immediately
    if (data.element) {
      data.element.style.opacity = '1';
      data.element.style.zIndex = '';
      data.element.classList.remove('dragging');
    }
    
    // Clean up listeners first
    detachDragListeners();
    
    // Get the final position
    const finalLeft = data.element ? parseFloat(data.element.style.left) || 0 : data.originalLeft;
    const deltaX = finalLeft - data.originalLeft;
    
    if (Math.abs(deltaX) < 2) {
      // No significant change, just cleanup
      dragDataRef.current = null;
      endDrag();
      return;
    }
    
    // Get timeline cells for inverse calculation
    const cells = getTimelineCellsFromDOM();
    
    if (!cells || cells.length === 0) {
      console.warn('Could not get timeline cells for date calculation');
      // Fall back to simple day calculation
      const daysDelta = Math.round(deltaX / cellWidth);
      const newStartDate = addDaysToDateString(data.originalStartDate, daysDelta);
      const newEndDate = data.isMilestone ? newStartDate : addDaysToDateString(data.originalEndDate, daysDelta);
      
      await commitDragUpdate(data, newStartDate, newEndDate);
      return;
    }
    
    // Use inverse of calculateBarPosition to get new date
    const newStartDate = calculateDateFromPosition(finalLeft, cells, cellWidth, viewMode);
    
    if (!newStartDate) {
      console.warn('Could not calculate date from position');
      dragDataRef.current = null;
      endDrag();
      return;
    }
    
    // Preserve original duration when dragging (use exact day difference)
    const origStart = parseLocalDate(data.originalStartDate);
    const origEnd = parseLocalDate(data.originalEndDate);
    // Normalize to midnight to avoid timezone issues
    origStart.setHours(0, 0, 0, 0);
    origEnd.setHours(0, 0, 0, 0);
    const durationDays = Math.round((origEnd.getTime() - origStart.getTime()) / 86400000);
    
    const newStartDateObj = parseLocalDate(newStartDate);
    newStartDateObj.setHours(0, 0, 0, 0);
    const newEndDateObj = new Date(newStartDateObj);
    newEndDateObj.setDate(newEndDateObj.getDate() + durationDays);
    
    const startDateStr = formatDateLocal(newStartDateObj);
    const endDateStr = data.isMilestone ? startDateStr : formatDateLocal(newEndDateObj);
    
    await commitDragUpdate(data, startDateStr, endDateStr);
  }, [cellWidth, viewMode, endDrag, detachDragListeners, getTimelineCellsFromDOM, calculateDateFromPosition, formatDateLocal, commitDragUpdate, hideIndicator]);

  // Abandon the drag without saving (touchcancel, unmount): the bar goes
  // back to where it was and no API call is made.
  const cancelDrag = useCallback(() => {
    detachDragListeners();
    const data = dragDataRef.current;
    if (!data) return;
    if (data.element) {
      data.element.style.left = data.originalInlineLeft;
      data.element.style.opacity = '';
      data.element.style.zIndex = '';
      data.element.classList.remove('dragging');
    }
    dragDataRef.current = null;
    useUIStore.getState().hideIndicator();
    useUIStore.getState().endDrag();
  }, [detachDragListeners]);

  // Keep the document trampolines pointing at the latest handlers.
  useLayoutEffect(() => {
    pointerMoveHandlerRef.current = handlePointerMove;
    pointerUpHandlerRef.current = handleMouseUp;
    cancelHandlerRef.current = cancelDrag;
  });
  
  // Start dragging a phase
  const startPhaseDrag = useCallback((
    e: React.MouseEvent,
    phaseId: number,
    projectId: number,
    startDate: string,
    endDate: string,
    isMilestone: boolean = false,
    targetElement?: HTMLElement
  ) => {
    // Only the project's editors may modify schedule data
    if (!canEditProjectId(projectId)) return;

    // Don't drag if clicking resize handle
    if ((e.target as HTMLElement).classList.contains('resize-handle')) return;

    // Don't allow dragging in equipment view (read-only)
    if (currentView === 'equipment') return;

    // Don't allow dragging projects/phases in staff view
    if (currentView === 'staff') return;

    e.preventDefault();
    e.stopPropagation();

    // Use provided element or find from event
    let element = targetElement || (e.currentTarget as HTMLElement);
    if (!element || (!element.classList?.contains('gantt-bar') && !element.dataset?.phaseId)) {
      element = (e.target as HTMLElement).closest('[data-phase-id]') as HTMLElement;
    }
    
    if (!element) {
      console.warn('Could not find element for drag');
      return;
    }
    
    dragDataRef.current = {
      id: phaseId,
      type: 'phase',
      projectId,
      startX: e.clientX,
      element,
      originalLeft: parseInt(element?.style.left || '0') || 0,
      originalInlineLeft: element.style.left,
      originalStartDate: startDate,
      originalEndDate: endDate,
      isMilestone,
    };
    
    currentXRef.current = e.clientX;
    
    // Add class for styling
    if (element) {
      element.classList.add('dragging');
    }
    
    startDrag('phase', phaseId);
    
    attachDragListeners();
  }, [canEditProjectId, currentView, attachDragListeners, startDrag]);
  
  // Start dragging a subphase
  const startSubphaseDrag = useCallback((
    e: React.MouseEvent,
    subphaseId: number,
    projectId: number,
    phaseId: number,
    startDate: string,
    endDate: string,
    isMilestone: boolean = false,
    targetElement?: HTMLElement
  ) => {
    if (!canEditProjectId(projectId)) return;

    // Don't drag if clicking resize handle
    if ((e.target as HTMLElement).classList.contains('resize-handle')) return;

    // Don't allow dragging in equipment view (read-only)
    if (currentView === 'equipment') return;

    // Don't allow dragging in staff view
    if (currentView === 'staff') return;

    e.preventDefault();
    e.stopPropagation();

    // Use provided element or find from event
    let element = targetElement || (e.currentTarget as HTMLElement);
    if (!element || (!element.classList?.contains('gantt-bar') && !element.dataset?.subphaseId)) {
      element = (e.target as HTMLElement).closest('[data-subphase-id]') as HTMLElement;
    }
    
    if (!element) {
      console.warn('Could not find element for subphase drag');
      return;
    }
    
    dragDataRef.current = {
      id: subphaseId,
      type: 'subphase',
      projectId,
      phaseId,
      startX: e.clientX,
      element,
      originalLeft: parseInt(element?.style.left || '0') || 0,
      originalInlineLeft: element.style.left,
      originalStartDate: startDate,
      originalEndDate: endDate,
      isMilestone,
    };
    
    currentXRef.current = e.clientX;
    
    // Add class for styling
    if (element) {
      element.classList.add('dragging');
    }
    
    startDrag('subphase', subphaseId);
    
    attachDragListeners();
  }, [canEditProjectId, currentView, attachDragListeners, startDrag]);
  
  // Start dragging a project
  const startProjectDrag = useCallback((
    e: React.MouseEvent,
    projectId: number,
    startDate: string,
    endDate: string,
    targetElement?: HTMLElement
  ) => {
    if (!canEditProjectId(projectId)) return;

    // Don't drag if clicking resize handle
    if ((e.target as HTMLElement).classList.contains('resize-handle')) return;

    // Don't allow dragging in equipment view (read-only)
    if (currentView === 'equipment') return;

    // Don't allow dragging in staff view
    if (currentView === 'staff') return;

    e.preventDefault();
    e.stopPropagation();

    // Use provided element or find from event
    let element = targetElement || (e.currentTarget as HTMLElement);
    if (!element || (!element.classList?.contains('gantt-bar') && !element.dataset?.projectId)) {
      element = (e.target as HTMLElement).closest('[data-project-id]') as HTMLElement;
    }
    
    if (!element) {
      console.warn('Could not find element for project drag');
      return;
    }
    
    dragDataRef.current = {
      id: projectId,
      type: 'project',
      projectId,
      startX: e.clientX,
      element,
      originalLeft: parseInt(element?.style.left || '0') || 0,
      originalInlineLeft: element.style.left,
      originalStartDate: startDate,
      originalEndDate: endDate,
      isMilestone: false,
    };
    
    currentXRef.current = e.clientX;
    
    // Add class for styling
    if (element) {
      element.classList.add('dragging');
    }
    
    startDrag('project', projectId);
    
    attachDragListeners();
  }, [canEditProjectId, currentView, attachDragListeners, startDrag]);
  
  // Start dragging a staff assignment
  const startStaffAssignmentDrag = useCallback((
    e: React.MouseEvent,
    assignmentId: number,
    projectId: number,
    startDate: string,
    endDate: string,
    targetElement?: HTMLElement,
    staffId?: number
  ) => {
    if (!canEditStaffAssignment(projectId, staffId)) return;

    // Don't drag if clicking resize handle
    if ((e.target as HTMLElement).classList.contains('resize-handle')) return;

    // Don't allow dragging in equipment view (read-only)
    if (currentView === 'equipment') return;

    // Don't allow dragging in staff view (read-only)
    if (currentView === 'staff') return;

    e.preventDefault();
    e.stopPropagation();

    // Use provided element or find from event
    let element = targetElement || (e.currentTarget as HTMLElement);
    if (!element || !element.dataset?.assignmentId) {
      element = (e.target as HTMLElement).closest('[data-assignment-id]') as HTMLElement;
    }

    if (!element) {
      console.warn('Could not find element for staff assignment drag');
      return;
    }
    
    dragDataRef.current = {
      id: assignmentId,
      type: 'staffAssignment',
      projectId,
      startX: e.clientX,
      element,
      originalLeft: parseInt(element?.style.left || '0') || 0,
      originalInlineLeft: element.style.left,
      originalStartDate: startDate,
      originalEndDate: endDate,
      isMilestone: false,
    };
    
    currentXRef.current = e.clientX;
    
    // Add class for styling
    if (element) {
      element.classList.add('dragging');
    }
    
    startDrag('staffAssignment', assignmentId);

    attachDragListeners();
  }, [canEditStaffAssignment, currentView, attachDragListeners, startDrag]);
  
  // Start dragging an equipment assignment
  const startEquipmentAssignmentDrag = useCallback((
    e: React.MouseEvent,
    assignmentId: number,
    projectId: number,
    startDate: string,
    endDate: string,
    targetElement?: HTMLElement
  ) => {
    if (!canEditProjectId(projectId)) return;

    // Don't drag if clicking resize handle
    if ((e.target as HTMLElement).classList.contains('resize-handle')) return;

    // Don't allow dragging in equipment view (read-only)
    if (currentView === 'equipment') return;

    // Don't allow dragging in staff view (read-only)
    if (currentView === 'staff') return;

    e.preventDefault();
    e.stopPropagation();

    // Use provided element or find from event
    let element = targetElement || (e.currentTarget as HTMLElement);
    if (!element || !element.dataset?.assignmentId) {
      element = (e.target as HTMLElement).closest('[data-assignment-id]') as HTMLElement;
    }

    if (!element) {
      console.warn('Could not find element for equipment assignment drag');
      return;
    }
    
    dragDataRef.current = {
      id: assignmentId,
      type: 'equipmentAssignment',
      projectId,
      startX: e.clientX,
      element,
      originalLeft: parseInt(element?.style.left || '0') || 0,
      originalInlineLeft: element.style.left,
      originalStartDate: startDate,
      originalEndDate: endDate,
      isMilestone: false,
    };
    
    currentXRef.current = e.clientX;
    
    // Add class for styling
    if (element) {
      element.classList.add('dragging');
    }
    
    startDrag('equipmentAssignment', assignmentId);
    
    attachDragListeners();
  }, [canEditProjectId, currentView, attachDragListeners, startDrag]);
  
  // Cleanup on unmount only: an unmount mid-drag abandons the drag cleanly.
  useEffect(() => cancelDrag, [cancelDrag]);
  
  return {
    isDragging,
    dragType,
    dragItemId,
    startProjectDrag,
    startPhaseDrag,
    startSubphaseDrag,
    startStaffAssignmentDrag,
    startEquipmentAssignmentDrag,
  };
}
