/**
 * ProjectRow
 * A single project row in the project panel with expandable children
 */

import { memo, useMemo, useCallback, Fragment } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { PhaseRow } from './PhaseRow';
import { AssignmentRow } from './AssignmentRow';
import { PhantomRow } from './PhantomRow';
import { usePhantomSibling } from '@/hooks';
import type { Project, Phase, Subphase } from '@/types';
import styles from './ProjectRow.module.css';

interface ProjectRowProps {
  project: Project;
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

export const ProjectRow = memo(function ProjectRow({ project }: ProjectRowProps) {
  const expandedProjects = useAppStore((s) => s.expandedProjects);
  const expandedPhases = useAppStore((s) => s.expandedPhases);
  const expandedSubphases = useAppStore((s) => s.expandedSubphases);
  const toggleProjectExpanded = useAppStore((s) => s.toggleProjectExpanded);
  const expandProjectLevel = useAppStore((s) => s.expandProjectLevel);
  const collapseProjectLevel = useAppStore((s) => s.collapseProjectLevel);
  const staff = useAppStore((s) => s.staff);
  const equipment = useAppStore((s) => s.equipment);
  const openProjectModal = useUIStore((s) => s.openProjectModal);

  const isExpanded = expandedProjects.has(project.id);
  const completion = useMemo(() => calculateProjectCompletion(project), [project]);

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

  const handleEdit = () => {
    openProjectModal(project);
  };

  const showContextMenu = useUIStore((s) => s.showContextMenu);
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    showContextMenu('project', project.id, e.clientX, e.clientY);
  }, [showContextMenu, project.id]);

  return (
    <>
      {/* Project row */}
      <div
        className={`${styles.row} ${!project.confirmed ? styles.unconfirmed : ''}`}
        data-project-id={project.id}
        onDoubleClick={handleEdit}
        onContextMenu={handleContextMenu}
      >
        {/* Level controls (+/-) */}
        <div className={styles.levelControls} onClick={(e) => e.stopPropagation()}>
          <button
            className={styles.levelBtn}
            onClick={handleCollapseLevel}
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
            disabled={currentLevel >= maxLevel}
            title="Expand one level"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

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

      {/* Expanded children */}
      {isExpanded && (
        <div className={styles.children}>
          {/* Phases with PhantomRow after source */}
          <PhasesWithPhantom
            phases={project.phases ?? []}
            projectId={project.id}
          />

          {/* Project-level staff assignments */}
          {(project.staffAssignments ?? []).map((assignment) => {
            const staffMember = staff.find((s) => s.id === assignment.staff_id);
            return (
              <AssignmentRow
                key={`staff-${assignment.id}`}
                type="staff"
                name={staffMember?.name || 'Unknown'}
                role={staffMember?.role}
                allocation={assignment.allocation}
                depth={1}
              />
            );
          })}

          {/* Project-level equipment assignments */}
          {(project.equipmentAssignments ?? []).map((assignment) => {
            const equip = equipment.find((e) => e.id === assignment.equipment_id);
            return (
              <AssignmentRow
                key={`equip-${assignment.id}`}
                type="equipment"
                name={equip?.name || 'Unknown'}
                equipmentType={equip?.type}
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
function PhasesWithPhantom({ phases, projectId }: { phases: Phase[]; projectId: number }) {
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  const { completePhantom, cancelPhantom } = usePhantomSibling();
  
  // Check if phantom mode is for a phase in this project
  const showPhantomAfter = phantomSiblingMode?.type === 'phase' && 
    phantomSiblingMode.projectId === projectId
    ? phantomSiblingMode.sourceId
    : null;
  
  return (
    <>
      {phases.map((phase) => (
        <Fragment key={phase.id}>
          <PhaseRow
            phase={phase}
            projectId={projectId}
            depth={1}
            phases={phases}
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
