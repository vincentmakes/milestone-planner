/**
 * SubphaseRow
 * A subphase row within a phase with WBS level indicator
 * Supports drag-and-drop reordering
 */

import { memo, useMemo, useCallback, useState, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { useUIStore } from '@/stores/uiStore';
import { useReorder } from '@/contexts/ReorderContext';
import { AssignmentRow } from './AssignmentRow';
import { PhantomRow } from './PhantomRow';
import { usePhantomSibling } from '@/hooks';
import { CompletionSlider } from '@/components/gantt/CompletionSlider';
import { CustomColumnCell } from '@/components/gantt/CustomColumns';
import { updateSubphase } from '@/api/endpoints/projects';
import { formatShortDateRange, formatSingleDate } from '@/utils/date';
import type { Subphase, CustomColumn, CustomColumnEntityType } from '@/types';
import styles from './SubphaseRow.module.css';

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

interface SubphaseRowProps {
  subphase: Subphase;
  phaseId: number;
  projectId: number;
  depth: number;
  wbsLevel?: number; // WBS level for display (defaults to 1 for first subphase)
  siblings: Subphase[];  // Sibling subphases for reorder context
  parentId: number;      // Parent ID (phase or subphase)
  parentType: 'phase' | 'subphase';
  customColumns?: CustomColumn[];
  nameColumnWidth: number;
  criticalPathItems?: Set<string>;  // Critical path items for this project
}

// Recursively calculate effective completion for an item
// If at least one child has a completion value, unset siblings count as 0%
function getEffectiveCompletion(item: Subphase): { completion: number | null; isCalculated: boolean } {
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

export const SubphaseRow = memo(function SubphaseRow({
  subphase,
  phaseId,
  projectId,
  depth,
  wbsLevel = 1, // Default to L1 for first subphase
  siblings,
  parentId,
  parentType,
  customColumns = [],
  nameColumnWidth,
  criticalPathItems = new Set(),
}: SubphaseRowProps) {
  const expandedSubphases = useViewStore((s) => s.expandedSubphases);
  const toggleSubphaseExpanded = useViewStore((s) => s.toggleSubphaseExpanded);
  const staff = useAppStore((s) => s.staff);
  const equipment = useAppStore((s) => s.equipment);
  const currentUser = useAppStore((s) => s.currentUser);
  const showAssignments = useViewStore((s) => s.showAssignments);
  const openSubphaseModal = useUIStore((s) => s.openSubphaseModal);
  const triggerScrollToDate = useUIStore((s) => s.triggerScrollToDate);
  const projects = useAppStore((s) => s.projects);
  const setProjects = useAppStore((s) => s.setProjects);
  
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

  const isExpanded = expandedSubphases.has(subphase.id);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleSubphaseExpanded(subphase.id);
  };

  const handleEdit = () => {
    openSubphaseModal(subphase, phaseId, projectId);
  };

  // Handle clicking on the level indicator to scroll to start date
  const handleLevelClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    triggerScrollToDate(subphase.start_date);
  }, [subphase.start_date, triggerScrollToDate]);

  // Handle clicking on completion badge to show slider
  const handleCompletionClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // Don't show slider if calculated from children
    const result = getEffectiveCompletion(subphase);
    if (result.isCalculated) return;
    setSliderAnchor(e.currentTarget as HTMLElement);
  }, [subphase]);

  // Helper to update subphase in project tree
  const updateSubphaseInTree = useCallback((subphases: Subphase[], targetId: number, newCompletion: number | null): Subphase[] => {
    return subphases.map(sp => {
      if (sp.id === targetId) {
        return { ...sp, completion: newCompletion };
      }
      if (sp.children && sp.children.length > 0) {
        return { ...sp, children: updateSubphaseInTree(sp.children, targetId, newCompletion) };
      }
      return sp;
    });
  }, []);

  // Handle completion change from slider
  const handleCompletionChange = useCallback(async (value: number) => {
    try {
      const newCompletion = value === -1 ? null : value;
      await updateSubphase(subphase.id, { completion: newCompletion });
      
      // Update local state optimistically
      const updatedProjects = projects.map(p => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          phases: p.phases?.map(ph => {
            if (ph.id !== phaseId) return ph;
            return {
              ...ph,
              children: updateSubphaseInTree(ph.children || [], subphase.id, newCompletion)
            };
          })
        };
      });
      setProjects(updatedProjects);
    } catch (err) {
      console.error('Failed to update completion:', err);
    }
  }, [subphase.id, projectId, phaseId, projects, setProjects, updateSubphaseInTree]);

  const hasChildren =
    (subphase.children?.length ?? 0) > 0 ||
    (subphase.staffAssignments?.length ?? 0) > 0 ||
    (subphase.equipmentAssignments?.length ?? 0) > 0;

  const paddingLeft = depth * 16 + 8;

  // Format date display using browser locale
  const dateDisplay = useMemo(() => {
    if (subphase.is_milestone) {
      return formatSingleDate(subphase.start_date);
    }
    return formatShortDateRange(subphase.start_date, subphase.end_date);
  }, [subphase.start_date, subphase.end_date, subphase.is_milestone]);

  // Get effective completion (calculated from children or manual)
  const completionResult = useMemo(() => getEffectiveCompletion(subphase), [subphase]);

  // Collect all descendant subphases for cascading custom column values
  const childEntities = useMemo(() => collectAllDescendants(subphase.children ?? []), [subphase.children]);

  const showContextMenu = useUIStore((s) => s.showContextMenu);
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    showContextMenu('subphase', subphase.id, e.clientX, e.clientY, projectId, phaseId);
  }, [showContextMenu, subphase.id, projectId, phaseId]);

  // Drag handlers
  const onDragStart = useCallback((e: React.DragEvent) => {
    handleDragStart(e, 'subphase', subphase.id, projectId, parentId, parentType);
  }, [handleDragStart, subphase.id, projectId, parentId, parentType]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    handleDragOver(e, 'subphase', subphase.id);
  }, [handleDragOver, subphase.id]);

  const onDrop = useCallback((e: React.DragEvent) => {
    handleDrop(e, 'subphase', subphase.id, siblings, parentId, parentType);
  }, [handleDrop, subphase.id, siblings, parentId, parentType]);

  const dragging = isDragging('subphase', subphase.id);
  const dropPosition = getDropPosition('subphase', subphase.id);

  return (
    <>
      {/* Subphase row */}
      <div
        className={`${styles.row} ${dragging ? styles.dragging : ''} ${dropPosition ? styles[`drop${dropPosition.charAt(0).toUpperCase() + dropPosition.slice(1)}`] : ''}`}
        data-subphase-id={subphase.id}
        onDragOver={onDragOver}
        onDragLeave={handleDragLeave}
        onDrop={onDrop}
        onDoubleClick={handleEdit}
        onContextMenu={handleContextMenu}
      >
        {/* Name column - fixed width */}
        <div className={styles.nameColumn} style={{ width: nameColumnWidth, paddingLeft }}>
          {/* Critical path indicator */}
          {criticalPathItems.has(`subphase-${subphase.id}`) && (
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

          {/* Completion badge - always shown */}
          <button 
            className={`${styles.completionBadge} ${
              completionResult.completion !== null 
                ? (completionResult.isCalculated ? styles.calculated : styles.manual)
                : styles.empty
            }`}
            onClick={handleCompletionClick}
            title={
              completionResult.completion !== null
                ? (completionResult.isCalculated ? 'Calculated from children' : 'Click to edit')
                : 'Click to set completion'
            }
          >
            {completionResult.completion !== null ? `${completionResult.completion}%` : '—'}
          </button>

          {/* WBS Level indicator - clickable to scroll to start date */}
          <button
            className={styles.wbsLevel}
            style={{ backgroundColor: subphase.color }}
            onClick={handleLevelClick}
            title={`Level ${wbsLevel} - Click to scroll to start date`}
          >
            L{wbsLevel}
          </button>

          {/* Subphase name */}
          <span className={styles.name} title={subphase.name}>
            {subphase.name}
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
                  entityType="subphase"
                  entityId={subphase.id}
                  readOnly={!canEdit}
                  childEntities={childEntities}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Completion slider popover */}
      {showSlider && createPortal(
        <CompletionSlider
          value={subphase.completion ?? null}
          onChange={handleCompletionChange}
          onClose={() => setSliderAnchor(null)}
          anchorEl={sliderAnchor}
          isCalculated={completionResult.isCalculated}
        />,
        document.body
      )}

      {/* Expanded children */}
      {isExpanded && (
        <>
          {/* Nested subphases with phantom row support */}
          <SubphasesWithPhantom
            subphases={subphase.children ?? []}
            phaseId={phaseId}
            projectId={projectId}
            depth={depth + 1}
            wbsLevel={wbsLevel + 1}
            parentId={subphase.id}
            parentType="subphase"
            customColumns={customColumns}
            nameColumnWidth={nameColumnWidth}
            criticalPathItems={criticalPathItems}
          />

          {/* Subphase-level staff assignments - filtered by showAssignments */}
          {showAssignments && (subphase.staffAssignments ?? []).map((assignment) => {
            const staffMember = staff.find((s) => s.id === assignment.staff_id);
            return (
              <AssignmentRow
                key={`staff-${assignment.id}`}
                type="subphase-staff"
                assignmentId={assignment.id}
                projectId={projectId}
                phaseId={phaseId}
                subphaseId={subphase.id}
                staffId={assignment.staff_id}
                name={staffMember?.name || assignment.staff_name || 'Unknown'}
                role={staffMember?.role}
                allocation={assignment.allocation}
                phaseType={subphase.name}
                phaseColor={subphase.color}
                depth={depth + 1}
              />
            );
          })}

          {/* Subphase-level equipment assignments - filtered by showAssignments */}
          {showAssignments && (subphase.equipmentAssignments ?? []).map((assignment) => {
            const equip = equipment.find((e) => e.id === assignment.equipment_id);
            return (
              <AssignmentRow
                key={`equip-${assignment.id}`}
                type="equipment"
                assignmentId={assignment.id}
                projectId={projectId}
                phaseId={phaseId}
                subphaseId={subphase.id}
                equipmentId={assignment.equipment_id}
                name={equip?.name || assignment.equipment_name || 'Unknown'}
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
 * Helper component to render subphases with PhantomRow after source
 */
function SubphasesWithPhantom({ 
  subphases, 
  phaseId, 
  projectId, 
  depth, 
  wbsLevel,
  parentId,
  parentType,
  customColumns,
  nameColumnWidth,
  criticalPathItems,
}: { 
  subphases: Subphase[]; 
  phaseId: number; 
  projectId: number; 
  depth: number; 
  wbsLevel: number;
  parentId: number;
  parentType: 'phase' | 'subphase';
  customColumns: CustomColumn[];
  nameColumnWidth: number;
  criticalPathItems: Set<string>;
}) {
  const phantomSiblingMode = useUIStore((s) => s.phantomSiblingMode);
  const customColumnFilters = useCustomColumnStore((s) => s.customColumnFilters);
  const customColumnValues = useCustomColumnStore((s) => s.customColumnValues);
  const { completePhantom, cancelPhantom } = usePhantomSibling();
  
  // Check if phantom mode is for a subphase
  const showPhantomAfter = phantomSiblingMode?.type === 'subphase' && 
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
      {visibleSubphases.map((child) => (
        <Fragment key={child.id}>
          <SubphaseRow
            subphase={child}
            phaseId={phaseId}
            projectId={projectId}
            depth={depth}
            wbsLevel={wbsLevel}
            siblings={subphases}
            parentId={parentId}
            parentType={parentType}
            customColumns={customColumns}
            nameColumnWidth={nameColumnWidth}
            criticalPathItems={criticalPathItems}
          />
          {showPhantomAfter === child.id && (
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
