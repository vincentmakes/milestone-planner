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
import { createStaffAssignment, createEquipmentAssignment, loadAllProjects } from '@/api/endpoints/projects';
import { format, addDays } from 'date-fns';
import type { TimelineCell } from '../utils';
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
  const ensureProjectExpanded = useAppStore((s) => s.ensureProjectExpanded);
  const ensurePhaseExpanded = useAppStore((s) => s.ensurePhaseExpanded);
  const ensureSubphaseExpanded = useAppStore((s) => s.ensureSubphaseExpanded);
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

  // Calculate date from X position
  const getDateFromX = useCallback((x: number): string => {
    if (cells.length === 0) return format(new Date(), 'yyyy-MM-dd');
    const cellIndex = Math.floor(x / cellWidth);
    const clampedIndex = Math.max(0, Math.min(cellIndex, cells.length - 1));
    return cells[clampedIndex]?.dateStr || format(new Date(), 'yyyy-MM-dd');
  }, [cells, cellWidth]);

  // Find target row from Y position
  const findTargetFromY = useCallback((y: number): typeof hoveredTarget => {
    for (const project of projects) {
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
  }, [projects, rowPositions]);

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
    e.dataTransfer.dropEffect = 'copy';
    updatePositionFromEvent(e.clientX, e.clientY);
  }, [updatePositionFromEvent]);

  // Handle drop - create the assignment
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!hoveredTarget || !resourceDrag.resourceId || mouseX === null) {
      endResourceDrag();
      document.body.classList.remove('resource-dragging');
      return;
    }

    const startDate = getDateFromX(mouseX - (cellWidth * DEFAULT_DURATION_DAYS) / 2);
    const endDate = format(addDays(new Date(startDate), DEFAULT_DURATION_DAYS - 1), 'yyyy-MM-dd');

    // Determine the assignment target level
    const isProjectLevel = !hoveredTarget.phaseId && !hoveredTarget.subphaseId;
    const isPhaseLevel = hoveredTarget.phaseId && !hoveredTarget.subphaseId;
    const isSubphaseLevel = !!hoveredTarget.subphaseId;

    try {
      if (resourceDrag.type === 'staff') {
        // Use staff's max_capacity as default allocation
        const allocation = getStaffDefaultAllocation(resourceDrag.resourceId);
        await createStaffAssignment({
          staff_id: resourceDrag.resourceId,
          allocation,
          start_date: startDate,
          end_date: endDate,
          // Always pass project_id for all levels
          project_id: hoveredTarget.projectId,
          phase_id: isPhaseLevel ? hoveredTarget.phaseId! : undefined,
          subphase_id: isSubphaseLevel ? hoveredTarget.subphaseId! : undefined,
        });
      } else if (resourceDrag.type === 'equipment') {
        await createEquipmentAssignment({
          equipment_id: resourceDrag.resourceId,
          start_date: startDate,
          end_date: endDate,
          // Always pass project_id for all levels
          project_id: hoveredTarget.projectId,
          phase_id: isPhaseLevel ? hoveredTarget.phaseId! : undefined,
          subphase_id: isSubphaseLevel ? hoveredTarget.subphaseId! : undefined,
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
    } catch (error) {
      console.error('Failed to create assignment:', error);
    } finally {
      endResourceDrag();
      document.body.classList.remove('resource-dragging');
    }
  }, [hoveredTarget, resourceDrag, mouseX, cellWidth, getDateFromX, endResourceDrag, setProjects, ensureProjectExpanded, ensurePhaseExpanded, ensureSubphaseExpanded, getStaffDefaultAllocation]);

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

    const barWidth = cellWidth * DEFAULT_DURATION_DAYS;
    const barLeft = mouseX - barWidth / 2;
    const barTop = rowPos.top + (rowPos.height - 20) / 2;

    return {
      left: Math.max(0, barLeft),
      top: barTop,
      width: barWidth,
      height: 20,
    };
  }, [hoveredTarget, mouseX, cellWidth, rowPositions]);

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
      {hoveredTarget && (
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
      {previewBar && (
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
        <span>Drop to place {resourceDrag.type === 'staff' ? 'staff' : 'equipment'} assignment</span>
        <span className={styles.hint}>Press Esc to cancel</span>
      </div>
    </div>
  );
}
