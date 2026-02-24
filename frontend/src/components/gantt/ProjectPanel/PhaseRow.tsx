/**
 * PhaseRow
 * A phase row within a project, with expandable subphases
 * Supports drag-and-drop reordering
 */

import { memo, useMemo, useCallback, Fragment, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useReorder } from '@/contexts/ReorderContext';
import { SubphaseRow } from './SubphaseRow';
import { AssignmentRow } from './AssignmentRow';
import { PhantomRow } from './PhantomRow';
import { usePhantomSibling } from '@/hooks';
import { CustomColumnCell } from '@/components/gantt/CustomColumns';
import { CompletionSlider } from '@/components/gantt/CompletionSlider';
import { updatePhase } from '@/api';
import { formatShortDateRange, formatSingleDate } from '@/utils/date';
import type { Phase, Subphase, CustomColumn, CustomColumnEntityType } from '@/types';
import styles from './PhaseRow.module.css';

// Child entity info for cascading values
interface ChildEntity {
  entityType: CustomColumnEntityType;
  entityId: number;
}

// Collect all descendant subphase IDs recursively
function collectAllDescendants(subphases: Subphase[]): ChildEntity[] {
  const result: ChildEntity[] = [];
  
  function traverse(items: Subphase[]) {
    for (const sp of items) {
      result.push({ entityType: 'subphase', entityId: sp.id });
      if (sp.children && sp.children.length > 0) {
        traverse(sp.children);
      }
    }
  }
  
  traverse(subphases);
  return result;
}

interface PhaseRowProps {
  phase: Phase;
  projectId: number;
  depth: number;
  phases: Phase[];  // All phases for reorder context
  customColumns?: CustomColumn[];
  nameColumnWidth: number;
  criticalPathItems?: Set<string>;  // Critical path items for this project
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
  customColumns = [],
  nameColumnWidth,
  criticalPathItems = new Set(),
}: PhaseRowProps) {
  const expandedPhases = useAppStore((s) => s.expandedPhases);
  const togglePhaseExpanded = useAppStore((s) => s.togglePhaseExpanded);
  const staff = useAppStore((s) => s.staff);
  const equipment = useAppStore((s) => s.equipment);
  const currentUser = useAppStore((s) => s.currentUser);
  const showAssignments = useAppStore((s) => s.showAssignments);
  const projects = useAppStore((s) => s.projects);
  const setProjects = useAppStore((s) => s.setProjects);
  const openPhaseModal = useUIStore((s) => s.openPhaseModal);
  
  const canEdit = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  
  // Completion slider state
  const [sliderAnchor, setSliderAnchor] = useState<HTMLElement | null>(null);
  const showSlider = Boolean(sliderAnchor);
  
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
  
  // Handle clicking on completion badge to show slider
  const handleCompletionClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // Don't show slider if calculated from children
    const result = getEffectiveCompletion(phase);
    if (result.isCalculated) return;
    setSliderAnchor(e.currentTarget as HTMLElement);
  }, [phase]);
  
  // Handle completion change from slider
  const handleCompletionChange = useCallback(async (value: number) => {
    try {
      const newCompletion = value === -1 ? null : value;
      await updatePhase(phase.id, { completion: newCompletion });
      
      // Update local state optimistically
      const updatedProjects = projects.map(p => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          phases: (p.phases ?? []).map(ph => 
            ph.id === phase.id ? { ...ph, completion: newCompletion } : ph
          )
        };
      });
      setProjects(updatedProjects);
    } catch (err) {
      console.error('Failed to update phase completion:', err);
    }
  }, [phase.id, projectId, projects, setProjects]);

  const hasChildren =
    (phase.children?.length ?? 0) > 0 ||
    (phase.staffAssignments?.length ?? 0) > 0 ||
    (phase.equipmentAssignments?.length ?? 0) > 0;

  const paddingLeft = depth * 16 + 8;

  // Format date display using browser locale
  const dateDisplay = useMemo(() => {
    if (phase.is_milestone) {
      return formatSingleDate(phase.start_date);
    }
    return formatShortDateRange(phase.start_date, phase.end_date);
  }, [phase.start_date, phase.end_date, phase.is_milestone]);

  // Get effective completion (calculated from children or manual)
  const completionResult = useMemo(() => getEffectiveCompletion(phase), [phase]);

  // Collect all descendant subphases for cascading custom column values
  const childEntities = useMemo(() => collectAllDescendants(phase.children ?? []), [phase.children]);

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
        data-phase-id={phase.id}
        onDragOver={onDragOver}
        onDragLeave={handleDragLeave}
        onDrop={onDrop}
        onDoubleClick={handleEdit}
        onContextMenu={handleContextMenu}
      >
        {/* Name column - fixed width */}
        <div className={styles.nameColumn} style={{ width: nameColumnWidth, paddingLeft }}>
          {/* Critical path indicator */}
          {criticalPathItems.has(`phase-${phase.id}`) && (
            <span className={styles.criticalPathDot} title="On Critical Path" />
          )}
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

          {/* Completion badge - always shown, clickable when not calculated */}
          <span 
            className={`${styles.completionBadge} ${
              completionResult.completion !== null 
                ? (completionResult.isCalculated ? styles.calculated : styles.manual)
                : styles.empty
            }`}
            style={{ cursor: completionResult.isCalculated ? 'default' : 'pointer' }}
            title={
              completionResult.completion !== null
                ? (completionResult.isCalculated ? 'Calculated from children' : 'Click to edit')
                : 'Click to set completion'
            }
            onClick={handleCompletionClick}
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

        {/* Custom Column Cells */}
        {customColumns.length > 0 && (
          <div className={styles.customCells}>
            {customColumns.map(column => (
              <div 
                key={column.id} 
                className={styles.customCell}
                style={{ width: column.width }}
              >
                <CustomColumnCell
                  column={column}
                  entityType="phase"
                  entityId={phase.id}
                  readOnly={!canEdit}
                  childEntities={childEntities}
                />
              </div>
            ))}
          </div>
        )}
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
            customColumns={customColumns}
            nameColumnWidth={nameColumnWidth}
            criticalPathItems={criticalPathItems}
          />

          {/* Phase-level staff assignments - filtered by showAssignments */}
          {showAssignments && (phase.staffAssignments ?? []).map((assignment) => {
            const staffMember = staff.find((s) => s.id === assignment.staff_id);
            return (
              <AssignmentRow
                key={`staff-${assignment.id}`}
                type="phase-staff"
                assignmentId={assignment.id}
                projectId={projectId}
                phaseId={phase.id}
                staffId={assignment.staff_id}
                name={staffMember?.name || assignment.staff_name || 'Unknown'}
                role={staffMember?.role}
                allocation={assignment.allocation}
                phaseType={phase.name}
                phaseColor={phase.color}
                depth={depth + 1}
              />
            );
          })}

          {/* Phase-level equipment assignments - filtered by showAssignments */}
          {showAssignments && (phase.equipmentAssignments ?? []).map((assignment) => {
            const equip = equipment.find((e) => e.id === assignment.equipment_id);
            return (
              <AssignmentRow
                key={`equip-${assignment.id}`}
                type="equipment"
                assignmentId={assignment.id}
                projectId={projectId}
                phaseId={phase.id}
                equipmentId={assignment.equipment_id}
                name={equip?.name || assignment.equipment_name || 'Unknown'}
                equipmentType={equip?.type}
                depth={depth + 1}
              />
            );
          })}
        </>
      )}
      
      {/* Completion Slider Popup */}
      {showSlider && (
        <CompletionSlider
          value={phase.completion ?? null}
          onClose={() => setSliderAnchor(null)}
          anchorEl={sliderAnchor}
          onChange={handleCompletionChange}
        />
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
  depth,
  customColumns,
  nameColumnWidth,
  criticalPathItems,
}: { 
  subphases: Subphase[]; 
  phaseId: number; 
  projectId: number; 
  depth: number;
  customColumns: CustomColumn[];
  nameColumnWidth: number;
  criticalPathItems: Set<string>;
}) {
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  const customColumnFilters = useAppStore((s) => s.customColumnFilters);
  const customColumnValues = useAppStore((s) => s.customColumnValues);
  const { completePhantom, cancelPhantom } = usePhantomSibling();
  
  // Check if phantom mode is for a subphase under this phase
  const showPhantomAfter = phantomSiblingMode?.type === 'subphase' && 
    phantomSiblingMode.projectId === projectId &&
    phantomSiblingMode.parentType === 'phase' &&
    phantomSiblingMode.parentId === phaseId
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
  const anyDescendantMatches = useCallback((children: Subphase[]): boolean => {
    for (const sp of children) {
      if (entityPassesFilters('subphase', sp.id)) return true;
      if (sp.children && sp.children.length > 0) {
        if (anyDescendantMatches(sp.children)) return true;
      }
    }
    return false;
  }, [entityPassesFilters]);
  
  // Filter subphases: show if subphase matches OR any descendant matches
  const visibleSubphases = useMemo(() => 
    subphases.filter(sp => 
      entityPassesFilters('subphase', sp.id) || 
      anyDescendantMatches(sp.children ?? [])
    ),
    [subphases, entityPassesFilters, anyDescendantMatches]
  );
  
  return (
    <>
      {visibleSubphases.map((subphase) => (
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
            customColumns={customColumns}
            nameColumnWidth={nameColumnWidth}
            criticalPathItems={criticalPathItems}
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
