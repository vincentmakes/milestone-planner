/**
 * useResourceDragDrop
 *
 * Drag *source* side of dropping staff/equipment from the ResourcePanel (and
 * the Staff/Equipment views) onto the Gantt chart: permission check, drag
 * data, uiStore drag state and the body class. The drop itself -- creating
 * the assignment, What-If gating, permission per target -- is handled by
 * `ResourceDropOverlay` only; this hook deliberately has no create path.
 */

import { useCallback } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { canBookSelf, canManageAnyProject } from '@/utils/permissions';
import { format } from 'date-fns';
import { addDaysToDateString } from '@/utils/date';

const DEFAULT_DURATION_DAYS = 5;

export function useResourceDragDrop() {
  const resourceDrag = useUIStore((s) => s.resourceDrag);
  const startResourceDrag = useUIStore((s) => s.startResourceDrag);
  const updateResourceDragTarget = useUIStore((s) => s.updateResourceDragTarget);
  const endResourceDrag = useUIStore((s) => s.endResourceDrag);
  const currentUser = useAppStore((s) => s.currentUser);
  const staff = useAppStore((s) => s.staff);
  const projects = useAppStore((s) => s.projects);

  /**
   * Get the default allocation for a staff member (their max_capacity or 100)
   */
  const getStaffDefaultAllocation = useCallback((staffId: number): number => {
    const staffMember = staff.find(s => s.id === staffId);
    return staffMember?.max_capacity ?? 100;
  }, [staff]);

  /**
   * Start dragging a resource
   */
  const handleDragStart = useCallback((
    e: React.DragEvent,
    type: 'staff' | 'equipment',
    resourceId: number,
    resourceName: string
  ) => {
    // Anyone who manages a project may drag resources onto it; everyone whose
    // role books their own time (allow or approval mode) may drag themselves
    // (the drop target decides whether the project accepts).
    const allowed =
      canManageAnyProject(currentUser, projects) ||
      (type === 'staff' && canBookSelf(currentUser, resourceId));
    if (!allowed) {
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
  }, [currentUser, projects, startResourceDrag]);

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
    // previewStart is yyyy-MM-dd: parse it as local midnight, otherwise the
    // preview is a day short west of UTC (UTC parse + local format).
    const previewStart = dateFromPosition || format(new Date(), 'yyyy-MM-dd');
    const previewEnd = addDaysToDateString(previewStart, DEFAULT_DURATION_DAYS - 1);

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
    handleDragEnd,
    calculateDateFromPosition,
    getStaffDefaultAllocation,
  };
}
