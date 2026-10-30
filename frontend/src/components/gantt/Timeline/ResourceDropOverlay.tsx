/**
 * ResourceDropOverlay
 * 
 * Overlay shown when dragging resources from ResourcePanel.
 * Shows drop zones and preview bar for assignment creation.
 * Uses HTML5 drag events for proper drag-drop handling.
 */

import { useCallback, useMemo, useEffect, useState, useRef } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { createStaffAssignment, createEquipmentAssignment, loadAllProjects } from '@/api/endpoints/projects';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { canBookEquipment, canEditAssignment } from '@/utils/permissions';
import { isPendingResponse } from '@/api/endpoints/approvals';
import { flashSentForApproval } from '@/utils/pendingBookings';
import type { TimelineCell } from '../utils';
import { calculateBarPosition, centredDayRangeAtX } from '../utils/timeline';
import type { Project } from '@/types';
import styles from './ResourceDropOverlay.module.css';

interface ResourceDropOverlayProps {
  projects: Project[];
  cells: TimelineCell[];
  cellWidth: number;
  totalWidth: number;
  containerRef: React.RefObject<HTMLDivElement>;
  rowPositions: Map<string, { top: number; height: number }>;
}

const DEFAULT_DURATION_DAYS = 5;

export function ResourceDropOverlay({
  projects,
  cells,
  cellWidth,
  totalWidth,
  containerRef,
  rowPositions,
}: ResourceDropOverlayProps) {
  const resourceDrag = useUIStore((s) => s.resourceDrag);
  const endResourceDrag = useUIStore((s) => s.endResourceDrag);
  const setProjects = useAppStore((s) => s.setProjects);
  const staff = useAppStore((s) => s.staff);
  const currentUser = useAppStore((s) => s.currentUser);
  const ensureProjectExpanded = useViewStore((s) => s.ensureProjectExpanded);
  const ensurePhaseExpanded = useViewStore((s) => s.ensurePhaseExpanded);
  const ensureSubphaseExpanded = useViewStore((s) => s.ensureSubphaseExpanded);
  const viewMode = useViewStore((s) => s.viewMode);
  // A drop creates an assignment, which cannot show until Apply in What-If.
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  const dropBlockedReason = whatIfMode ? whatIfUnavailableMessage('Dropping resources') : null;
  const overlayRef = useRef<HTMLDivElement>(null);
  
  // Track position for preview bar
  const [mouseX, setMouseX] = useState<number | null>(null);
  const [hoveredTarget, setHoveredTarget] = useState<{
    projectId: number;
    phaseId: number | null;
    subphaseId: number | null;
    rowKey: string;
  } | null>(null);

  /**
   * Get the default allocation for a staff member (their max_capacity or 100)
   */
  const getStaffDefaultAllocation = useCallback((staffId: number): number => {
    const staffMember = staff.find(s => s.id === staffId);
    return staffMember?.max_capacity ?? 100;
  }, [staff]);

  // Handle cancel
  const handleCancel = useCallback(() => {
    endResourceDrag();
    document.body.classList.remove('resource-dragging');
  }, [endResourceDrag]);

  // Listen for Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCancel();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleCancel]);

  // The 5-day range a drop at pixel x creates, centred on the pointer. Shared
  // by the preview and the drop so the bar shows exactly what gets booked —
  // 5 calendar days in every view mode (not 5 weeks/months when zoomed out).
  const getDropRange = useCallback(
    (x: number) => centredDayRangeAtX(x, cells, cellWidth, viewMode, DEFAULT_DURATION_DAYS),
    [cells, cellWidth, viewMode]
  );

  // Whether the dragged resource may land on this project: equipment needs
  // equipment_bookings.manage there, a person may also be dropped by themselves when
  // their role may book itself (assignments.self_create, allow or approval).
  const canDropOn = useCallback((project: Project): boolean => {
    if (resourceDrag.type === 'staff') {
      return canEditAssignment(currentUser, project, resourceDrag.resourceId, 'assignments.self_create');
    }
    return canBookEquipment(currentUser, project);
  }, [currentUser, resourceDrag.type, resourceDrag.resourceId]);

  // Find target row from Y position. Projects the user may not drop on are
  // skipped, so they never light up as a target.
  const findTargetFromY = useCallback((y: number): typeof hoveredTarget => {
    for (const project of projects) {
      if (!canDropOn(project)) continue;
      const projectKey = `project-${project.id}`;
      const projectPos = rowPositions.get(projectKey);
      
      if (projectPos && y >= projectPos.top && y < projectPos.top + projectPos.height) {
        return {
          projectId: project.id,
          phaseId: null,
          subphaseId: null,
          rowKey: projectKey,
        };
      }

      // Check phase rows
      for (const phase of project.phases || []) {
        const phaseKey = `phase-${phase.id}`;
        const phasePos = rowPositions.get(phaseKey);
        
        if (phasePos && y >= phasePos.top && y < phasePos.top + phasePos.height) {
          return {
            projectId: project.id,
            phaseId: phase.id,
            subphaseId: null,
            rowKey: phaseKey,
          };
        }

        // Check subphase rows (recursive)
        const checkSubphases = (subphases: typeof phase.children, parentPhaseId: number): typeof hoveredTarget => {
          for (const sp of subphases || []) {
            const spKey = `subphase-${sp.id}`;
            const spPos = rowPositions.get(spKey);
            
            if (spPos && y >= spPos.top && y < spPos.top + spPos.height) {
              return {
                projectId: project.id,
                phaseId: parentPhaseId,
                subphaseId: sp.id,
                rowKey: spKey,
              };
            }
            
            if (sp.children?.length) {
              const result = checkSubphases(sp.children, parentPhaseId);
              if (result) return result;
            }
          }
          return null;
        };
        
        const subphaseTarget = checkSubphases(phase.children, phase.id);
        if (subphaseTarget) return subphaseTarget;
      }
    }
    return null;
  }, [projects, rowPositions, canDropOn]);

  // Update position from event coordinates
  const updatePositionFromEvent = useCallback((clientX: number, clientY: number) => {
    if (!containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const scrollLeft = containerRef.current.scrollLeft || 0;
    const scrollTop = containerRef.current.scrollTop || 0;
    
    const x = clientX - rect.left + scrollLeft;
    const y = clientY - rect.top + scrollTop;
    
    setMouseX(x);
    setHoveredTarget(findTargetFromY(y));
  }, [containerRef, findTargetFromY]);

  // Handle drag over - required for drop to work
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dropBlockedReason) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.dataTransfer.dropEffect = 'copy';
    updatePositionFromEvent(e.clientX, e.clientY);
  }, [updatePositionFromEvent, dropBlockedReason]);

  // Handle drop - create the assignment
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const targetProject = hoveredTarget
      ? projects.find((p) => p.id === hoveredTarget.projectId)
      : undefined;
    if (dropBlockedReason || !hoveredTarget || !resourceDrag.resourceId || mouseX === null || !targetProject || !canDropOn(targetProject)) {
      endResourceDrag();
      document.body.classList.remove('resource-dragging');
      return;
    }

    // Calendar-day arithmetic on the strings (see centredDayRangeAtX):
    // `new Date('YYYY-MM-DD')` is UTC midnight and would land a day early
    // west of UTC (a 4-day booking).
    const range = getDropRange(mouseX);
    if (!range) {
      endResourceDrag();
      document.body.classList.remove('resource-dragging');
      return;
    }
    const { start_date: startDate, end_date: endDate } = range;

    // Determine the assignment target level
    const isProjectLevel = !hoveredTarget.phaseId && !hoveredTarget.subphaseId;
    const isPhaseLevel = hoveredTarget.phaseId && !hoveredTarget.subphaseId;
    const isSubphaseLevel = !!hoveredTarget.subphaseId;

    let sentForApproval = false;
    try {
      if (resourceDrag.type === 'staff') {
        // Use staff's max_capacity as default allocation
        const allocation = getStaffDefaultAllocation(resourceDrag.resourceId);
        // An own booking may need approval: the server then files a request
        // (202) and the pending row arrives with the reload below.
        // On a phase / subphase the booking is unpinned, like the dialog's
        // default: no dates sent and `unpinned`, so the server gives a first
        // booking the card's current dates (read under the card lock) and
        // places a second one in a free stretch or half of the first. The
        // user pins it to the card with the pin. At project level it gets
        // the dropped days.
        const onCard = Boolean(isPhaseLevel || isSubphaseLevel);
        const res = await createStaffAssignment({
          staff_id: resourceDrag.resourceId,
          allocation,
          ...(onCard ? { unpinned: true } : { start_date: startDate, end_date: endDate }),
          // Always pass project_id for all levels
          project_id: hoveredTarget.projectId,
          phase_id: isPhaseLevel ? hoveredTarget.phaseId! : undefined,
          subphase_id: isSubphaseLevel ? hoveredTarget.subphaseId! : undefined,
        });
        sentForApproval = isPendingResponse(res);
      } else if (resourceDrag.type === 'equipment') {
        // Equipment is booked on the project, also when dropped on a phase
        // or subphase row (with the dropped days).
        await createEquipmentAssignment({
          equipment_id: resourceDrag.resourceId,
          start_date: startDate,
          end_date: endDate,
          project_id: hoveredTarget.projectId,
        });
      }

      // Auto-expand the target to show the new assignment
      if (isProjectLevel) {
        ensureProjectExpanded(hoveredTarget.projectId);
      } else if (isPhaseLevel && hoveredTarget.phaseId) {
        ensureProjectExpanded(hoveredTarget.projectId);
        ensurePhaseExpanded(hoveredTarget.phaseId);
      } else if (isSubphaseLevel && hoveredTarget.subphaseId) {
        ensureProjectExpanded(hoveredTarget.projectId);
        if (hoveredTarget.phaseId) ensurePhaseExpanded(hoveredTarget.phaseId);
        ensureSubphaseExpanded(hoveredTarget.subphaseId);
      }

      // Reload projects
      const updatedProjects = await loadAllProjects();
      setProjects(updatedProjects);
      if (sentForApproval) flashSentForApproval();
    } catch (error) {
      console.error('Failed to create assignment:', error);
      useUIStore
        .getState()
        .showFlash(`Could not create the assignment: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      endResourceDrag();
      document.body.classList.remove('resource-dragging');
    }
  }, [dropBlockedReason, hoveredTarget, resourceDrag, mouseX, projects, canDropOn, getDropRange, endResourceDrag, setProjects, ensureProjectExpanded, ensurePhaseExpanded, ensureSubphaseExpanded, getStaffDefaultAllocation]);

  // Handle drag leave - clean up when leaving
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only handle if actually leaving the overlay
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (overlayRef.current && !overlayRef.current.contains(relatedTarget)) {
      setHoveredTarget(null);
      setMouseX(null);
    }
  }, []);

  // Calculate preview bar position
  const previewBar = useMemo(() => {
    if (!hoveredTarget || mouseX === null) return null;
    
    const rowPos = rowPositions.get(hoveredTarget.rowKey);
    if (!rowPos) return null;

    // Drawn from the range the drop will create, with the same scale as
    // every other bar, so its width is 5 days in any view mode.
    const range = getDropRange(mouseX);
    if (!range) return null;
    const bar = calculateBarPosition(range.start_date, range.end_date, cells, cellWidth, viewMode);
    if (!bar) return null;
    const barTop = rowPos.top + (rowPos.height - 20) / 2;

    return {
      left: Math.max(0, bar.left),
      top: barTop,
      width: bar.width,
      height: 20,
    };
  }, [hoveredTarget, mouseX, rowPositions, getDropRange, cells, cellWidth, viewMode]);

  // Only render when resource drag is active
  if (!resourceDrag.active) return null;

  return (
    <div 
      ref={overlayRef}
      className={styles.overlay}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {/* Drop zone highlights */}
      {hoveredTarget && !dropBlockedReason && (
        <div
          className={styles.dropZone}
          style={{
            top: rowPositions.get(hoveredTarget.rowKey)?.top || 0,
            height: rowPositions.get(hoveredTarget.rowKey)?.height || 32,
            width: totalWidth,
          }}
        />
      )}

      {/* Preview bar */}
      {previewBar && !dropBlockedReason && (
        <div
          className={`${styles.previewBar} ${resourceDrag.type === 'staff' ? styles.staff : styles.equipment}`}
          style={{
            left: previewBar.left,
            top: previewBar.top,
            width: previewBar.width,
            height: previewBar.height,
          }}
        >
          <span className={styles.previewLabel}>
            {resourceDrag.resourceName} ({DEFAULT_DURATION_DAYS}d{resourceDrag.type === 'staff' && resourceDrag.resourceId ? `, ${getStaffDefaultAllocation(resourceDrag.resourceId)}%` : ''})
          </span>
        </div>
      )}

      {/* Instructions */}
      <div className={styles.instructions}>
        {dropBlockedReason ? (
          <span role="status">{dropBlockedReason}</span>
        ) : (
          <span>Drop to place {resourceDrag.type === 'staff' ? 'staff' : 'equipment'} assignment</span>
        )}
        <span className={styles.hint}>Press Esc to cancel</span>
      </div>
    </div>
  );
}
