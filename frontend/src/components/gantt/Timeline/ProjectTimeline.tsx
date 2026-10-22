/**
 * ProjectTimeline
 * Timeline row for a project with its phases and assignments
 */

import { memo, useMemo, useCallback, Fragment } from 'react';
import { ProjectBar } from './ProjectBar';
import { PhaseBar } from './PhaseBar';
import { calculateBarPosition } from '../utils';
import type { TimelineCell } from '../utils';
import type { Project, Phase, Subphase, ViewMode, StaffAssignment, EquipmentAssignment, AssignmentApproval } from '@/types';
import { isPendingAssignment, requestedAllocation } from '@/utils/kanbanCards';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { useDragAndDrop } from '@/hooks/useDragAndDrop';
import { useResize } from '@/hooks/useResize';
import { useDependencyLinking } from '@/hooks/useDependencyLinking';
import { usePhantomSibling } from '@/hooks/usePhantomSibling';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import { canBookEquipment, canEditProject, canEditAssignment } from '@/utils/permissions';
import {
  parseRecurringPattern,
  getAbsenceOn,
  absenceTypeName,
  absenceColor,
  cleanVacationDescription,
} from '@/utils/recurringVacation';
import { EMPTY_TEAM_SET, getClosureOn } from '@/utils/siteClosure';
import { indexTags, projectBarColor } from '@/utils/tags';
import { useGanttColorBy } from '@/hooks/useGanttColorBy';
import {
  selectStaffSiteIds,
  selectStaffTeamIds,
  selectTeamSiteById,
  selectAbsenceTypesById,
} from '@/stores/appStore';
import { DEFAULT_EVENT_COLOR } from '@/utils/colorSwatches';
import styles from './ProjectTimeline.module.css';
import { daysBetweenDateStrings } from '@/utils/date';
import { armTouchGesture, isTouchEvent } from '@/utils/touchEvents';

interface ProjectTimelineProps {
  project: Project;
  cells: TimelineCell[];
  cellWidth: number;
  isExpanded: boolean;
  expandedPhases: Set<number>;
  expandedSubphases: Set<number>;
}

/**
 * Calculate completion for a subphase, considering its children if it has any.
 * If the subphase has its own completion set and no children have completion, use that.
 * Otherwise, calculate from children's completion (weighted by duration).
 * If at least one child has completion, unset siblings count as 0%.
 */
function calculateSubphaseCompletion(subphase: Subphase): number | null {
  const children = subphase.children ?? [];
  
  // Check if any children have completion (direct or calculated)
  let hasChildrenWithCompletion = false;
  for (const child of children) {
    const childCompletion = calculateSubphaseCompletion(child);
    if (childCompletion !== null) {
      hasChildrenWithCompletion = true;
      break;
    }
  }
  
  if (hasChildrenWithCompletion) {
    // Calculate weighted average from children's effective completion
    // Children without completion count as 0%
    let totalWeight = 0;
    let weightedSum = 0;
    
    for (const child of children) {
      const childCompletion = calculateSubphaseCompletion(child);
      const days = Math.max(1, daysBetweenDateStrings(child.start_date, child.end_date));
      
      // Unset completion counts as 0% when at least one sibling has a value
      const completion = childCompletion ?? 0;
      weightedSum += completion * days;
      totalWeight += days;
    }
    
    if (totalWeight > 0) {
      return Math.round(weightedSum / totalWeight);
    }
  }
  
  // No children with completion, return item's own completion
  return subphase.completion ?? null;
}

/**
 * Calculate completion for a phase, considering its children (subphases) if it has any.
 * If the phase has its own completion set and no children have completion, use that.
 * Otherwise, calculate from children's completion (weighted by duration).
 * If at least one child has completion, unset siblings count as 0%.
 */
function calculatePhaseCompletion(phase: Phase): number | null {
  const children = phase.children ?? [];
  
  // Check if any children have completion (direct or calculated)
  let hasChildrenWithCompletion = false;
  for (const child of children) {
    const childCompletion = calculateSubphaseCompletion(child);
    if (childCompletion !== null) {
      hasChildrenWithCompletion = true;
      break;
    }
  }
  
  if (hasChildrenWithCompletion) {
    // Calculate weighted average from children's effective completion
    // Children without completion count as 0%
    let totalWeight = 0;
    let weightedSum = 0;
    
    for (const child of children) {
      const childCompletion = calculateSubphaseCompletion(child);
      const days = Math.max(1, daysBetweenDateStrings(child.start_date, child.end_date));
      
      // Unset completion counts as 0% when at least one sibling has a value
      const completion = childCompletion ?? 0;
      weightedSum += completion * days;
      totalWeight += days;
    }
    
    if (totalWeight > 0) {
      return Math.round(weightedSum / totalWeight);
    }
  }
  
  // No children with completion, return item's own completion
  return phase.completion ?? null;
}

// Calculate project completion from phases
function calculateProjectCompletion(project: Project): number | null {
  const phases = project.phases ?? [];
  if (phases.length === 0) return null;

  let weightedSum = 0;
  let totalWeight = 0;

  phases.forEach((phase) => {
    // Use calculated completion which considers children
    const completion = calculatePhaseCompletion(phase);
    if (completion != null) {
      const days = Math.max(1, daysBetweenDateStrings(phase.start_date, phase.end_date));
      weightedSum += completion * days;
      totalWeight += days;
    }
  });

  if (totalWeight > 0) {
    return Math.round(weightedSum / totalWeight);
  }
  return null;
}

export const ProjectTimeline = memo(function ProjectTimeline({
  project,
  cells,
  cellWidth,
  isExpanded,
  expandedPhases,
  expandedSubphases,
}: ProjectTimelineProps) {
  // Get UI store actions for opening modals
  // Individual selectors: a whole-store subscription re-rendered every
  // project row on each drag-indicator/tooltip/context-menu update.
  const openPhaseModal = useUIStore((s) => s.openPhaseModal);
  const openSubphaseModal = useUIStore((s) => s.openSubphaseModal);
  const setEditingPhase = useUIStore((s) => s.setEditingPhase);
  const setEditingSubphase = useUIStore((s) => s.setEditingSubphase);
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  
  // Get viewMode and filter state from stores
  const viewMode = useViewStore((s) => s.viewMode);
  const showAssignments = useViewStore((s) => s.showAssignments);
  const customColumnFilters = useCustomColumnStore((s) => s.customColumnFilters);
  const customColumnValues = useCustomColumnStore((s) => s.customColumnValues);

  // Get critical path state
  const criticalPathEnabled = useAppStore((s) => s.criticalPathEnabled);
  const criticalPathItems = useAppStore((s) => s.criticalPathItems);

  // Permission gate (canEditProject): `projects.edit_any`, or managing this
  // project (`projects.manage_as_pm` + its pm_id, the PM bundle), may move
  // and resize schedule items.
  const currentUser = useAppStore((s) => s.currentUser);
  const canEdit = canEditProject(currentUser, project);
  // Equipment bookings: equipment_bookings.manage (or managing the project)
  const canBook = canBookEquipment(currentUser, project);

  // Bar colour from the project's tag in the user's "Colour by" group,
  // resolved through the store (inline project.tags can be stale in What-If).
  // indexTags is cached per tags array, so rows share one map.
  const tags = useAppStore((s) => s.tags);
  const { group: colorByGroup } = useGanttColorBy();
  const barColor = useMemo(
    () => projectBarColor(project, indexTags(tags), colorByGroup),
    [project, tags, colorByGroup]
  );

  // Get critical path items for this project (empty set if not enabled)
  const projectCriticalItems = criticalPathEnabled.has(project.id) 
    ? (criticalPathItems.get(project.id) || new Set<string>())
    : new Set<string>();
  
  // Get drag and resize hooks
  const { startProjectDrag, startPhaseDrag, startSubphaseDrag, startStaffAssignmentDrag, startEquipmentAssignmentDrag } = useDragAndDrop();
  const { startPhaseResize, startSubphaseResize, startStaffAssignmentResize, startEquipmentAssignmentResize } = useResize();
  
  // Get dependency linking hook
  const { isLinkingDependency, linkingFrom, handleLinkZoneClick } = useDependencyLinking();
  
  // Get phantom sibling hook
  const { startPhantom, isPhantomMode } = usePhantomSibling();
  
  // Helper to check if entity passes filters
  const entityPassesFilters = useCallback((entityType: string, entityId: number): boolean => {
    const activeFilterColumns = Object.keys(customColumnFilters).filter(
      colId => customColumnFilters[Number(colId)]?.length > 0
    );
    
    if (activeFilterColumns.length === 0) return true;
    
    for (const colIdStr of activeFilterColumns) {
      const colId = Number(colIdStr);
      const filterValues = customColumnFilters[colId];
      const valueKey = `${colId}-${entityType}-${entityId}`;
      const cellValue = customColumnValues[valueKey] ?? null;
      
      if (cellValue === null) {
        if (!filterValues.includes('__empty__')) return false;
      } else {
        if (!filterValues.includes(cellValue)) return false;
      }
    }
    return true;
  }, [customColumnFilters, customColumnValues]);
  
  // Check if any descendant subphase matches filters
  const anyDescendantMatches = useCallback((subphases: Subphase[]): boolean => {
    for (const sp of subphases) {
      if (entityPassesFilters('subphase', sp.id)) return true;
      if (sp.children && sp.children.length > 0) {
        if (anyDescendantMatches(sp.children)) return true;
      }
    }
    return false;
  }, [entityPassesFilters]);
  
  // Filter phases: show if phase matches OR any descendant matches
  const visiblePhases = useMemo(() => 
    (project.phases ?? []).filter(phase => 
      entityPassesFilters('phase', phase.id) || 
      anyDescendantMatches(phase.children ?? [])
    ),
    [project.phases, entityPassesFilters, anyDescendantMatches]
  );

  // Calculate project bar position (spanning all phases)
  const projectBar = useMemo(() => {
    if (!project.start_date || !project.end_date) {
      // Calculate from phases
      let minDate: string | null = null;
      let maxDate: string | null = null;

      (project.phases ?? []).forEach((phase) => {
        if (!minDate || phase.start_date < minDate) minDate = phase.start_date;
        if (!maxDate || phase.end_date > maxDate) maxDate = phase.end_date;
      });

      if (minDate && maxDate) {
        return calculateBarPosition(minDate, maxDate, cells, cellWidth, viewMode);
      }
      return null;
    }
    return calculateBarPosition(project.start_date, project.end_date, cells, cellWidth, viewMode);
  }, [project, cells, cellWidth, viewMode]);

  // Calculate project completion
  const completion = useMemo(() => calculateProjectCompletion(project), [project]);

  // Project drag handler
  const handleProjectDragStart = useCallback((e: React.MouseEvent) => {
    if (!project.start_date || !project.end_date) {
      console.warn('Project has no dates, cannot drag');
      return;
    }
    startProjectDrag(e, project.id, project.start_date, project.end_date);
  }, [startProjectDrag, project.id, project.start_date, project.end_date]);

  // Phase interaction handlers
  const handlePhaseDragStart = useCallback((e: React.MouseEvent, phase: Phase, element: HTMLElement) => {
    startPhaseDrag(e, phase.id, project.id, phase.start_date, phase.end_date, phase.is_milestone, element);
  }, [startPhaseDrag, project.id]);

  const handlePhaseResizeStart = useCallback((e: React.MouseEvent, phase: Phase, edge: 'left' | 'right', element: HTMLElement) => {
    startPhaseResize(e, phase.id, project.id, edge, phase.start_date, phase.end_date, element);
  }, [startPhaseResize, project.id]);

  // A click on a bar opens the edit modal -- for project editors only. Anyone
  // else would only get a 403 on save; the bar's tooltip still works for them.
  const handlePhaseClick = useCallback((phase: Phase) => {
    if (!canEdit) return;
    setEditingPhase(phase);
    openPhaseModal(phase, project.id);
  }, [canEdit, setEditingPhase, openPhaseModal, project.id]);

  // Subphase interaction handlers
  const handleSubphaseDragStart = useCallback((e: React.MouseEvent, subphase: Subphase, phaseId: number, element: HTMLElement) => {
    startSubphaseDrag(e, subphase.id, project.id, phaseId, subphase.start_date, subphase.end_date, subphase.is_milestone, element);
  }, [startSubphaseDrag, project.id]);

  const handleSubphaseResizeStart = useCallback((e: React.MouseEvent, subphase: Subphase, edge: 'left' | 'right', element: HTMLElement) => {
    startSubphaseResize(e, subphase.id, project.id, edge, subphase.start_date, subphase.end_date, element);
  }, [startSubphaseResize, project.id]);

  const handleSubphaseClick = useCallback((subphase: Subphase, phaseId: number) => {
    if (!canEdit) return;
    setEditingSubphase(subphase);
    openSubphaseModal(subphase, phaseId, project.id);
  }, [canEdit, setEditingSubphase, openSubphaseModal, project.id]);

  // Staff assignment handlers (project-level)
  const handleStaffAssignmentDragStart = useCallback((e: React.MouseEvent, assignmentId: number, startDate: string, endDate: string, staffId?: number) => {
    startStaffAssignmentDrag(e, assignmentId, project.id, startDate, endDate, undefined, staffId);
  }, [startStaffAssignmentDrag, project.id]);

  const handleStaffAssignmentResizeStart = useCallback((e: React.MouseEvent, assignmentId: number, edge: 'left' | 'right', startDate: string, endDate: string, staffId?: number) => {
    startStaffAssignmentResize(e, assignmentId, project.id, edge, startDate, endDate, undefined, staffId);
  }, [startStaffAssignmentResize, project.id]);

  // Equipment assignment handlers (project-level)
  const handleEquipmentAssignmentDragStart = useCallback((e: React.MouseEvent, assignmentId: number, startDate: string, endDate: string) => {
    startEquipmentAssignmentDrag(e, assignmentId, project.id, startDate, endDate);
  }, [startEquipmentAssignmentDrag, project.id]);

  const handleEquipmentAssignmentResizeStart = useCallback((e: React.MouseEvent, assignmentId: number, edge: 'left' | 'right', startDate: string, endDate: string) => {
    startEquipmentAssignmentResize(e, assignmentId, project.id, edge, startDate, endDate);
  }, [startEquipmentAssignmentResize, project.id]);

  // Dependency linking handler
  const handleLinkZone = useCallback((e: React.MouseEvent, itemId: number, itemType: 'phase' | 'subphase', zone: 'start' | 'end') => {
    handleLinkZoneClick(e, project.id, itemId, itemType, zone);
  }, [handleLinkZoneClick, project.id]);
  
  // Phantom sibling handler
  const handlePhantomStart = useCallback((itemId: number, itemType: 'phase' | 'subphase', zone: 'start' | 'end') => {
    // Don't start if already in phantom mode or linking mode
    if (isPhantomMode || isLinkingDependency) return;
    
    startPhantom({
      projectId: project.id,
      sourceId: itemId,
      type: itemType,
      zone,
    });
  }, [startPhantom, project.id, isPhantomMode, isLinkingDependency]);

  // Get linking state for this project
  const linkingFromId = linkingFrom?.projectId === project.id ? linkingFrom.itemId : null;
  const linkingFromType = linkingFrom?.projectId === project.id ? linkingFrom.itemType : null;

  return (
    <>
      {/* Project row */}
      <div
        className={`${styles.row} ${styles.projectRow}`}
        data-project-id={project.id}
      >
        {/* Project bar with confirmed/unconfirmed styling */}
        {projectBar && (
          <ProjectBar
            left={projectBar.left}
            width={projectBar.width}
            name={project.name}
            confirmed={project.confirmed}
            completion={completion}
            projectId={project.id}
            startDate={project.start_date || ''}
            endDate={project.end_date || ''}
            onDragStart={canEdit ? handleProjectDragStart : undefined}
            color={barColor}
          />
        )}
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <>
          {/* Phases with phantom row support - filtered */}
          {visiblePhases.map((phase) => {
            // Check if this phase is the source for phantom mode
            const isPhantomSource = phantomSiblingMode?.type === 'phase' && 
              phantomSiblingMode.projectId === project.id &&
              phantomSiblingMode.sourceId === phase.id;
            
            return (
              <Fragment key={phase.id}>
                <PhaseTimeline
                  phase={phase}
                  projectId={project.id}
                  cells={cells}
                  cellWidth={cellWidth}
                  viewMode={viewMode}
                  isExpanded={expandedPhases.has(phase.id)}
                  expandedSubphases={expandedSubphases}
                  depth={1}
                  onPhaseDragStart={handlePhaseDragStart}
                  onPhaseResizeStart={handlePhaseResizeStart}
                  onPhaseClick={handlePhaseClick}
                  onSubphaseDragStart={handleSubphaseDragStart}
                  onSubphaseResizeStart={handleSubphaseResizeStart}
                  onSubphaseClick={handleSubphaseClick}
                  onLinkZoneClick={handleLinkZone}
                  isLinkingDependency={isLinkingDependency}
                  linkingFromId={linkingFromId}
                  linkingFromType={linkingFromType}
                  onPhantomStart={handlePhantomStart}
                  entityPassesFilters={entityPassesFilters}
                  anyDescendantMatches={anyDescendantMatches}
                  showAssignments={showAssignments}
                  criticalPathItems={projectCriticalItems}
                />
                {isPhantomSource && (
                  <div className={styles.phantomRow} />
                )}
              </Fragment>
            );
          })}

          {/* Project-level staff assignments (interactive) - filtered by showAssignments */}
          {showAssignments && (project.staffAssignments ?? []).map((assignment) => {
            // Everyone may move the booking of their own time.
            const canEditThis = canEditAssignment(currentUser, project, assignment.staff_id);
            return (
            <div key={`staff-${assignment.id}`} className={styles.row}>
              <AssignmentBar
                assignmentId={assignment.id}
                assignmentType="staff"
                projectId={project.id}
                startDate={assignment.start_date}
                endDate={assignment.end_date}
                cells={cells}
                cellWidth={cellWidth}
                viewMode={viewMode}
                type="staff"
                name={assignment.staff_name}
                allocation={assignment.allocation}
                staffId={assignment.staff_id}
                approvalStatus={assignment.approval_status}
                approval={assignment.approval}
                interactive={canEditThis}
                onDragStart={canEditThis ? (e) => handleStaffAssignmentDragStart(e, assignment.id, assignment.start_date, assignment.end_date, assignment.staff_id) : undefined}
                onResizeStart={canEditThis ? (e, edge) => handleStaffAssignmentResizeStart(e, assignment.id, edge, assignment.start_date, assignment.end_date, assignment.staff_id) : undefined}
              />
            </div>
            );
          })}

          {/* Project-level equipment assignments (interactive) - filtered by showAssignments */}
          {showAssignments && (project.equipmentAssignments ?? []).map((assignment) => (
            <div key={`equip-${assignment.id}`} className={styles.row}>
              <AssignmentBar
                assignmentId={assignment.id}
                assignmentType="equipment"
                projectId={project.id}
                startDate={assignment.start_date}
                endDate={assignment.end_date}
                cells={cells}
                cellWidth={cellWidth}
                viewMode={viewMode}
                type="equipment"
                name={assignment.equipment_name}
                equipmentId={assignment.equipment_id}
                interactive={canBook}
                onDragStart={canBook ? (e) => handleEquipmentAssignmentDragStart(e, assignment.id, assignment.start_date, assignment.end_date) : undefined}
                onResizeStart={canBook ? (e, edge) => handleEquipmentAssignmentResizeStart(e, assignment.id, edge, assignment.start_date, assignment.end_date) : undefined}
              />
            </div>
          ))}
        </>
      )}
    </>
  );
});

// Phase timeline sub-component
interface PhaseTimelineProps {
  phase: Phase;
  projectId: number;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
  isExpanded: boolean;
  expandedSubphases: Set<number>;
  depth: number;
  onPhaseDragStart: (e: React.MouseEvent, phase: Phase, element: HTMLElement) => void;
  onPhaseResizeStart: (e: React.MouseEvent, phase: Phase, edge: 'left' | 'right', element: HTMLElement) => void;
  onPhaseClick: (phase: Phase) => void;
  onSubphaseDragStart: (e: React.MouseEvent, subphase: Subphase, phaseId: number, element: HTMLElement) => void;
  onSubphaseResizeStart: (e: React.MouseEvent, subphase: Subphase, edge: 'left' | 'right', element: HTMLElement) => void;
  onSubphaseClick: (subphase: Subphase, phaseId: number) => void;
  // Dependency linking
  onLinkZoneClick: (e: React.MouseEvent, itemId: number, itemType: 'phase' | 'subphase', zone: 'start' | 'end') => void;
  isLinkingDependency: boolean;
  linkingFromId: number | null;
  linkingFromType: 'phase' | 'subphase' | null;
  // Phantom sibling
  onPhantomStart: (itemId: number, itemType: 'phase' | 'subphase', zone: 'start' | 'end') => void;
  // Filtering
  entityPassesFilters: (entityType: string, entityId: number) => boolean;
  anyDescendantMatches: (subphases: Subphase[]) => boolean;
  showAssignments: boolean;
  // Critical path
  criticalPathItems: Set<string>;
}

const PhaseTimeline = memo(function PhaseTimeline({
  phase,
  projectId,
  cells,
  cellWidth,
  viewMode,
  isExpanded,
  expandedSubphases,
  depth,
  onPhaseDragStart,
  onPhaseResizeStart,
  onPhaseClick,
  onSubphaseDragStart,
  onSubphaseResizeStart,
  onSubphaseClick,
  onLinkZoneClick,
  isLinkingDependency,
  linkingFromId,
  linkingFromType,
  onPhantomStart,
  entityPassesFilters,
  anyDescendantMatches,
  showAssignments,
  criticalPathItems,
}: PhaseTimelineProps) {
  // Permission gate (canEditProject): `projects.edit_any`, or managing this
  // project (`projects.manage_as_pm` + its pm_id, the PM bundle), may
  // move/resize, link dependencies and spawn phantom siblings.
  const currentUser = useAppStore((s) => s.currentUser);
  const pmId = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.pm_id);
  const canEdit = canEditProject(currentUser, { pm_id: pmId });

  // Access phantom mode for subphase phantom rows
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  
  // Access WebSocket context for real-time change indicators
  const { recentChanges } = useWebSocketContext();
  
  // Get changedBy for this phase (if recently changed by another user)
  const phaseChange = useMemo(() => 
    recentChanges.find(c => c.entity_type === 'phase' && c.entity_id === phase.id),
    [recentChanges, phase.id]
  );
  const changedBy = phaseChange?.user_name ?? null;
  
  // Filter subphases: show if subphase matches OR any descendant matches
  const visibleSubphases = useMemo(() => 
    (phase.children ?? []).filter(sp => 
      entityPassesFilters('subphase', sp.id) || 
      anyDescendantMatches(sp.children ?? [])
    ),
    [phase.children, entityPassesFilters, anyDescendantMatches]
  );
  
  const barPosition = useMemo(
    () => calculateBarPosition(phase.start_date, phase.end_date, cells, cellWidth, viewMode),
    [phase.start_date, phase.end_date, cells, cellWidth, viewMode]
  );

  // Calculate completion including children's completion
  const phaseCompletion = useMemo(
    () => calculatePhaseCompletion(phase),
    [phase]
  );

  const handleDragStart = useCallback((e: React.MouseEvent, element: HTMLElement) => {
    onPhaseDragStart(e, phase, element);
  }, [onPhaseDragStart, phase]);

  const handleResizeStart = useCallback((e: React.MouseEvent, edge: 'left' | 'right', element: HTMLElement) => {
    onPhaseResizeStart(e, phase, edge, element);
  }, [onPhaseResizeStart, phase]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    // Only open modal on double-click or if not dragging
    e.stopPropagation();
    onPhaseClick(phase);
  }, [onPhaseClick, phase]);

  const handleLinkClick = useCallback((e: React.MouseEvent, zone: 'start' | 'end') => {
    onLinkZoneClick(e, phase.id, 'phase', zone);
  }, [onLinkZoneClick, phase.id]);
  
  const handlePhantom = useCallback((zone: 'start' | 'end') => {
    onPhantomStart(phase.id, 'phase', zone);
  }, [onPhantomStart, phase.id]);

  const isLinkingSource = isLinkingDependency && linkingFromType === 'phase' && linkingFromId === phase.id;

  return (
    <>
      {/* Phase row */}
      <div className={styles.row} data-phase-id={phase.id}>
        {barPosition && (
          <PhaseBar
            left={barPosition.left}
            width={barPosition.width}
            color={phase.color}
            name={phase.name}
            isMilestone={Boolean(phase.is_milestone)}
            completion={phaseCompletion}
            isCriticalPath={criticalPathItems.has(`phase-${phase.id}`)}
            changedBy={changedBy}
            phaseId={phase.id}
            projectId={projectId}
            startDate={phase.start_date}
            endDate={phase.end_date}
            onDragStart={canEdit ? handleDragStart : undefined}
            onResizeStart={!canEdit || phase.is_milestone ? undefined : handleResizeStart}
            onClick={handleClick}
            onLinkZoneClick={canEdit ? handleLinkClick : undefined}
            isLinkingSource={isLinkingSource}
            isLinkingActive={isLinkingDependency}
            onPhantomStart={canEdit ? handlePhantom : undefined}
          />
        )}
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <>
          {/* Subphases with phantom row support - filtered */}
          {visibleSubphases.map((subphase: Subphase) => {
            // Check if this subphase is the source for phantom mode (direct child of this phase)
            const isPhantomSource = phantomSiblingMode?.type === 'subphase' && 
              phantomSiblingMode.projectId === projectId &&
              phantomSiblingMode.parentType === 'phase' &&
              phantomSiblingMode.parentId === phase.id &&
              phantomSiblingMode.sourceId === subphase.id;
            
            return (
              <Fragment key={subphase.id}>
                <SubphaseTimeline
                  subphase={subphase}
                  phaseId={phase.id}
                  projectId={projectId}
                  cells={cells}
                  cellWidth={cellWidth}
                  viewMode={viewMode}
                  isExpanded={expandedSubphases.has(subphase.id)}
                  expandedSubphases={expandedSubphases}
                  depth={depth + 1}
                  onSubphaseDragStart={onSubphaseDragStart}
                  onSubphaseResizeStart={onSubphaseResizeStart}
                  onSubphaseClick={onSubphaseClick}
                  onLinkZoneClick={onLinkZoneClick}
                  isLinkingDependency={isLinkingDependency}
                  linkingFromId={linkingFromId}
                  linkingFromType={linkingFromType}
                  onPhantomStart={onPhantomStart}
                  entityPassesFilters={entityPassesFilters}
                  anyDescendantMatches={anyDescendantMatches}
                  showAssignments={showAssignments}
                  criticalPathItems={criticalPathItems}
                />
                {isPhantomSource && (
                  <div className={styles.phantomRow} />
                )}
              </Fragment>
            );
          })}

          {/* Phase-level assignments - use phase dates since phase assignments don't have their own - filtered */}
          {showAssignments && (phase.staffAssignments ?? []).map((assignment: StaffAssignment) => (
            <div key={`staff-${assignment.id}`} className={styles.row}>
              <AssignmentBar
                assignmentId={assignment.id}
                assignmentType="staff"
                projectId={projectId}
                phaseId={phase.id}
                startDate={phase.start_date}
                endDate={phase.end_date}
                cells={cells}
                cellWidth={cellWidth}
                viewMode={viewMode}
                type="phase-staff"
                name={assignment.staff_name}
                allocation={assignment.allocation}
                phaseColor={phase.color}
                staffId={assignment.staff_id}
                approvalStatus={assignment.approval_status}
                approval={assignment.approval}
              />
            </div>
          ))}

          {showAssignments && (phase.equipmentAssignments ?? []).map((assignment: EquipmentAssignment) => (
            <div key={`equip-${assignment.id}`} className={styles.row}>
              <AssignmentBar
                assignmentId={assignment.id}
                assignmentType="equipment"
                projectId={projectId}
                phaseId={phase.id}
                startDate={phase.start_date}
                endDate={phase.end_date}
                cells={cells}
                cellWidth={cellWidth}
                viewMode={viewMode}
                type="equipment"
                name={assignment.equipment_name}
                equipmentId={assignment.equipment_id}
              />
            </div>
          ))}
        </>
      )}
    </>
  );
});

// Subphase timeline sub-component
interface SubphaseTimelineProps {
  subphase: Subphase;
  phaseId: number;
  projectId: number;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
  isExpanded: boolean;
  expandedSubphases: Set<number>;
  depth: number;
  onSubphaseDragStart: (e: React.MouseEvent, subphase: Subphase, phaseId: number, element: HTMLElement) => void;
  onSubphaseResizeStart: (e: React.MouseEvent, subphase: Subphase, edge: 'left' | 'right', element: HTMLElement) => void;
  onSubphaseClick: (subphase: Subphase, phaseId: number) => void;
  // Dependency linking
  onLinkZoneClick: (e: React.MouseEvent, itemId: number, itemType: 'phase' | 'subphase', zone: 'start' | 'end') => void;
  isLinkingDependency: boolean;
  linkingFromId: number | null;
  linkingFromType: 'phase' | 'subphase' | null;
  // Phantom sibling
  onPhantomStart: (itemId: number, itemType: 'phase' | 'subphase', zone: 'start' | 'end') => void;
  // Filtering
  entityPassesFilters: (entityType: string, entityId: number) => boolean;
  anyDescendantMatches: (subphases: Subphase[]) => boolean;
  showAssignments: boolean;
  // Critical path
  criticalPathItems: Set<string>;
}

const SubphaseTimeline = memo(function SubphaseTimeline({
  subphase,
  phaseId,
  projectId,
  cells,
  cellWidth,
  viewMode,
  isExpanded,
  expandedSubphases,
  depth,
  onSubphaseDragStart,
  onSubphaseResizeStart,
  onSubphaseClick,
  onLinkZoneClick,
  isLinkingDependency,
  linkingFromId,
  linkingFromType,
  onPhantomStart,
  entityPassesFilters,
  anyDescendantMatches,
  showAssignments,
  criticalPathItems,
}: SubphaseTimelineProps) {
  // Permission gate (canEditProject): `projects.edit_any`, or managing this
  // project (`projects.manage_as_pm` + its pm_id, the PM bundle), may
  // move/resize, link dependencies and spawn phantom siblings.
  const currentUser = useAppStore((s) => s.currentUser);
  const pmId = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.pm_id);
  const canEdit = canEditProject(currentUser, { pm_id: pmId });

  // Access phantom mode for nested subphase phantom rows
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  
  // Access WebSocket context for real-time change indicators
  const { recentChanges } = useWebSocketContext();
  
  // Get changedBy for this subphase (if recently changed by another user)
  const subphaseChange = useMemo(() => 
    recentChanges.find(c => c.entity_type === 'subphase' && c.entity_id === subphase.id),
    [recentChanges, subphase.id]
  );
  const changedBy = subphaseChange?.user_name ?? null;
  
  // Filter nested subphases: show if matches OR any descendant matches
  const visibleChildren = useMemo(() => 
    (subphase.children ?? []).filter(sp => 
      entityPassesFilters('subphase', sp.id) || 
      anyDescendantMatches(sp.children ?? [])
    ),
    [subphase.children, entityPassesFilters, anyDescendantMatches]
  );
  
  const barPosition = useMemo(
    () => calculateBarPosition(subphase.start_date, subphase.end_date, cells, cellWidth, viewMode),
    [subphase.start_date, subphase.end_date, cells, cellWidth, viewMode]
  );

  // Calculate completion including children's completion
  const subphaseCompletion = useMemo(
    () => calculateSubphaseCompletion(subphase),
    [subphase]
  );

  const handleDragStart = useCallback((e: React.MouseEvent, element: HTMLElement) => {
    onSubphaseDragStart(e, subphase, phaseId, element);
  }, [onSubphaseDragStart, subphase, phaseId]);

  const handleResizeStart = useCallback((e: React.MouseEvent, edge: 'left' | 'right', element: HTMLElement) => {
    onSubphaseResizeStart(e, subphase, edge, element);
  }, [onSubphaseResizeStart, subphase]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSubphaseClick(subphase, phaseId);
  }, [onSubphaseClick, subphase, phaseId]);

  const handleLinkClick = useCallback((e: React.MouseEvent, zone: 'start' | 'end') => {
    onLinkZoneClick(e, subphase.id, 'subphase', zone);
  }, [onLinkZoneClick, subphase.id]);
  
  const handlePhantom = useCallback((zone: 'start' | 'end') => {
    onPhantomStart(subphase.id, 'subphase', zone);
  }, [onPhantomStart, subphase.id]);

  const isLinkingSource = isLinkingDependency && linkingFromType === 'subphase' && linkingFromId === subphase.id;

  return (
    <>
      {/* Subphase row */}
      <div className={styles.row} data-subphase-id={subphase.id}>
        {barPosition && (
          <PhaseBar
            left={barPosition.left}
            width={barPosition.width}
            color={subphase.color}
            name={subphase.name}
            isSubphase
            isMilestone={Boolean(subphase.is_milestone)}
            completion={subphaseCompletion}
            isCriticalPath={criticalPathItems.has(`subphase-${subphase.id}`)}
            changedBy={changedBy}
            phaseId={subphase.id}
            projectId={projectId}
            startDate={subphase.start_date}
            endDate={subphase.end_date}
            onDragStart={canEdit ? handleDragStart : undefined}
            onResizeStart={!canEdit || subphase.is_milestone ? undefined : handleResizeStart}
            onClick={handleClick}
            onLinkZoneClick={canEdit ? handleLinkClick : undefined}
            isLinkingSource={isLinkingSource}
            isLinkingActive={isLinkingDependency}
            onPhantomStart={canEdit ? handlePhantom : undefined}
          />
        )}
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <>
          {/* Nested subphases with phantom row support - filtered */}
          {visibleChildren.map((child: Subphase) => {
            // Check if this child subphase is the source for phantom mode
            const isPhantomSource = phantomSiblingMode?.type === 'subphase' && 
              phantomSiblingMode.projectId === projectId &&
              phantomSiblingMode.sourceId === child.id;
            
            return (
              <Fragment key={child.id}>
                <SubphaseTimeline
                  subphase={child}
                  phaseId={phaseId}
                  projectId={projectId}
                  cells={cells}
                  cellWidth={cellWidth}
                  viewMode={viewMode}
                  isExpanded={expandedSubphases.has(child.id)}
                  expandedSubphases={expandedSubphases}
                  depth={depth + 1}
                  onSubphaseDragStart={onSubphaseDragStart}
                  onSubphaseResizeStart={onSubphaseResizeStart}
                  onSubphaseClick={onSubphaseClick}
                  onLinkZoneClick={onLinkZoneClick}
                  isLinkingDependency={isLinkingDependency}
                  linkingFromId={linkingFromId}
                  linkingFromType={linkingFromType}
                  onPhantomStart={onPhantomStart}
                  entityPassesFilters={entityPassesFilters}
                  anyDescendantMatches={anyDescendantMatches}
                  showAssignments={showAssignments}
                  criticalPathItems={criticalPathItems}
                />
                {isPhantomSource && (
                  <div className={styles.phantomRow} />
                )}
              </Fragment>
            );
          })}

          {/* Subphase-level assignments - use subphase dates - filtered */}
          {showAssignments && (subphase.staffAssignments ?? []).map((assignment: StaffAssignment) => (
            <div key={`staff-${assignment.id}`} className={styles.row}>
              <AssignmentBar
                assignmentId={assignment.id}
                assignmentType="staff"
                projectId={projectId}
                phaseId={phaseId}
                subphaseId={subphase.id}
                startDate={subphase.start_date}
                endDate={subphase.end_date}
                cells={cells}
                cellWidth={cellWidth}
                viewMode={viewMode}
                type="subphase-staff"
                name={assignment.staff_name}
                allocation={assignment.allocation}
                phaseColor={subphase.color}
                staffId={assignment.staff_id}
                approvalStatus={assignment.approval_status}
                approval={assignment.approval}
              />
            </div>
          ))}

          {showAssignments && (subphase.equipmentAssignments ?? []).map((assignment: EquipmentAssignment) => (
            <div key={`equip-${assignment.id}`} className={styles.row}>
              <AssignmentBar
                assignmentId={assignment.id}
                assignmentType="equipment"
                projectId={projectId}
                phaseId={phaseId}
                subphaseId={subphase.id}
                startDate={subphase.start_date}
                endDate={subphase.end_date}
                cells={cells}
                cellWidth={cellWidth}
                viewMode={viewMode}
                type="equipment"
                name={assignment.equipment_name}
                equipmentId={assignment.equipment_id}
              />
            </div>
          ))}
        </>
      )}
    </>
  );
});

// Assignment bar sub-component
interface AssignmentBarProps {
  assignmentId: number;
  assignmentType: 'staff' | 'equipment';
  projectId: number;  // Add projectId for context
  phaseId?: number;   // Add phaseId for context  
  subphaseId?: number; // Add subphaseId for context
  startDate: string;
  endDate: string;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
  type: 'staff' | 'equipment' | 'phase-staff' | 'subphase-staff';
  name?: string;
  allocation?: number;
  phaseColor?: string;
  staffId?: number;  // For looking up vacations
  equipmentId?: number; // For equipment assignments
  // Interaction handlers (optional - only for project-level assignments)
  onDragStart?: (e: React.MouseEvent) => void;
  onResizeStart?: (e: React.MouseEvent, edge: 'left' | 'right') => void;
  interactive?: boolean;
  /** Staff bars: 'pending' = a booking awaiting approval */
  approvalStatus?: StaffAssignment['approval_status'];
  /** Staff bars: the open approval request (create, change or removal) */
  approval?: AssignmentApproval | null;
}

/** Tooltip suffix of a bar with an open request. */
const PENDING_SUFFIX: Record<string, string> = {
  'assignments.self_create': 'pending approval',
  'assignments.self_update': 'change pending approval',
  'assignments.self_remove': 'removal pending approval',
};

const AssignmentBar = memo(function AssignmentBar({
  assignmentId,
  assignmentType,
  projectId: _projectId,
  phaseId: _phaseId,
  subphaseId: _subphaseId,
  startDate,
  endDate,
  cells,
  cellWidth,
  viewMode,
  type,
  name,
  allocation,
  phaseColor,
  staffId,
  equipmentId: _equipmentId,
  onDragStart,
  onResizeStart,
  interactive: interactiveProp = false,
  approvalStatus,
  approval,
}: AssignmentBarProps) {
  // A bar with an open request (a pending booking, change or removal) is
  // frozen: its dates are a request, not a booking, until someone decides.
  const pending = isPendingAssignment({ approval_status: approvalStatus }) || Boolean(approval);
  const interactive = interactiveProp && !pending;
  // Get vacations from store to show vacation indicators
  const vacations = useAppStore((s) => s.vacations);
  const typesById = useAppStore(selectAbsenceTypesById);
  // Site closures (company events flagged as such) also mark the bar
  const closureIndex = useAppStore((s) => s.closureIndex);
  const staffSiteIds = useAppStore(selectStaffSiteIds);
  const staffTeamIds = useAppStore(selectStaffTeamIds);
  const teamSiteById = useAppStore(selectTeamSiteById);

  // Live attribution: show "✨ Vincent D." on this bar if another user just
  // changed THIS specific assignment. Staff and equipment assignments live
  // in different tables but share the integer id space, so matching on a
  // generic "assignment" entity type would cross-light bars (a staff drag
  // would highlight an equipment bar with the same numeric id, and vice
  // versa). The backend now emits staff_assignment / equipment_assignment
  // explicitly so we can match the right kind.
  const { recentChanges } = useWebSocketContext();
  const expectedEntityType =
    assignmentType === 'staff' ? 'staff_assignment' : 'equipment_assignment';
  const changedBy = useMemo(() => {
    const c = recentChanges.find(
      (r) => r.entity_type === expectedEntityType && r.entity_id === assignmentId,
    );
    return c?.user_name ?? null;
  }, [recentChanges, expectedEntityType, assignmentId]);
  
  const barPosition = useMemo(
    () => calculateBarPosition(startDate, endDate, cells, cellWidth, viewMode),
    [startDate, endDate, cells, cellWidth, viewMode]
  );

  // Unavailable-absence and site-closure markers for this staff member across
  // the visible timeline, coloured by absence type or by the closing event.
  // Available absences (Home Office) get no marker. Each cell is judged by its
  // first day; [R:...] recurring absences are only shown in day-cell views
  // (week/month), where one cell is one day -- in week/month cells a single
  // weekday would mark the whole cell.
  const vacationCellMarkers = useMemo(() => {
    if (!staffId || assignmentType !== 'staff') return [];

    const dayCells = viewMode === 'week' || viewMode === 'month';
    const staffVacations = vacations.filter(
      (v) => v.staff_id === staffId && (dayCells || !parseRecurringPattern(v.description))
    );
    const sites = staffSiteIds.get(staffId);
    const teams = staffTeamIds.get(staffId) ?? EMPTY_TEAM_SET;
    const hasClosures = closureIndex.size > 0 && !!sites;
    if (staffVacations.length === 0 && !hasClosures) return [];

    const markers: Array<{ left: number; width: number; title: string; color?: string }> = [];

    cells.forEach((cell, index) => {
      let title: string;
      let color: string | undefined;

      const absence = staffVacations.length > 0
        ? getAbsenceOn(staffId, cell.dateStr, staffVacations, typesById)
        : null;
      if (absence?.unavailable) {
        const typeName = absenceTypeName(absence.type);
        const description = cleanVacationDescription(absence.vacation.description);
        title = absence.type && description && description !== typeName
          ? `${typeName}: ${description}`
          : description || typeName;
        color = absenceColor(absence.type);
      } else {
        const closure = hasClosures && sites
          ? getClosureOn(sites, cell.dateStr, closureIndex, teams, teamSiteById)
          : null;
        if (!closure) return;
        title = `Site closed: ${closure.name}`;
        color = closure.color || DEFAULT_EVENT_COLOR;
      }

      const cellLeft = index * cellWidth;
      const lastMarker = markers[markers.length - 1];

      if (lastMarker && lastMarker.left + lastMarker.width === cellLeft && lastMarker.title === title && lastMarker.color === color) {
        // Extend the previous marker
        lastMarker.width += cellWidth;
      } else {
        markers.push({ left: cellLeft, width: cellWidth, title, color });
      }
    });

    return markers;
  }, [staffId, assignmentType, vacations, typesById, closureIndex, staffSiteIds, staffTeamIds, teamSiteById, cells, cellWidth, viewMode]);

  if (!barPosition) return null;

  // Determine class and style based on type
  const isPhaseStaff = type === 'phase-staff';
  const isSubphaseStaff = type === 'subphase-staff';
  const barType = (type === 'phase-staff' || type === 'subphase-staff') ? 'staff' : type;
  
  const barStyle: React.CSSProperties = {
    left: barPosition.left,
    width: barPosition.width,
  };
  
  // Phase staff uses phase color with dashed border and reduced opacity
  if (isPhaseStaff) {
    barStyle.opacity = 0.7;
    if (phaseColor) {
      barStyle.background = phaseColor;
    }
    barStyle.border = '1px dashed rgba(255,255,255,0.4)';
  }
  
  // Subphase staff is more transparent and smaller
  if (isSubphaseStaff) {
    barStyle.opacity = 0.7;
    barStyle.height = '14px';
    if (phaseColor) {
      barStyle.background = phaseColor;
    }
  }

  // Build label: "Name (allocation%)" for staff, just "Name" for equipment;
  // a pending change shows the requested value next to the current one.
  const requested =
    approval && allocation !== undefined ? requestedAllocation({ allocation, approval } as StaffAssignment) : null;
  const allocationText = allocation ? (requested !== null ? `${allocation}% → ${requested}%` : `${allocation}%`) : '';
  const label = name 
    ? (allocationText ? `${name} (${allocationText})` : name)
    : allocationText;
  const pendingSuffix = pending
    ? ` — ${PENDING_SUFFIX[approval?.action ?? 'assignments.self_create'] ?? PENDING_SUFFIX['assignments.self_create']}`
    : '';

  // Mouse and touch share these. A touch is armed with armTouchGesture and
  // handed on as a mouse-like event only once the finger has moved past the
  // threshold, so a jittery tap is not committed as a move/resize
  // (toMouseLikeEvent keeps target/currentTarget, so the resize hook still
  // finds the bar with closest('[data-assignment-id]') from the handle).
  const handlePointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    // Check if clicking on resize handle
    const target = e.target as HTMLElement;
    if (target.classList.contains('resize-handle')) return;
    if (!onDragStart) return;
    
    if (isTouchEvent(e)) {
      armTouchGesture(e as React.TouchEvent, { onStart: onDragStart });
    } else {
      onDragStart(e as React.MouseEvent);
    }
  };

  const handleResizePointerDown = (e: React.MouseEvent | React.TouchEvent, edge: 'left' | 'right') => {
    e.stopPropagation();
    if (!onResizeStart) return;
    if (isTouchEvent(e)) {
      armTouchGesture(e as React.TouchEvent, { onStart: (mouseLike) => onResizeStart(mouseLike, edge) });
    } else {
      onResizeStart(e as React.MouseEvent, edge);
    }
  };

  return (
    <>
      {/* Absence cell markers - type-coloured strips (purple when untyped) */}
      {vacationCellMarkers.map((marker, idx) => (
        <div
          key={`vac-${idx}`}
          className={styles.vacationCellMarker}
          style={{
            left: marker.left,
            width: marker.width,
            ...(marker.color ? ({ ['--absence-color' as string]: marker.color } as React.CSSProperties) : {}),
          }}
          title={marker.title}
        />
      ))}
      
      {/* Assignment bar */}
      <div
        className={`${styles.assignmentBar} ${styles[barType]} ${isPhaseStaff ? styles.phaseStaff : ''} ${isSubphaseStaff ? styles.subphaseStaff : ''} ${interactive ? styles.interactive : ''} ${pending ? styles.pendingBar : ''} ${changedBy ? styles.recentlyChanged : ''}`}
        style={barStyle}
        title={changedBy ? `${label}${pendingSuffix} — just edited by ${changedBy}` : `${label}${pendingSuffix}`}
        data-assignment-id={assignmentId}
        data-assignment-type={assignmentType}
        data-start={startDate}
        data-end={endDate}
        onMouseDown={interactive ? handlePointerDown : undefined}
        onTouchStart={interactive ? handlePointerDown : undefined}
      >
        {/* Left resize handle */}
        {interactive && (
          <div
            className={`${styles.resizeHandle} ${styles.left} resize-handle`}
            onMouseDown={(e) => handleResizePointerDown(e, 'left')}
            onTouchStart={(e) => handleResizePointerDown(e, 'left')}
          />
        )}

        <span className={styles.barLabel}>{label}</span>

        {/* Right resize handle */}
        {interactive && (
          <div
            className={`${styles.resizeHandle} ${styles.right} resize-handle`}
            onMouseDown={(e) => handleResizePointerDown(e, 'right')}
            onTouchStart={(e) => handleResizePointerDown(e, 'right')}
          />
        )}
      </div>

      {/* Render the "✨ <name>" attribution as a sibling of the bar (not a
          child) so the bar's overflow: hidden doesn't clip it. Positioned
          relative to the row using the same left offset as the bar. */}
      {changedBy && (
        <div
          className={styles.changedByBadge}
          style={{ left: barPosition.left }}
        >
          ✨ {changedBy}
        </div>
      )}
    </>
  );
});
