/**
 * ProjectRow
 * A single project row in the project panel with expandable children
 */

import { memo, useMemo, useCallback, Fragment, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { isBuiltInFieldHidden } from '@/utils/instanceSettings';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { useUIStore } from '@/stores/uiStore';
import { PhaseRow } from './PhaseRow';
import { AssignmentRow } from './AssignmentRow';
import { PhantomRow } from './PhantomRow';
import { usePhantomSibling } from '@/hooks';
import { canEditProject } from '@/utils/permissions';
import type { Project, Phase, Subphase, CustomColumn } from '@/types';
import styles from './ProjectRow.module.css';
import { daysBetweenDateStrings } from '@/utils/date';
import { getProjectLevelItems, expansionLevelOf } from '@/utils/projectLevels';
import { Icon, BoltIcon, PlusIcon, MinusIcon, DragDotsIcon } from '@/components/common/Icon';

interface ProjectRowProps {
  project: Project;
  customColumns?: CustomColumn[];
  nameColumnWidth: number;  // Width of the name/info column
  onReorder?: (fromId: number, targetId: number, position: 'before' | 'after') => void;  // Callback when project is reordered
  index?: number;  // Position in the list
}

// Recursively calculate effective completion for a phase/subphase
// If at least one child has a completion value, unset siblings count as 0%
function getEffectiveCompletion(item: Phase | Subphase): { completion: number | null; isCalculated: boolean } {
  if (!item) return { completion: null, isCalculated: false };
  
  const children = item.children || [];
  
  // Check if any children have completion (direct or calculated)
  let hasChildrenWithCompletion = false;
  for (const child of children) {
    if (!child) continue;
    const childResult = getEffectiveCompletion(child);
    if (childResult && childResult.completion !== null) {
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
      if (!child) continue;
      const childResult = getEffectiveCompletion(child);
      const days = Math.max(1, daysBetweenDateStrings(child.start_date, child.end_date));
      
      // Unset completion counts as 0% when at least one sibling has a value
      const completion = childResult.completion ?? 0;
      weightedSum += completion * days;
      totalWeight += days;
    }
    
    if (totalWeight > 0) {
      return { completion: Math.round(weightedSum / totalWeight), isCalculated: true };
    }
  }
  
  // No children with completion, return item's own completion
  return { completion: item.completion ?? null, isCalculated: false };
}

// Calculate project completion from phases (weighted by duration, using effective completion)
// Unset phases count as 0% in the calculation
function calculateProjectCompletion(project: Project): number | null {
  const phases = project.phases ?? [];
  if (phases.length === 0) return null;

  let weightedSum = 0;
  let totalWeight = 0;

  phases.forEach((phase) => {
    const effectiveResult = getEffectiveCompletion(phase);
    const days = Math.max(1, daysBetweenDateStrings(phase.start_date, phase.end_date));
    
    // Unset completion counts as 0%
    const completion = effectiveResult.completion ?? 0;
    weightedSum += completion * days;
    totalWeight += days;
  });

  if (totalWeight > 0) {
    return Math.round(weightedSum / totalWeight);
  }
  return null;
}

export const ProjectRow = memo(function ProjectRow({ 
  project, 
  customColumns = [], 
  nameColumnWidth,
  onReorder,
  index: _index = 0,
}: ProjectRowProps) {
  const expandedProjects = useViewStore((s) => s.expandedProjects);
  const expandedPhases = useViewStore((s) => s.expandedPhases);
  const expandedSubphases = useViewStore((s) => s.expandedSubphases);
  const toggleProjectExpanded = useViewStore((s) => s.toggleProjectExpanded);
  const expandProjectLevel = useViewStore((s) => s.expandProjectLevel);
  const collapseProjectLevel = useViewStore((s) => s.collapseProjectLevel);
  const staff = useAppStore((s) => s.staff);
  const equipment = useAppStore((s) => s.equipment);
  const currentUser = useAppStore((s) => s.currentUser);
  // Admins, superusers and this project's manager.
  const canEdit = canEditProject(currentUser, project);
  const showAssignments = useViewStore((s) => s.showAssignments);
  const toggleCriticalPath = useAppStore((s) => s.toggleCriticalPath);
  const isCriticalPathEnabled = useAppStore((s) => s.isCriticalPathEnabled);
  const criticalPathItems = useAppStore((s) => s.criticalPathItems);
  const projects = useAppStore((s) => s.projects);
  const customerHidden = useAppStore((s) => isBuiltInFieldHidden(s.instanceSettings, 'customer'));
  const openProjectModal = useUIStore((s) => s.openProjectModal);

  const isExpanded = expandedProjects.has(project.id);
  const completion = useMemo(() => calculateProjectCompletion(project), [project]);
  
  // Get critical path items for this project
  const projectCriticalPathItems = criticalPathItems.get(project.id) || new Set<string>();

  // Current and deepest expansion level — the same definition the store's
  // expandProjectLevel/collapseProjectLevel step through, so "+" disables
  // exactly when there is nothing left to expand.
  const levelItems = useMemo(() => getProjectLevelItems(project), [project]);
  const maxLevel = levelItems.maxLevel;
  const currentLevel = useMemo(
    () => (isExpanded ? expansionLevelOf(levelItems, expandedPhases, expandedSubphases) : 0),
    [isExpanded, levelItems, expandedPhases, expandedSubphases]
  );

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleProjectExpanded(project.id);
  };

  const handleExpandLevel = (e: React.MouseEvent) => {
    e.stopPropagation();
    expandProjectLevel(project.id, projects);
  };

  const handleCollapseLevel = (e: React.MouseEvent) => {
    e.stopPropagation();
    collapseProjectLevel(project.id, projects);
  };

  const handleCriticalPathToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleCriticalPath(project.id);
  };

  const handleEdit = () => {
    openProjectModal(project);
  };

  const showContextMenu = useUIStore((s) => s.showContextMenu);
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    showContextMenu('project', project.id, e.clientX, e.clientY);
  }, [showContextMenu, project.id]);

  // Project reorder drag state
  const [dropPosition, setDropPosition] = useState<'above' | 'below' | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  
  // Project drag handlers for reordering
  const handleProjectDragStart = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    setIsDragging(true);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-project-reorder', String(project.id));
  }, [project.id]);
  
  const handleProjectDragEnd = useCallback(() => {
    setIsDragging(false);
    setDropPosition(null);
  }, []);
  
  const handleProjectDragOver = useCallback((e: React.DragEvent) => {
    // Only accept project reorder drags
    if (!e.dataTransfer.types.includes('application/x-project-reorder')) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    // Determine drop position based on mouse position
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const newPosition = e.clientY < midpoint ? 'above' : 'below';
    setDropPosition(newPosition);
  }, []);
  
  const handleProjectDragLeave = useCallback((e: React.DragEvent) => {
    // Only reset if actually leaving the element (not entering a child)
    const relatedTarget = e.relatedTarget as HTMLElement;
    const currentTarget = e.currentTarget as HTMLElement;
    if (relatedTarget && currentTarget.contains(relatedTarget)) return;
    setDropPosition(null);
  }, []);
  
  const handleProjectDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const draggedId = parseInt(e.dataTransfer.getData('application/x-project-reorder'), 10);
    if (isNaN(draggedId) || draggedId === project.id) {
      setDropPosition(null);
      return;
    }
    
    // Determine target position
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const insertBefore = e.clientY < midpoint;
    
    if (onReorder) {
      onReorder(draggedId, project.id, insertBefore ? 'before' : 'after');
    }
    
    setDropPosition(null);
  }, [project.id, onReorder]);

  return (
    <>
      {/* Project row */}
      <div
        className={`${styles.row} ${!project.confirmed ? styles.unconfirmed : ''} ${dropPosition === 'above' ? styles.dropAbove : ''} ${dropPosition === 'below' ? styles.dropBelow : ''} ${isDragging ? styles.dragging : ''}`}
        data-project-id={project.id}
        onDoubleClick={canEdit ? handleEdit : undefined}
        onContextMenu={handleContextMenu}
        onDragOver={handleProjectDragOver}
        onDragLeave={handleProjectDragLeave}
        onDrop={handleProjectDrop}
      >
        {/* Name column - fixed width */}
        <div className={styles.nameColumn} style={{ width: nameColumnWidth }}>
          {/* Drag handle for reordering */}
          {onReorder && canEdit && (
            <div
              className={styles.dragHandle}
              draggable
              onDragStart={handleProjectDragStart}
              onDragEnd={handleProjectDragEnd}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              title="Drag to reorder"
            >
              <Icon icon={DragDotsIcon} size={12} />
            </div>
          )}
          
          {/* Level controls (+/-) */}
          <div 
            className={styles.levelControls} 
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <button
              className={styles.levelBtn}
              onClick={handleCollapseLevel}
              onDoubleClick={(e) => e.stopPropagation()}
              disabled={currentLevel === 0}
              title="Collapse one level"
            >
              <Icon icon={MinusIcon} size={12} />
            </button>
            <button
              className={styles.levelBtn}
              onClick={handleExpandLevel}
              onDoubleClick={(e) => e.stopPropagation()}
              disabled={currentLevel >= maxLevel}
              title="Expand one level"
            >
              <Icon icon={PlusIcon} size={12} />
            </button>
          </div>

          {/* Critical Path toggle */}
          <button
            className={`${styles.criticalPathBtn} ${isCriticalPathEnabled(project.id) ? styles.active : ''}`}
            onClick={handleCriticalPathToggle}
            onDoubleClick={(e) => e.stopPropagation()}
            title={isCriticalPathEnabled(project.id) ? 'Hide Critical Path' : 'Show Critical Path'}
          >
            <Icon icon={BoltIcon} size={14} />
          </button>

          {/* Status indicator */}
          <span
            className={`${styles.status} ${project.confirmed ? styles.confirmed : styles.pending}`}
            title={project.confirmed ? 'Confirmed' : 'Unconfirmed'}
            onClick={handleToggle}
          />

          {/* Completion badge */}
          {completion !== null && (
            <span 
              className={styles.completionBadge}
              title="Project completion (calculated from phases)"
            >
              {completion}%
            </span>
          )}

          {/* Project info */}
          <div className={styles.info} onClick={handleToggle}>
            <span className={styles.name} title={project.name}>
              {project.name}
            </span>
            <span className={styles.meta}>
              {project.pm_name && (
                <span className={styles.pm}>{project.pm_name}</span>
              )}
              {project.customer && !customerHidden && (
                <span className={styles.customer}> · {project.customer}</span>
              )}
            </span>
          </div>
        </div>
        
        {/* Empty placeholders for custom columns to maintain alignment */}
        {customColumns.length > 0 && (
          <div className={styles.customCells}>
            {customColumns.map(column => (
              <div 
                key={column.id} 
                className={`${styles.customCell} ${styles.emptyCell}`}
                style={{ width: column.width }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Expanded children */}
      {isExpanded && (
        <div className={styles.children}>
          {/* Phases with PhantomRow after source */}
          <PhasesWithPhantom
            phases={project.phases ?? []}
            projectId={project.id}
            customColumns={customColumns}
            nameColumnWidth={nameColumnWidth}
            criticalPathItems={projectCriticalPathItems}
          />

          {/* Project-level staff assignments */}
          {/* Project-level staff assignments - filtered by showAssignments */}
          {showAssignments && (project.staffAssignments ?? []).map((assignment) => {
            const staffMember = staff.find((s) => s.id === assignment.staff_id);
            return (
              <AssignmentRow
                key={`staff-${assignment.id}`}
                type="staff"
                assignmentId={assignment.id}
                projectId={project.id}
                staffId={assignment.staff_id}
                name={staffMember?.name || assignment.staff_name || 'Unknown'}
                role={staffMember?.role}
                allocation={assignment.allocation}
                startDate={assignment.start_date}
                endDate={assignment.end_date}
                depth={1}
                approvalStatus={assignment.approval_status}
                approval={assignment.approval}
              />
            );
          })}

          {/* Project-level equipment assignments - filtered by showAssignments */}
          {showAssignments && (project.equipmentAssignments ?? []).map((assignment) => {
            const equip = equipment.find((e) => e.id === assignment.equipment_id);
            return (
              <AssignmentRow
                key={`equip-${assignment.id}`}
                type="equipment"
                assignmentId={assignment.id}
                projectId={project.id}
                equipmentId={assignment.equipment_id}
                name={equip?.name || assignment.equipment_name || 'Unknown'}
                equipmentType={equip?.type}
                startDate={assignment.start_date}
                endDate={assignment.end_date}
                depth={1}
              />
            );
          })}
        </div>
      )}
    </>
  );
});

/**
 * Helper component to render phases with PhantomRow after source
 */
function PhasesWithPhantom({ 
  phases, 
  projectId, 
  customColumns,
  nameColumnWidth,
  criticalPathItems,
}: { 
  phases: Phase[]; 
  projectId: number;
  customColumns: CustomColumn[];
  nameColumnWidth: number;
  criticalPathItems: Set<string>;
}) {
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  const customColumnFilters = useCustomColumnStore((s) => s.customColumnFilters);
  const customColumnValues = useCustomColumnStore((s) => s.customColumnValues);
  const { completePhantom, cancelPhantom } = usePhantomSibling();
  
  // Check if phantom mode is for a phase in this project
  const showPhantomAfter = phantomSiblingMode?.type === 'phase' && 
    phantomSiblingMode.projectId === projectId
    ? phantomSiblingMode.sourceId
    : null;
  
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
  
  // Filter phases: show if phase matches OR any descendant subphase matches
  const visiblePhases = useMemo(() => 
    phases.filter(phase => 
      entityPassesFilters('phase', phase.id) || 
      anyDescendantMatches(phase.children ?? [])
    ),
    [phases, entityPassesFilters, anyDescendantMatches]
  );
  
  return (
    <>
      {visiblePhases.map((phase) => (
        <Fragment key={phase.id}>
          <PhaseRow
            phase={phase}
            projectId={projectId}
            depth={1}
            phases={phases}
            customColumns={customColumns}
            nameColumnWidth={nameColumnWidth}
            criticalPathItems={criticalPathItems}
          />
          {showPhantomAfter === phase.id && (
            <PhantomRow
              onComplete={completePhantom}
              onCancel={cancelPhantom}
            />
          )}
        </Fragment>
      ))}
    </>
  );
}
