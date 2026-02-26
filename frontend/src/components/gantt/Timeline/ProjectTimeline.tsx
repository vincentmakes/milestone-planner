/**
 * ProjectTimeline
 * Timeline row for a project with its phases and assignments
 */

import { memo, useMemo, useCallback, Fragment } from 'react';
import { ProjectBar } from './ProjectBar';
import { PhaseBar } from './PhaseBar';
import { calculateBarPosition } from '../utils';
import type { TimelineCell } from '../utils';
import type { Project, Phase, Subphase, ViewMode, StaffAssignment, EquipmentAssignment } from '@/types';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { useDragAndDrop } from '@/hooks/useDragAndDrop';
import { useResize } from '@/hooks/useResize';
import { useDependencyLinking } from '@/hooks/useDependencyLinking';
import { usePhantomSibling } from '@/hooks/usePhantomSibling';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import { parseRecurringPattern } from '@/utils/recurringVacation';
import styles from './ProjectTimeline.module.css';

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
      const days = Math.max(1, Math.ceil((new Date(child.end_date).getTime() - new Date(child.start_date).getTime()) / (1000*60*60*24)));
      
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
      const days = Math.max(1, Math.ceil((new Date(child.end_date).getTime() - new Date(child.start_date).getTime()) / (1000*60*60*24)));
      
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
      const start = new Date(phase.start_date);
      const end = new Date(phase.end_date);
      const days = Math.max(1, (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
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
  const { openPhaseModal, openSubphaseModal, setEditingPhase, setEditingSubphase } = useUIStore();
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  
  // Get viewMode and filter state from stores
  const viewMode = useViewStore((s) => s.viewMode);
  const showAssignments = useViewStore((s) => s.showAssignments);
  const customColumnFilters = useCustomColumnStore((s) => s.customColumnFilters);
  const customColumnValues = useCustomColumnStore((s) => s.customColumnValues);

  // Get critical path state
  const criticalPathEnabled = useAppStore((s) => s.criticalPathEnabled);
  const criticalPathItems = useAppStore((s) => s.criticalPathItems);
  
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

  const handlePhaseClick = useCallback((phase: Phase) => {
    setEditingPhase(phase);
    openPhaseModal(phase, project.id);
  }, [setEditingPhase, openPhaseModal, project.id]);

  // Subphase interaction handlers
  const handleSubphaseDragStart = useCallback((e: React.MouseEvent, subphase: Subphase, phaseId: number, element: HTMLElement) => {
    startSubphaseDrag(e, subphase.id, project.id, phaseId, subphase.start_date, subphase.end_date, subphase.is_milestone, element);
  }, [startSubphaseDrag, project.id]);

  const handleSubphaseResizeStart = useCallback((e: React.MouseEvent, subphase: Subphase, edge: 'left' | 'right', element: HTMLElement) => {
    startSubphaseResize(e, subphase.id, project.id, edge, subphase.start_date, subphase.end_date, element);
  }, [startSubphaseResize, project.id]);

  const handleSubphaseClick = useCallback((subphase: Subphase, phaseId: number) => {
    setEditingSubphase(subphase);
    openSubphaseModal(subphase, phaseId, project.id);
  }, [setEditingSubphase, openSubphaseModal, project.id]);

  // Staff assignment handlers (project-level)
  const handleStaffAssignmentDragStart = useCallback((e: React.MouseEvent, assignmentId: number, startDate: string, endDate: string) => {
    startStaffAssignmentDrag(e, assignmentId, project.id, startDate, endDate);
  }, [startStaffAssignmentDrag, project.id]);

  const handleStaffAssignmentResizeStart = useCallback((e: React.MouseEvent, assignmentId: number, edge: 'left' | 'right', startDate: string, endDate: string) => {
    startStaffAssignmentResize(e, assignmentId, project.id, edge, startDate, endDate);
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
            onDragStart={handleProjectDragStart}
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
          {showAssignments && (project.staffAssignments ?? []).map((assignment) => (
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
                interactive={true}
                onDragStart={(e) => handleStaffAssignmentDragStart(e, assignment.id, assignment.start_date, assignment.end_date)}
                onResizeStart={(e, edge) => handleStaffAssignmentResizeStart(e, assignment.id, edge, assignment.start_date, assignment.end_date)}
              />
            </div>
          ))}

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
                interactive={true}
                onDragStart={(e) => handleEquipmentAssignmentDragStart(e, assignment.id, assignment.start_date, assignment.end_date)}
                onResizeStart={(e, edge) => handleEquipmentAssignmentResizeStart(e, assignment.id, edge, assignment.start_date, assignment.end_date)}
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
            onDragStart={handleDragStart}
            onResizeStart={phase.is_milestone ? undefined : handleResizeStart}
            onClick={handleClick}
            onLinkZoneClick={handleLinkClick}
            isLinkingSource={isLinkingSource}
            isLinkingActive={isLinkingDependency}
            onPhantomStart={handlePhantom}
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
            onDragStart={handleDragStart}
            onResizeStart={subphase.is_milestone ? undefined : handleResizeStart}
            onClick={handleClick}
            onLinkZoneClick={handleLinkClick}
            isLinkingSource={isLinkingSource}
            isLinkingActive={isLinkingDependency}
            onPhantomStart={handlePhantom}
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
}

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
  interactive = false,
}: AssignmentBarProps) {
  // Get vacations from store to show vacation indicators
  const vacations = useAppStore((s) => s.vacations);
  
  const barPosition = useMemo(
    () => calculateBarPosition(startDate, endDate, cells, cellWidth, viewMode),
    [startDate, endDate, cells, cellWidth, viewMode]
  );

  // Calculate vacation cell markers for this staff member across the entire visible timeline
  const vacationCellMarkers = useMemo(() => {
    if (!staffId || assignmentType !== 'staff') return [];
    
    // Filter out recurring vacations - only show regular (non-recurring) vacations
    const staffVacations = vacations.filter(v => {
      if (v.staff_id !== staffId) return false;
      // Skip recurring vacations
      if (parseRecurringPattern(v.description)) return false;
      return true;
    });
    if (staffVacations.length === 0) return [];
    
    const markers: Array<{ left: number; width: number; title: string }> = [];
    
    // Check each cell to see if it falls within a vacation period
    cells.forEach((cell, index) => {
      const cellDate = new Date(cell.date);
      const cellEnd = new Date(cellDate);
      cellEnd.setDate(cellEnd.getDate() + 1);
      
      // Check if any vacation overlaps with this cell
      const overlappingVacation = staffVacations.find(v => {
        const vacStart = new Date(v.start_date);
        const vacEnd = new Date(v.end_date);
        vacEnd.setDate(vacEnd.getDate() + 1); // Make end date inclusive
        return vacStart < cellEnd && vacEnd > cellDate;
      });
      
      if (overlappingVacation) {
        // Check if we can merge with the previous marker
        const lastMarker = markers[markers.length - 1];
        const cellLeft = index * cellWidth;
        
        if (lastMarker && lastMarker.left + lastMarker.width === cellLeft && lastMarker.title === (overlappingVacation.description || 'Vacation')) {
          // Extend the previous marker
          lastMarker.width += cellWidth;
        } else {
          // Create a new marker
          markers.push({
            left: cellLeft,
            width: cellWidth,
            title: overlappingVacation.description || 'Vacation',
          });
        }
      }
    });
    
    return markers;
  }, [staffId, assignmentType, vacations, cells, cellWidth]);

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

  // Build label: "Name (allocation%)" for staff, just "Name" for equipment
  const label = name 
    ? (allocation ? `${name} (${allocation}%)` : name)
    : (allocation ? `${allocation}%` : '');

  const handleMouseDown = (e: React.MouseEvent) => {
    // Check if clicking on resize handle
    const target = e.target as HTMLElement;
    if (target.classList.contains('resize-handle')) return;
    
    if (onDragStart) {
      onDragStart(e);
    }
  };

  const handleResizeMouseDown = (e: React.MouseEvent, edge: 'left' | 'right') => {
    e.stopPropagation();
    if (onResizeStart) {
      onResizeStart(e, edge);
    }
  };

  return (
    <>
      {/* Vacation cell markers - purple background strips across the row */}
      {vacationCellMarkers.map((marker, idx) => (
        <div
          key={`vac-${idx}`}
          className={styles.vacationCellMarker}
          style={{
            left: marker.left,
            width: marker.width,
          }}
          title={marker.title}
        />
      ))}
      
      {/* Assignment bar */}
      <div
        className={`${styles.assignmentBar} ${styles[barType]} ${isPhaseStaff ? styles.phaseStaff : ''} ${isSubphaseStaff ? styles.subphaseStaff : ''} ${interactive ? styles.interactive : ''}`}
        style={barStyle}
        title={label}
        data-assignment-id={assignmentId}
        data-assignment-type={assignmentType}
        data-start={startDate}
        data-end={endDate}
        onMouseDown={interactive ? handleMouseDown : undefined}
      >
        {/* Left resize handle */}
        {interactive && (
          <div
            className={`${styles.resizeHandle} ${styles.left} resize-handle`}
            onMouseDown={(e) => handleResizeMouseDown(e, 'left')}
          />
        )}
        
        <span className={styles.barLabel}>{label}</span>
        
        {/* Right resize handle */}
        {interactive && (
          <div
            className={`${styles.resizeHandle} ${styles.right} resize-handle`}
            onMouseDown={(e) => handleResizeMouseDown(e, 'right')}
          />
        )}
      </div>
    </>
  );
});
