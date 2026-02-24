/**
 * ProjectRow
 * A single project row in the project panel with expandable children
 */

import { memo, useMemo, useCallback, Fragment, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { PhaseRow } from './PhaseRow';
import { AssignmentRow } from './AssignmentRow';
import { PhantomRow } from './PhantomRow';
import { usePhantomSibling } from '@/hooks';
import type { Project, Phase, Subphase, CustomColumn } from '@/types';
import styles from './ProjectRow.module.css';

interface ProjectRowProps {
  project: Project;
  customColumns?: CustomColumn[];
  nameColumnWidth: number;  // Width of the name/info column
  onReorder?: (fromId: number, toId: number) => void;  // Callback when project is reordered
  siblingIds?: number[];  // IDs of all projects for reorder context
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
      const days = Math.max(1, Math.ceil((new Date(child.end_date).getTime() - new Date(child.start_date).getTime()) / (1000*60*60*24)));
      
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
    const start = new Date(phase.start_date);
    const end = new Date(phase.end_date);
    const days = Math.max(1, (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    
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
  siblingIds = [],
  index: _index = 0,
}: ProjectRowProps) {
  const expandedProjects = useAppStore((s) => s.expandedProjects);
  const expandedPhases = useAppStore((s) => s.expandedPhases);
  const expandedSubphases = useAppStore((s) => s.expandedSubphases);
  const toggleProjectExpanded = useAppStore((s) => s.toggleProjectExpanded);
  const expandProjectLevel = useAppStore((s) => s.expandProjectLevel);
  const collapseProjectLevel = useAppStore((s) => s.collapseProjectLevel);
  const staff = useAppStore((s) => s.staff);
  const equipment = useAppStore((s) => s.equipment);
  const showAssignments = useAppStore((s) => s.showAssignments);
  const toggleCriticalPath = useAppStore((s) => s.toggleCriticalPath);
  const isCriticalPathEnabled = useAppStore((s) => s.isCriticalPathEnabled);
  const criticalPathItems = useAppStore((s) => s.criticalPathItems);
  const openProjectModal = useUIStore((s) => s.openProjectModal);

  const isExpanded = expandedProjects.has(project.id);
  const completion = useMemo(() => calculateProjectCompletion(project), [project]);
  
  // Get critical path items for this project
  const projectCriticalPathItems = criticalPathItems.get(project.id) || new Set<string>();

  // Calculate current expansion level for this project
  const currentLevel = useMemo(() => {
    if (!expandedProjects.has(project.id)) return 0;
    const phases = project.phases ?? [];
    const anyPhaseExpanded = phases.some(p => expandedPhases.has(p.id));
    if (!anyPhaseExpanded) return 1;
    
    // Check if any subphases are expanded
    let anySubphaseExpanded = false;
    phases.forEach(phase => {
      const checkSubphases = (children: typeof phase.children) => {
        children?.forEach(child => {
          if (expandedSubphases.has(child.id)) anySubphaseExpanded = true;
          checkSubphases(child.children);
        });
      };
      checkSubphases(phase.children);
    });
    
    return anySubphaseExpanded ? 3 : 2;
  }, [project, expandedProjects, expandedPhases, expandedSubphases]);

  // Calculate max possible level
  // Always allow at least level 1 so users can expand to add phases
  const maxLevel = useMemo(() => {
    const phases = project.phases ?? [];
    
    // Always allow expanding to level 1 (to add phases)
    let maxDepth = 1;
    
    phases.forEach(phase => {
      if (phase.children?.length > 0) {
        maxDepth = Math.max(maxDepth, 2);
        const checkDepth = (children: typeof phase.children, depth: number) => {
          children?.forEach(child => {
            maxDepth = Math.max(maxDepth, depth);
            if (child.children?.length > 0) {
              checkDepth(child.children, depth + 1);
            }
          });
        };
        checkDepth(phase.children, 3);
      }
    });
    return maxDepth;
  }, [project]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleProjectExpanded(project.id);
  };

  const handleExpandLevel = (e: React.MouseEvent) => {
    e.stopPropagation();
    expandProjectLevel(project.id);
  };

  const handleCollapseLevel = (e: React.MouseEvent) => {
    e.stopPropagation();
    collapseProjectLevel(project.id);
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
    
    // Calculate target ID
    let targetId = project.id;
    if (!insertBefore && siblingIds.length > 0) {
      // If dropping below, find the next sibling
      const currentIndex = siblingIds.indexOf(project.id);
      if (currentIndex < siblingIds.length - 1) {
        targetId = siblingIds[currentIndex + 1];
      }
    }
    
    if (onReorder) {
      onReorder(draggedId, targetId);
    }
    
    setDropPosition(null);
  }, [project.id, siblingIds, onReorder]);

  return (
    <>
      {/* Project row */}
      <div
        className={`${styles.row} ${!project.confirmed ? styles.unconfirmed : ''} ${dropPosition === 'above' ? styles.dropAbove : ''} ${dropPosition === 'below' ? styles.dropBelow : ''} ${isDragging ? styles.dragging : ''}`}
        data-project-id={project.id}
        onDoubleClick={handleEdit}
        onContextMenu={handleContextMenu}
        onDragOver={handleProjectDragOver}
        onDragLeave={handleProjectDragLeave}
        onDrop={handleProjectDrop}
      >
        {/* Name column - fixed width */}
        <div className={styles.nameColumn} style={{ width: nameColumnWidth }}>
          {/* Drag handle for reordering */}
          {onReorder && (
            <div
              className={styles.dragHandle}
              draggable
              onDragStart={handleProjectDragStart}
              onDragEnd={handleProjectDragEnd}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              title="Drag to reorder"
            >
              <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">
                <circle cx="2" cy="2" r="1.2" />
                <circle cx="6" cy="2" r="1.2" />
                <circle cx="2" cy="6" r="1.2" />
                <circle cx="6" cy="6" r="1.2" />
                <circle cx="2" cy="10" r="1.2" />
                <circle cx="6" cy="10" r="1.2" />
              </svg>
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
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              className={styles.levelBtn}
              onClick={handleExpandLevel}
              onDoubleClick={(e) => e.stopPropagation()}
              disabled={currentLevel >= maxLevel}
              title="Expand one level"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>

          {/* Critical Path toggle */}
          <button
            className={`${styles.criticalPathBtn} ${isCriticalPathEnabled(project.id) ? styles.active : ''}`}
            onClick={handleCriticalPathToggle}
            onDoubleClick={(e) => e.stopPropagation()}
            title={isCriticalPathEnabled(project.id) ? 'Hide Critical Path' : 'Show Critical Path'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
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
              {project.customer && (
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
  const customColumnFilters = useAppStore((s) => s.customColumnFilters);
  const customColumnValues = useAppStore((s) => s.customColumnValues);
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
