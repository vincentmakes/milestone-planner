/**
 * PhaseRow
 * A phase row within a project, with expandable subphases
 * Supports drag-and-drop reordering
 */

import { memo, useMemo, useCallback, Fragment } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useReorder } from '@/contexts/ReorderContext';
import { SubphaseRow } from './SubphaseRow';
import { AssignmentRow } from './AssignmentRow';
import { PhantomRow } from './PhantomRow';
import { usePhantomSibling } from '@/hooks';
import type { Phase, Subphase } from '@/types';
import styles from './PhaseRow.module.css';

interface PhaseRowProps {
  phase: Phase;
  projectId: number;
  depth: number;
  phases: Phase[];  // All phases for reorder context
}

// Format date range like vanilla JS
function formatDateRange(startDate: string, endDate: string): string {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const start = new Date(startDate).toLocaleDateString('en-US', options);
  const end = new Date(endDate).toLocaleDateString('en-US', options);
  return `${start} - ${end}`;
}

// Recursively calculate effective completion for an item
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

export const PhaseRow = memo(function PhaseRow({
  phase,
  projectId,
  depth,
  phases,
}: PhaseRowProps) {
  const expandedPhases = useAppStore((s) => s.expandedPhases);
  const togglePhaseExpanded = useAppStore((s) => s.togglePhaseExpanded);
  const staff = useAppStore((s) => s.staff);
  const equipment = useAppStore((s) => s.equipment);
  const openPhaseModal = useUIStore((s) => s.openPhaseModal);
  
  // Reorder hooks
  const {
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
    isDragging,
    getDropPosition,
  } = useReorder();

  const isExpanded = expandedPhases.has(phase.id);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    togglePhaseExpanded(phase.id);
  };

  const handleEdit = () => {
    openPhaseModal(phase, projectId);
  };

  const hasChildren =
    (phase.children?.length ?? 0) > 0 ||
    (phase.staffAssignments?.length ?? 0) > 0 ||
    (phase.equipmentAssignments?.length ?? 0) > 0;

  const paddingLeft = depth * 16 + 8;

  // Format date display
  const dateDisplay = useMemo(() => {
    if (phase.is_milestone) {
      return new Date(phase.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return formatDateRange(phase.start_date, phase.end_date);
  }, [phase.start_date, phase.end_date, phase.is_milestone]);

  // Get effective completion (calculated from children or manual)
  const completionResult = useMemo(() => getEffectiveCompletion(phase), [phase]);

  const showContextMenu = useUIStore((s) => s.showContextMenu);
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    showContextMenu('phase', phase.id, e.clientX, e.clientY, projectId);
  }, [showContextMenu, phase.id, projectId]);

  // Drag handlers
  const onDragStart = useCallback((e: React.DragEvent) => {
    handleDragStart(e, 'phase', phase.id, projectId);
  }, [handleDragStart, phase.id, projectId]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    handleDragOver(e, 'phase', phase.id);
  }, [handleDragOver, phase.id]);

  const onDrop = useCallback((e: React.DragEvent) => {
    handleDrop(e, 'phase', phase.id, phases);
  }, [handleDrop, phase.id, phases]);

  const dragging = isDragging('phase', phase.id);
  const dropPosition = getDropPosition('phase', phase.id);

  return (
    <>
      {/* Phase row */}
      <div
        className={`${styles.row} ${dragging ? styles.dragging : ''} ${dropPosition ? styles[`drop${dropPosition.charAt(0).toUpperCase() + dropPosition.slice(1)}`] : ''}`}
        style={{ paddingLeft }}
        data-phase-id={phase.id}
        onDragOver={onDragOver}
        onDragLeave={handleDragLeave}
        onDrop={onDrop}
        onDoubleClick={handleEdit}
        onContextMenu={handleContextMenu}
      >
        {/* Drag handle */}
        <div
          className={styles.dragHandle}
          draggable
          onDragStart={onDragStart}
          onDragEnd={handleDragEnd}
          title="Drag to reorder"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="2" />
            <circle cx="15" cy="6" r="2" />
            <circle cx="9" cy="12" r="2" />
            <circle cx="15" cy="12" r="2" />
            <circle cx="9" cy="18" r="2" />
            <circle cx="15" cy="18" r="2" />
          </svg>
        </div>
        {/* Expand button */}
        <button
          className={`${styles.expandBtn} ${isExpanded ? styles.expanded : ''}`}
          onClick={handleToggle}
          disabled={!hasChildren}
        >
          {hasChildren && (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          )}
        </button>

        {/* Completion badge - always shown */}
        <span 
          className={`${styles.completionBadge} ${
            completionResult.completion !== null 
              ? (completionResult.isCalculated ? styles.calculated : styles.manual)
              : styles.empty
          }`}
          title={
            completionResult.completion !== null
              ? (completionResult.isCalculated ? 'Calculated from children' : 'Click to edit')
              : 'Click to set completion'
          }
        >
          {completionResult.completion !== null ? `${completionResult.completion}%` : '—'}
        </span>

        {/* Type badge */}
        <span
          className={styles.typeBadge}
          style={{ 
            backgroundColor: `${phase.color}33`,
            color: phase.color 
          }}
        >
          {phase.is_milestone ? '◆' : ''}{phase.name}
        </span>

        {/* Date display */}
        <span className={styles.dateDisplay}>
          {dateDisplay}
        </span>
      </div>

      {/* Expanded children */}
      {isExpanded && (
        <>
          {/* Subphases with phantom row support */}
          <PhaseSubphasesWithPhantom
            subphases={phase.children ?? []}
            phaseId={phase.id}
            projectId={projectId}
            depth={depth + 1}
          />

          {/* Phase-level staff assignments */}
          {(phase.staffAssignments ?? []).map((assignment) => {
            const staffMember = staff.find((s) => s.id === assignment.staff_id);
            return (
              <AssignmentRow
                key={`staff-${assignment.id}`}
                type="phase-staff"
                name={staffMember?.name || 'Unknown'}
                role={staffMember?.role}
                allocation={assignment.allocation}
                depth={depth + 1}
                phaseType={phase.name}
                phaseColor={phase.color}
              />
            );
          })}

          {/* Phase-level equipment assignments */}
          {(phase.equipmentAssignments ?? []).map((assignment) => {
            const equip = equipment.find((e) => e.id === assignment.equipment_id);
            return (
              <AssignmentRow
                key={`equip-${assignment.id}`}
                type="equipment"
                name={equip?.name || 'Unknown'}
                equipmentType={equip?.type}
                depth={depth + 1}
              />
            );
          })}
        </>
      )}
    </>
  );
});

/**
 * Helper component to render phase's direct subphases with PhantomRow after source
 */
function PhaseSubphasesWithPhantom({ 
  subphases, 
  phaseId, 
  projectId, 
  depth 
}: { 
  subphases: Subphase[]; 
  phaseId: number; 
  projectId: number; 
  depth: number; 
}) {
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  const { completePhantom, cancelPhantom } = usePhantomSibling();
  
  // Check if phantom mode is for a subphase under this phase
  const showPhantomAfter = phantomSiblingMode?.type === 'subphase' && 
    phantomSiblingMode.projectId === projectId &&
    phantomSiblingMode.parentType === 'phase' &&
    phantomSiblingMode.parentId === phaseId
    ? phantomSiblingMode.sourceId
    : null;
  
  return (
    <>
      {subphases.map((subphase) => (
        <Fragment key={subphase.id}>
          <SubphaseRow
            subphase={subphase}
            phaseId={phaseId}
            projectId={projectId}
            depth={depth}
            wbsLevel={1}
            siblings={subphases}
            parentId={phaseId}
            parentType="phase"
          />
          {showPhantomAfter === subphase.id && (
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
