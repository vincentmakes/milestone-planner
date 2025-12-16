/**
 * useResourceDragDrop
 * 
 * Hook for handling drag-drop of staff/equipment from ResourcePanel
 * onto projects/phases/subphases in the Gantt chart.
 * Creates assignments with a default 5-day duration.
 */

import { useCallback } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { createStaffAssignment, createEquipmentAssignment, loadAllProjects } from '@/api/endpoints/projects';
import { format, addDays } from 'date-fns';

const DEFAULT_DURATION_DAYS = 5;
const DEFAULT_ALLOCATION = 100;

export function useResourceDragDrop() {
  const resourceDrag = useUIStore((s) => s.resourceDrag);
  const startResourceDrag = useUIStore((s) => s.startResourceDrag);
  const updateResourceDragTarget = useUIStore((s) => s.updateResourceDragTarget);
  const endResourceDrag = useUIStore((s) => s.endResourceDrag);
  const setProjects = useAppStore((s) => s.setProjects);
  const currentUser = useAppStore((s) => s.currentUser);

  /**
   * Start dragging a resource
   */
  const handleDragStart = useCallback((
    e: React.DragEvent,
    type: 'staff' | 'equipment',
    resourceId: number,
    resourceName: string
  ) => {
    // Only allow superusers/admins to drag
    if (!currentUser || (currentUser.role !== 'superuser' && currentUser.role !== 'admin')) {
      e.preventDefault();
      return;
    }

    // Set drag data
    e.dataTransfer.setData('application/json', JSON.stringify({
      type,
      resourceId,
      resourceName,
    }));
    e.dataTransfer.effectAllowed = 'copy';

    // Start drag in store
    startResourceDrag(type, resourceId, resourceName);

    // Add body class for styling
    document.body.classList.add('resource-dragging');
  }, [currentUser, startResourceDrag]);

  /**
   * Handle drag over a drop target (project/phase/subphase row)
   */
  const handleDragOver = useCallback((
    e: React.DragEvent,
    projectId: number,
    phaseId: number | null,
    subphaseId: number | null,
    dateFromPosition?: string // Optional: date calculated from mouse position
  ) => {
    if (!resourceDrag.active) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';

    // Calculate preview dates
    let previewStart = dateFromPosition || format(new Date(), 'yyyy-MM-dd');
    let previewEnd = format(addDays(new Date(previewStart), DEFAULT_DURATION_DAYS - 1), 'yyyy-MM-dd');

    // Update target in store
    updateResourceDragTarget(projectId, phaseId, subphaseId, previewStart, previewEnd);
  }, [resourceDrag.active, updateResourceDragTarget]);

  /**
   * Handle drag leave
   */
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if leaving the actual target (not entering a child)
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (relatedTarget && (e.currentTarget as HTMLElement).contains(relatedTarget)) {
      return;
    }
    
    // Clear target but keep drag active
    updateResourceDragTarget(null, null, null, null, null);
  }, [updateResourceDragTarget]);

  /**
   * Handle drop - create the assignment
   */
  const handleDrop = useCallback(async (
    e: React.DragEvent,
    projectId: number,
    phaseId: number | null,
    subphaseId: number | null,
    startDate: string,
    endDate: string
  ) => {
    e.preventDefault();

    if (!resourceDrag.active || !resourceDrag.resourceId) {
      endResourceDrag();
      return;
    }

    const { type, resourceId } = resourceDrag;

    try {
      if (type === 'staff') {
        await createStaffAssignment({
          staff_id: resourceId,
          allocation: DEFAULT_ALLOCATION,
          start_date: startDate,
          end_date: endDate,
          project_id: subphaseId ? undefined : (phaseId ? undefined : projectId),
          phase_id: subphaseId ? undefined : (phaseId || undefined),
          subphase_id: subphaseId || undefined,
        });
      } else if (type === 'equipment') {
        await createEquipmentAssignment({
          equipment_id: resourceId,
          start_date: startDate,
          end_date: endDate,
          project_id: subphaseId ? undefined : (phaseId ? undefined : projectId),
          phase_id: subphaseId ? undefined : (phaseId || undefined),
          subphase_id: subphaseId || undefined,
        });
      }

      // Reload projects to show new assignment
      const updatedProjects = await loadAllProjects();
      setProjects(updatedProjects);
    } catch (error) {
      console.error('Failed to create assignment:', error);
    } finally {
      endResourceDrag();
      document.body.classList.remove('resource-dragging');
    }
  }, [resourceDrag, endResourceDrag, setProjects]);

  /**
   * Handle drag end (cleanup)
   */
  const handleDragEnd = useCallback(() => {
    endResourceDrag();
    document.body.classList.remove('resource-dragging');
  }, [endResourceDrag]);

  /**
   * Calculate date from mouse position on timeline
   */
  const calculateDateFromPosition = useCallback((
    clientX: number,
    timelineRect: DOMRect,
    scrollLeft: number,
    cellWidth: number,
    cells: Array<{ date: Date; dateStr: string }>
  ): string | null => {
    if (cells.length === 0) return null;

    const relativeX = clientX - timelineRect.left + scrollLeft;
    const cellIndex = Math.floor(relativeX / cellWidth);
    const clampedIndex = Math.max(0, Math.min(cellIndex, cells.length - 1));
    
    return cells[clampedIndex]?.dateStr || null;
  }, []);

  return {
    // State
    resourceDrag,
    isActive: resourceDrag.active,
    
    // Actions
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
    calculateDateFromPosition,
    
    // Constants
    DEFAULT_DURATION_DAYS,
    DEFAULT_ALLOCATION,
  };
}
