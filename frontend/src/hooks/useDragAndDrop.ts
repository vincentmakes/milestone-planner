/**
 * useDragAndDrop - Hook for dragging phases/subphases/assignments on the timeline
 * Handles mouse events and calculates day offsets based on cell width
 */

import { useCallback, useRef, useEffect } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { updatePhase, updateSubphase, updateProject, updateStaffAssignment, updateEquipmentAssignment, loadAllProjects } from '@/api/endpoints/projects';
import { useUndoStore } from '@/stores/undoStore';
import { 
  processPhaseMove, 
  processSubphaseMove, 
  savePendingUpdates,
  cloneProject,
  moveChildrenByOffset,
  movePhasesWithProject
} from '@/components/gantt/utils';
import type { ViewMode, Subphase, Project } from '@/types';

interface DragData {
  id: number;
  type: 'project' | 'phase' | 'subphase' | 'staffAssignment' | 'equipmentAssignment';
  projectId: number;
  phaseId?: number;
  startX: number;
  element: HTMLElement | null;
  originalLeft: number;
  originalStartDate: string;
  originalEndDate: string;
  isMilestone: boolean;
  // For project drag - track if user confirmed
  confirmed?: boolean;
}

export function useDragAndDrop() {
  const { isDragging, dragType, dragItemId, startDrag, endDrag, showDragIndicator, hideIndicator } = useUIStore();
  const { projects, setProjects, cellWidth, currentView, viewMode } = useAppStore();
  const { saveState } = useUndoStore();
  
  const dragDataRef = useRef<DragData | null>(null);
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
    const origStart = new Date(phase.start_date);
    const origEnd = new Date(phase.end_date);
    const durationMs = origEnd.getTime() - origStart.getTime();
    
    const newStart = new Date(newStartDate);
    const newEnd = new Date(newStart.getTime() + durationMs);
    
    // Track worst lag
    let worstLagDays: number | null = null;
    
    for (const dep of deps) {
      const depPhase = (project.phases ?? []).find(p => p.id === dep.id);
      if (!depPhase) continue;
      
      const depStart = new Date(depPhase.start_date);
      const depEnd = new Date(depPhase.end_date);
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
    const origStart = new Date(subphase.start_date);
    const origEnd = new Date(subphase.end_date);
    const durationMs = origEnd.getTime() - origStart.getTime();
    
    const newStart = new Date(newStartDate);
    const newEnd = new Date(newStart.getTime() + durationMs);
    
    // Track worst lag
    let worstLagDays: number | null = null;
    
    for (const dep of deps) {
      // Find predecessor subphase
      const depSubphase = findSubphaseInProject(project, dep.id);
      if (!depSubphase) continue;
      
      const depStart = new Date(depSubphase.start_date);
      const depEnd = new Date(depSubphase.end_date);
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
  
  // Handle mouse move during drag
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragDataRef.current) return;
    
    currentXRef.current = e.clientX;
    const data = dragDataRef.current;
    const deltaX = e.clientX - data.startX;
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
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    
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
      const addDays = (dateStr: string, days: number): string => {
        const date = new Date(dateStr);
        date.setDate(date.getDate() + days);
        return date.toISOString().split('T')[0];
      };
      
      const newStartDate = addDays(data.originalStartDate, daysDelta);
      const newEndDate = data.isMilestone ? newStartDate : addDays(data.originalEndDate, daysDelta);
      
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
    const origStart = new Date(data.originalStartDate);
    const origEnd = new Date(data.originalEndDate);
    // Normalize to midnight to avoid timezone issues
    origStart.setHours(0, 0, 0, 0);
    origEnd.setHours(0, 0, 0, 0);
    const durationDays = Math.round((origEnd.getTime() - origStart.getTime()) / 86400000);
    
    const newStartDateObj = new Date(newStartDate);
    newStartDateObj.setHours(0, 0, 0, 0);
    const newEndDateObj = new Date(newStartDateObj);
    newEndDateObj.setDate(newEndDateObj.getDate() + durationDays);
    
    const startDateStr = formatDateLocal(newStartDateObj);
    const endDateStr = data.isMilestone ? startDateStr : formatDateLocal(newEndDateObj);
    
    await commitDragUpdate(data, startDateStr, endDateStr);
  }, [cellWidth, viewMode, endDrag, handleMouseMove, saveState, setProjects, projects, hideIndicator]);
  
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
      const oldStartMs = new Date(data.originalStartDate).getTime();
      const newStartMs = new Date(newStartDate).getTime();
      const dayOffset = Math.round((newStartMs - oldStartMs) / 86400000);
      
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
        const confirmed = window.confirm(
          `Move project by ${dayOffset > 0 ? '+' : ''}${dayOffset} days?\n\nThis will move all ${phaseCount} phase(s), their subphases, and all staff/equipment assignments.`
        );
        
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
      const childUpdates: { type: 'phase' | 'subphase' | 'project' | 'staffAssignment' | 'equipmentAssignment'; id: number; start_date: string; end_date: string }[] = [];
      
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
        console.log(`Saving ${pendingUpdates.length} cascaded updates`);
        await savePendingUpdates(pendingUpdates);
      }
      
    } catch (err) {
      console.error('Failed to update item:', err);
      // On error, reload to get correct state
      const reloadedProjects = await loadAllProjects();
      setProjects(reloadedProjects);
    }
    
    dragDataRef.current = null;
    endDrag();
  }, [saveState, setProjects, projects, endDrag]);
  
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
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [currentView, handleMouseMove, handleMouseUp, startDrag]);
  
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
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [currentView, handleMouseMove, handleMouseUp, startDrag]);
  
  // Start dragging a project
  const startProjectDrag = useCallback((
    e: React.MouseEvent,
    projectId: number,
    startDate: string,
    endDate: string,
    targetElement?: HTMLElement
  ) => {
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
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [currentView, handleMouseMove, handleMouseUp, startDrag]);
  
  // Start dragging a staff assignment
  const startStaffAssignmentDrag = useCallback((
    e: React.MouseEvent,
    assignmentId: number,
    projectId: number,
    startDate: string,
    endDate: string,
    targetElement?: HTMLElement
  ) => {
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
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [currentView, handleMouseMove, handleMouseUp, startDrag]);
  
  // Start dragging an equipment assignment
  const startEquipmentAssignmentDrag = useCallback((
    e: React.MouseEvent,
    assignmentId: number,
    projectId: number,
    startDate: string,
    endDate: string,
    targetElement?: HTMLElement
  ) => {
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
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [currentView, handleMouseMove, handleMouseUp, startDrag]);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);
  
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
