/**
 * usePhantomSibling Hook
 * 
 * Manages phantom sibling mode for quick sequential phase/subphase creation.
 * Shift+click on a phase/subphase dependency zone to create a new sibling
 * that follows the cursor until clicked to place.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import type { Phase, Subphase, Project } from '@/types';
import type { TimelineCell } from '@/components/gantt/utils';
import { format, addDays, differenceInDays } from 'date-fns';

// Phase colors (matching vanilla JS)
const PHASE_COLOR = '#ec4899'; // Pink/magenta for phases

// Depth colors for subphases (matching vanilla JS getDepthColor)
const DEPTH_COLORS = [
  '#06b6d4', // cyan - depth 1
  '#8b5cf6', // purple - depth 2
  '#f59e0b', // amber - depth 3
  '#10b981', // emerald - depth 4
  '#ef4444', // red - depth 5+
];

function getDepthColor(depth: number): string {
  return DEPTH_COLORS[Math.min(depth - 1, DEPTH_COLORS.length - 1)] || DEPTH_COLORS[0];
}

// Helper to find subphase depth in hierarchy
function getSubphaseDepth(project: Project, subphaseId: number): number {
  for (const phase of project.phases || []) {
    const result = findSubphaseDepthRecursive(phase.children || [], subphaseId, 1);
    if (result !== null) return result;
  }
  return 1;
}

function findSubphaseDepthRecursive(
  children: Subphase[],
  targetId: number,
  currentDepth: number
): number | null {
  for (const child of children) {
    if (child.id === targetId) return currentDepth;
    if (child.children && child.children.length > 0) {
      const result = findSubphaseDepthRecursive(child.children, targetId, currentDepth + 1);
      if (result !== null) return result;
    }
  }
  return null;
}

// Helper to find a subphase by ID anywhere in the hierarchy
function findSubphaseById(phases: Phase[], subphaseId: number): Subphase | null {
  for (const phase of phases) {
    const found = findSubphaseInChildren(phase.children || [], subphaseId);
    if (found) return found;
  }
  return null;
}

function findSubphaseInChildren(children: Subphase[], targetId: number): Subphase | null {
  for (const child of children) {
    if (child.id === targetId) return child;
    if (child.children && child.children.length > 0) {
      const found = findSubphaseInChildren(child.children, targetId);
      if (found) return found;
    }
  }
  return null;
}

// Get index of subphase within its parent's children array
function getSubphaseIndexInParent(project: Project, subphaseId: number): number {
  const subphase = findSubphaseById(project.phases || [], subphaseId);
  if (!subphase) return 0;

  // Determine parent from subphase fields
  const isParentSubphase = !!subphase.parent_subphase_id;
  const parentId = isParentSubphase ? subphase.parent_subphase_id : subphase.parent_phase_id;

  let siblings: Subphase[] = [];
  if (!isParentSubphase) {
    const phase = (project.phases || []).find((p) => p.id === parentId);
    siblings = phase?.children || [];
  } else {
    const parentSubphase = findSubphaseById(project.phases || [], parentId!);
    siblings = parentSubphase?.children || [];
  }

  return siblings.findIndex((s) => s.id === subphaseId);
}

// Format date as YYYY-MM-DD
function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

// Parse date string to Date (handling ISO timestamps)
function parseDate(dateStr: string): Date {
  const cleanDate = dateStr.split('T')[0];
  return new Date(cleanDate + 'T12:00:00'); // Noon to avoid timezone issues
}

export interface PhantomSiblingConfig {
  projectId: number;
  sourceId: number;
  type: 'phase' | 'subphase';
  zone: 'start' | 'end';
}

export function usePhantomSibling() {
  const projects = useAppStore((s) => s.projects);
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  const startPhantomSibling = useUIStore((s) => s.startPhantomSibling);
  const updatePhantomPosition = useUIStore((s) => s.updatePhantomPosition);
  const endPhantomSibling = useUIStore((s) => s.endPhantomSibling);

  // Ref to track if we're in phantom mode (for event handlers)
  const isPhantomModeRef = useRef(false);
  isPhantomModeRef.current = !!phantomSiblingMode;

  /**
   * Start phantom sibling mode
   */
  const startPhantom = useCallback(
    (config: PhantomSiblingConfig) => {
      const { projectId, sourceId, type, zone } = config;
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;

      let sourceItem: Phase | Subphase | undefined;
      let phantomColor: string;
      let sourceIndex: number;
      let parentId: number | null = null;
      let parentType: 'phase' | 'subphase' | undefined;

      // Determine dependency type based on click zone
      const dependencyType = zone === 'start' ? 'SS' : 'FS';

      if (type === 'phase') {
        sourceItem = (project.phases || []).find((p) => p.id === sourceId);
        if (!sourceItem) return;

        sourceIndex = (project.phases || []).findIndex((p) => p.id === sourceId);
        phantomColor = PHASE_COLOR;
        
        // Collapse this phase's children if expanded
        const { expandedPhases } = useAppStore.getState();
        if (expandedPhases.has(sourceId)) {
          useAppStore.getState().togglePhaseExpanded(sourceId);
        }
      } else {
        sourceItem = findSubphaseById(project.phases || [], sourceId) || undefined;
        if (!sourceItem) return;

        const subphase = sourceItem as Subphase;
        sourceIndex = getSubphaseIndexInParent(project, sourceId);
        // Use the source subphase's actual color (sibling will have same color)
        phantomColor = subphase.color || getDepthColor(getSubphaseDepth(project, sourceId));
        // Determine parent info from subphase
        if (subphase.parent_subphase_id) {
          parentId = subphase.parent_subphase_id;
          parentType = 'subphase';
        } else {
          parentId = subphase.parent_phase_id;
          parentType = 'phase';
        }
        
        // Collapse this subphase's children if expanded
        const { expandedSubphases } = useAppStore.getState();
        if (expandedSubphases.has(sourceId)) {
          useAppStore.getState().toggleSubphaseExpanded(sourceId);
        }
      }

      // Calculate duration from source item
      const sourceStart = parseDate(sourceItem.start_date);
      const sourceEnd = parseDate(sourceItem.end_date);
      const siblingDurationDays = differenceInDays(sourceEnd, sourceStart) + 1;

      // Calculate initial phantom position based on dependency type
      let phantomStart: Date;
      if (dependencyType === 'FS') {
        // Finish-to-Start: phantom starts day after source ends
        phantomStart = addDays(sourceEnd, 1);
      } else {
        // Start-to-Start: phantom starts same day as source
        phantomStart = new Date(sourceStart);
      }
      const phantomEnd = addDays(phantomStart, siblingDurationDays - 1);

      // Start phantom mode
      startPhantomSibling({
        projectId,
        sourceId,
        type,
        dependencyType,
        phantomStart: formatDate(phantomStart),
        phantomEnd: formatDate(phantomEnd),
        phantomColor,
        siblingDurationDays,
        sourceIndex,
        parentId,
        parentType,
      });

      // Add body class for styling
      document.body.classList.add('phantom-sibling-mode');
    },
    [projects, startPhantomSibling]
  );

  /**
   * Update phantom position based on mouse X position
   */
  const updatePhantom = useCallback(
    (mouseX: number, timelineRect: DOMRect, scrollLeft: number, cells: TimelineCell[], cellWidth: number) => {
      if (!phantomSiblingMode) return;

      const { siblingDurationDays } = phantomSiblingMode;

      // Calculate position relative to timeline content
      const relativeX = mouseX - timelineRect.left + scrollLeft;

      if (cells.length === 0) return;

      // Get timeline date range
      const firstCellDate = new Date(cells[0].date);
      firstCellDate.setHours(0, 0, 0, 0);

      const lastCell = cells[cells.length - 1];
      const lastCellDate = new Date(lastCell.date);
      lastCellDate.setHours(23, 59, 59, 999);

      const totalWidth = cells.length * cellWidth;
      const totalMs = lastCellDate.getTime() - firstCellDate.getTime();
      const msPerPixel = totalMs / totalWidth;

      // Calculate duration in pixels
      const durationMs = (siblingDurationDays - 1) * 24 * 60 * 60 * 1000;
      const halfDurationPx = durationMs / msPerPixel / 2;

      // Calculate bar left position (centered on cursor)
      const barLeftPx = relativeX - halfDurationPx;
      const clampedBarLeft = Math.max(0, Math.min(barLeftPx, totalWidth - (durationMs / msPerPixel)));

      // Calculate start date from pixel position
      const startMs = firstCellDate.getTime() + clampedBarLeft * msPerPixel;
      const startDate = new Date(startMs);
      startDate.setHours(0, 0, 0, 0);

      const endDate = addDays(startDate, siblingDurationDays - 1);

      // Update state
      updatePhantomPosition(formatDate(startDate), formatDate(endDate));
    },
    [phantomSiblingMode, updatePhantomPosition]
  );

  /**
   * Cancel phantom sibling mode
   */
  const cancelPhantom = useCallback(() => {
    document.body.classList.remove('phantom-sibling-mode');
    endPhantomSibling();
  }, [endPhantomSibling]);

  /**
   * Complete phantom sibling - create the actual phase/subphase
   */
  const completePhantom = useCallback(() => {
    if (!phantomSiblingMode) return;

    const {
      projectId,
      sourceId,
      type,
      phantomStart,
      phantomEnd,
      dependencyType,
      parentId,
      parentType,
    } = phantomSiblingMode;

    // Store preset data for modal
    const phantomPreset = {
      startDate: phantomStart,
      endDate: phantomEnd,
      predecessorId: sourceId,
      dependencyType,
      parentId,
      parentType,
    };

    // End phantom mode
    cancelPhantom();

    // Open the appropriate modal with phantom preset context
    // IMPORTANT: Set everything in one call to avoid race conditions
    setTimeout(() => {
      if (type === 'phase') {
        // Open phase modal with phantomPreset included in modalContext
        useUIStore.setState({
          activeModal: 'phase',
          editingPhase: null,
          modalContext: {
            projectId,
            phantomPreset,
          },
        });
      } else {
        // Open subphase modal - need to determine which phase to attach to
        // For nested subphases, we need both the parent subphase ID AND the root phase ID
        const project = projects.find(p => p.id === projectId);
        
        let rootPhaseId: number | undefined;
        let parentSubphaseId: number | undefined;
        
        if (parentType === 'phase') {
          // Direct child of a phase
          rootPhaseId = parentId ?? undefined;
          parentSubphaseId = undefined;
        } else if (parentType === 'subphase' && parentId && project) {
          // Nested subphase - need to find the root phase
          parentSubphaseId = parentId;
          
          // Find which phase contains this subphase chain
          for (const phase of project.phases || []) {
            const found = findSubphaseInChildren(phase.children || [], parentId);
            if (found) {
              rootPhaseId = phase.id;
              break;
            }
          }
        }
        
        useUIStore.setState({
          activeModal: 'subphase',
          editingSubphase: null,
          modalContext: {
            phaseId: rootPhaseId,
            projectId,
            subphaseId: parentSubphaseId,
            phantomPreset,
          },
        });
      }
    }, 50);
  }, [phantomSiblingMode, cancelPhantom, projects]);

  // Handle Escape key to cancel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isPhantomModeRef.current) {
        cancelPhantom();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [cancelPhantom]);

  /**
   * Calculate lag days between source and phantom
   */
  const calculateLag = useCallback(() => {
    if (!phantomSiblingMode) return { lagDays: 0, dependencyType: 'FS' as const };

    const { phantomStart, dependencyType, sourceId, type } = phantomSiblingMode;
    const project = projects.find((p) => p.id === phantomSiblingMode.projectId);
    if (!project) return { lagDays: 0, dependencyType };

    let sourceItem: Phase | Subphase | undefined;
    if (type === 'phase') {
      sourceItem = (project.phases || []).find((p) => p.id === sourceId);
    } else {
      sourceItem = findSubphaseById(project.phases || [], sourceId) || undefined;
    }

    if (!sourceItem) return { lagDays: 0, dependencyType };

    const newStart = parseDate(phantomStart);
    const sourceStart = parseDate(sourceItem.start_date);
    const sourceEnd = parseDate(sourceItem.end_date);

    let lagDays: number;
    if (dependencyType === 'SS') {
      // Start-to-Start: compare start dates
      lagDays = differenceInDays(newStart, sourceStart);
    } else {
      // Finish-to-Start: successor start vs predecessor end + 1 day
      const expectedStart = addDays(sourceEnd, 1);
      lagDays = differenceInDays(newStart, expectedStart);
    }

    return { lagDays, dependencyType };
  }, [phantomSiblingMode, projects]);

  return {
    phantomSiblingMode,
    isPhantomMode: !!phantomSiblingMode,
    startPhantom,
    updatePhantom,
    completePhantom,
    cancelPhantom,
    calculateLag,
  };
}

export default usePhantomSibling;
