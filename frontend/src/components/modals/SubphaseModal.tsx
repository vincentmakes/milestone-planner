/**
 * SubphaseModal - Create/Edit Subphase Modal
 * Supports subphase creation, editing, milestone mode
 * Can create under a phase or under another subphase
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { Modal } from '@/components/common/Modal';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { createSubphase, createChildSubphase, updateSubphase, deleteSubphase, loadAllProjects, updatePhase, updateProject } from '@/api/endpoints/projects';
import { useWhatIfStore } from '@/stores/whatIfStore';
import {
  toInputDateFormat,
  parseLocalDate,
  formatLocalDate,
  formatDateISO,
  addDaysToDateString,
  daysBetweenDateStrings,
} from '@/utils/date';
import { getDepthColor } from '@/utils/themeColors';
import {
  patchPhaseLocally,
  patchSubphaseLocally,
  removeSubphaseLocally,
  updateProjectLocally,
} from '@/utils/localProjectTree';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import type { Phase, Subphase, Project, CreateSubphaseRequest } from '@/types';
import { findSubphaseById, findPhaseContainingSubphase } from '@/utils/subphaseUtils';
import styles from './PhaseModal.module.css'; // Reuse phase modal styles

// Calculate the depth of a subphase (1-based)
function getSubphaseDepth(phases: Phase[], subphaseId: number): number {
  for (const phase of phases) {
    const depth = findSubphaseDepthInChildren(phase.children || [], subphaseId, 1);
    if (depth !== null) return depth;
  }
  return 1;
}

function findSubphaseDepthInChildren(children: Subphase[], targetId: number, currentDepth: number): number | null {
  for (const child of children) {
    if (child.id === targetId) return currentDepth;
    if (child.children && child.children.length > 0) {
      const depth = findSubphaseDepthInChildren(child.children, targetId, currentDepth + 1);
      if (depth !== null) return depth;
    }
  }
  return null;
}

// Calculate the date range that encompasses all children of a phase
function calculatePhaseDateRange(phase: Phase): { start: Date; end: Date } | null {
  const children = phase.children || [];
  if (children.length === 0) return null;
  
  let minStart: Date | null = null;
  let maxEnd: Date | null = null;
  
  const processSubphases = (subphases: Subphase[]) => {
    for (const sub of subphases) {
      const start = parseLocalDate(sub.start_date);
      const end = parseLocalDate(sub.end_date);
      
      if (!minStart || start < minStart) minStart = start;
      if (!maxEnd || end > maxEnd) maxEnd = end;
      
      if (sub.children && sub.children.length > 0) {
        processSubphases(sub.children);
      }
    }
  };
  
  processSubphases(children);
  
  if (minStart && maxEnd) {
    return { start: minStart, end: maxEnd };
  }
  return null;
}

// Calculate the date range that encompasses all phases of a project
function calculateProjectDateRange(project: Project): { start: Date; end: Date } | null {
  const phases = project.phases || [];
  if (phases.length === 0) return null;
  
  let minStart: Date | null = null;
  let maxEnd: Date | null = null;
  
  for (const phase of phases) {
    const start = parseLocalDate(phase.start_date);
    const end = parseLocalDate(phase.end_date);
    
    if (!minStart || start < minStart) minStart = start;
    if (!maxEnd || end > maxEnd) maxEnd = end;
  }
  
  if (minStart && maxEnd) {
    return { start: minStart, end: maxEnd };
  }
  return null;
}

// Cascade dates upward: expand parents if child extends beyond, or shrink if child deleted
interface CascadeResult {
  subphasesUpdated: number;
  phaseUpdated: boolean;
  projectUpdated: boolean;
}

// Calculate the date range that encompasses all children of a subphase
function calculateSubphaseDateRange(subphase: Subphase): { start: Date; end: Date } | null {
  const children = subphase.children || [];
  if (children.length === 0) return null;
  
  let minStart: Date | null = null;
  let maxEnd: Date | null = null;
  
  const processChildren = (subs: Subphase[]) => {
    for (const sub of subs) {
      const start = parseLocalDate(sub.start_date);
      const end = parseLocalDate(sub.end_date);
      
      if (!minStart || start < minStart) minStart = start;
      if (!maxEnd || end > maxEnd) maxEnd = end;
      
      if (sub.children && sub.children.length > 0) {
        processChildren(sub.children);
      }
    }
  };
  
  processChildren(children);
  
  if (minStart && maxEnd) {
    return { start: minStart, end: maxEnd };
  }
  return null;
}

// Find the chain of parent subphases from a given subphase up to the phase
function findParentSubphaseChain(phases: Phase[], subphaseId: number): Subphase[] {
  const chain: Subphase[] = [];
  
  // Find the subphase first
  const subphase = findSubphaseById(phases, subphaseId);
  if (!subphase) return chain;
  
  // Walk up the parent chain
  let current: Subphase | null = subphase;
  while (current) {
    if (current.parent_subphase_id) {
      const parent = findSubphaseById(phases, current.parent_subphase_id);
      if (parent) {
        chain.push(parent);
        current = parent;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  
  return chain; // Returns parents from immediate to root (closest first)
}

async function cascadeDatesUpward(
  sourceProject: Project,
  phaseId: number,
  mode: 'expand' | 'shrink',
  newChildStart?: Date,
  newChildEnd?: Date,
  parentSubphaseId?: number // The immediate parent subphase (if any)
): Promise<CascadeResult> {
  const result: CascadeResult = { subphasesUpdated: 0, phaseUpdated: false, projectUpdated: false };
  // Work on a copy: the walk below updates parent dates in place as it goes,
  // and `project` may be the live store object.
  const project = structuredClone(sourceProject);
  const phase = project.phases?.find(p => p.id === phaseId);
  if (!phase) return result;
  
  // Project must have dates
  if (!project.start_date || !project.end_date) return result;
  
  // Track the current bounds as we cascade up
  let currentStart = newChildStart;
  let currentEnd = newChildEnd;
  
  // First, cascade through parent subphases (if any)
  if (parentSubphaseId) {
    const parentChain = findParentSubphaseChain(project.phases || [], parentSubphaseId);
    // Add the immediate parent to the front of the chain
    const immediateParent = findSubphaseById(project.phases || [], parentSubphaseId);
    if (immediateParent) {
      parentChain.unshift(immediateParent);
    }
    
    // Process each parent subphase from closest to furthest
    for (const parentSubphase of parentChain) {
      const subStart = parseLocalDate(parentSubphase.start_date);
      const subEnd = parseLocalDate(parentSubphase.end_date);
      
      let updatedStart = subStart;
      let updatedEnd = subEnd;
      
      if (mode === 'expand' && currentStart && currentEnd) {
        // Expand if child extends beyond
        if (currentStart < subStart) updatedStart = currentStart;
        if (currentEnd > subEnd) updatedEnd = currentEnd;
      } else if (mode === 'shrink') {
        // Recalculate bounds from remaining children
        const childRange = calculateSubphaseDateRange(parentSubphase);
        if (childRange) {
          updatedStart = childRange.start;
          updatedEnd = childRange.end;
        }
      }
      
      // Update subphase if dates changed
      if (updatedStart.getTime() !== subStart.getTime() || 
          updatedEnd.getTime() !== subEnd.getTime()) {
        const dates = { start_date: formatLocalDate(updatedStart), end_date: formatLocalDate(updatedEnd) };
        await updateSubphase(parentSubphase.id, dates);
        patchSubphaseLocally(project.id, parentSubphase.id, dates);
        result.subphasesUpdated++;
        
        // Update local object for next iteration
        Object.assign(parentSubphase, dates);
      }
      
      // Update current bounds for next parent
      currentStart = updatedStart;
      currentEnd = updatedEnd;
    }
  }
  
  // Now cascade to phase
  const phaseStart = parseLocalDate(phase.start_date);
  const phaseEnd = parseLocalDate(phase.end_date);
  
  let updatedPhaseStart = phaseStart;
  let updatedPhaseEnd = phaseEnd;
  
  if (mode === 'expand' && currentStart && currentEnd) {
    // Expand phase if child extends beyond
    if (currentStart < phaseStart) updatedPhaseStart = currentStart;
    if (currentEnd > phaseEnd) updatedPhaseEnd = currentEnd;
  } else if (mode === 'shrink') {
    // Recalculate phase bounds from remaining children
    const childRange = calculatePhaseDateRange(phase);
    if (childRange) {
      updatedPhaseStart = childRange.start;
      updatedPhaseEnd = childRange.end;
    }
  }
  
  // Update phase if dates changed
  if (updatedPhaseStart.getTime() !== phaseStart.getTime() || 
      updatedPhaseEnd.getTime() !== phaseEnd.getTime()) {
    const dates = { start_date: formatLocalDate(updatedPhaseStart), end_date: formatLocalDate(updatedPhaseEnd) };
    await updatePhase(phaseId, dates);
    patchPhaseLocally(project.id, phaseId, dates);
    result.phaseUpdated = true;
    
    // Update local phase object for project cascade calculation
    Object.assign(phase, dates);
  }
  
  // Now cascade to project
  const projectStart = parseLocalDate(project.start_date);
  const projectEnd = parseLocalDate(project.end_date);
  
  let updatedProjectStart = projectStart;
  let updatedProjectEnd = projectEnd;
  
  if (mode === 'expand') {
    // Expand project if phase extends beyond
    if (updatedPhaseStart < projectStart) updatedProjectStart = updatedPhaseStart;
    if (updatedPhaseEnd > projectEnd) updatedProjectEnd = updatedPhaseEnd;
  } else if (mode === 'shrink') {
    // Recalculate project bounds from all phases
    const projectRange = calculateProjectDateRange(project);
    if (projectRange) {
      updatedProjectStart = projectRange.start;
      updatedProjectEnd = projectRange.end;
    }
  }
  
  // Update project if dates changed
  if (updatedProjectStart.getTime() !== projectStart.getTime() || 
      updatedProjectEnd.getTime() !== projectEnd.getTime()) {
    const dates = { start_date: formatLocalDate(updatedProjectStart), end_date: formatLocalDate(updatedProjectEnd) };
    await updateProject(project.id, dates);
    updateProjectLocally(project.id, (p) => Object.assign(p, dates));
    result.projectUpdated = true;
  }
  
  return result;
}

export function SubphaseModal() {
  const { activeModal, editingSubphase, modalContext, closeModal } = useUIStore();
  const projects = useAppStore((s) => s.projects);
  const setProjects = useAppStore((s) => s.setProjects);
  const { ensurePhaseExpanded, ensureSubphaseExpanded } = useViewStore();
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  
  const isOpen = activeModal === 'subphase';
  const isEditing = !!editingSubphase;
  // Creating inside What-If cannot show the new subphase until Apply; edits are fine.
  const createBlockedReason = !isEditing && whatIfMode ? whatIfUnavailableMessage('Adding subphases') : null;
  const projectId = modalContext.projectId;
  const phaseId = editingSubphase?.parent_phase_id || modalContext.phaseId;
  const parentSubphaseId = modalContext.subphaseId; // For creating nested subphases
  
  // Form state
  const [name, setName] = useState('');
  const [isMilestone, setIsMilestone] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  
  // Get parent phase for date constraints
  const project = useMemo(() => {
    if (!projectId) return null;
    return projects.find(p => p.id === projectId) || null;
  }, [projects, projectId]);
  
  const parentPhase = useMemo(() => {
    if (!project || !phaseId) return null;
    return project.phases?.find(ph => ph.id === phaseId) || null;
  }, [project, phaseId]);
  
  // Initialize form when modal opens -- once per open. `parentPhase` is
  // derived from `projects`, which a WebSocket refetch replaces with new
  // objects; without the guard a colleague's edit would wipe what the user
  // has typed. The key changes when the dialog is reopened on another
  // subphase / parent.
  const initializedForRef = useRef<string | null>(null);
  const phantomPreset = modalContext.phantomPreset;
  const initKey = `${isEditing ? 'edit' : 'new'}:${editingSubphase?.id ?? 'new'}:${projectId ?? ''}:${phaseId ?? ''}:${parentSubphaseId ?? ''}:${phantomPreset ? `${phantomPreset.startDate}:${phantomPreset.endDate}` : ''}`;
  useEffect(() => {
    if (!isOpen) {
      initializedForRef.current = null;
      return;
    }
    if (initializedForRef.current === initKey) return;
    initializedForRef.current = initKey;
    if (editingSubphase) {
      // Editing mode - convert ISO datetime to input format
      setName(editingSubphase.name);
      // Handle both boolean true and integer 1 from SQLite
      setIsMilestone(Boolean(editingSubphase.is_milestone));
      setStartDate(toInputDateFormat(editingSubphase.start_date));
      setEndDate(toInputDateFormat(editingSubphase.end_date));
    } else if (modalContext.phantomPreset) {
      // Phantom sibling mode - use preset dates
      setName('');
      setIsMilestone(false);
      setStartDate(toInputDateFormat(modalContext.phantomPreset.startDate));
      setEndDate(toInputDateFormat(modalContext.phantomPreset.endDate));
    } else {
      // New subphase mode - use parent phase dates as default
      const today = formatDateISO(new Date());
      const defaultStart = toInputDateFormat(parentPhase?.start_date) || today;
      const defaultEnd = toInputDateFormat(parentPhase?.end_date) || today;

      setName('');
      setIsMilestone(false);
      setStartDate(defaultStart);
      setEndDate(defaultEnd);
    }
    setError(null);
  }, [isOpen, initKey, editingSubphase, parentPhase, modalContext.phantomPreset]);
  
  // Sync end date with start date for milestones
  useEffect(() => {
    if (isMilestone && startDate) {
      setEndDate(startDate);
    }
  }, [isMilestone, startDate]);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (createBlockedReason) {
      setError(createBlockedReason);
      return;
    }
    
    if (!name.trim()) {
      setError('Please enter a subphase name');
      return;
    }
    
    if (!startDate) {
      setError('Please select a start date');
      return;
    }
    
    if (!isMilestone && !endDate) {
      setError('Please select an end date');
      return;
    }
    
    if (!phaseId) {
      setError('No parent phase selected');
      return;
    }
    
    if (!beginSubmit()) return;
    setError(null);
    
    try {
      // Calculate the appropriate color based on depth
      let subphaseColor: string;
      if (editingSubphase?.color) {
        // Keep existing color when editing
        subphaseColor = editingSubphase.color;
      } else if (parentSubphaseId && project) {
        // Creating under a subphase - depth is parent's depth + 1
        const parentDepth = getSubphaseDepth(project.phases || [], parentSubphaseId);
        subphaseColor = getDepthColor(parentDepth + 1);
      } else {
        // Creating directly under a phase - depth 1
        subphaseColor = getDepthColor(1);
      }
      
      // Build subphase data
      const subphaseData: CreateSubphaseRequest = {
        name: name.trim(),
        start_date: startDate,
        end_date: isMilestone ? startDate : endDate,
        is_milestone: isMilestone,
        color: subphaseColor,
      };
      
      // If this was created via phantom sibling mode, add dependency and order
      if (modalContext.phantomPreset) {
        const { predecessorId, dependencyType } = modalContext.phantomPreset;
        
        // Find the source subphase to calculate lag
        const project = projects.find(p => p.id === projectId);
        const sourceSubphase = findSubphaseById(project?.phases || [], predecessorId);
        
        if (sourceSubphase) {
          // Calculate lag based on dependency type
          let lag = 0;
          if (dependencyType === 'SS') {
            // Start-to-Start: lag = new start - source start
            lag = daysBetweenDateStrings(sourceSubphase.start_date, startDate);
          } else {
            // Finish-to-Start: lag = new start - (source end + 1)
            lag = daysBetweenDateStrings(addDaysToDateString(sourceSubphase.end_date, 1), startDate);
          }
          
          subphaseData.dependencies = [{
            id: predecessorId,
            type: dependencyType,
            lag,
            entity: 'subphase',
          }];
          
          // Use the source subphase's order_index + 1 to insert after it
          const sourceSortOrder = sourceSubphase.order_index ?? 0;
          subphaseData.order_index = sourceSortOrder + 1;
        }
      }
      
      // Track if we need to cascade parent phase dates
      let cascadePhaseId: number | null = null;
      let cascadeParentSubphaseId: number | undefined = undefined;
      
      if (isEditing && editingSubphase) {
        await updateSubphase(editingSubphase.id, subphaseData);
        // Show the edit right away (the reload below is a no-op in What-If).
        if (projectId) {
          patchSubphaseLocally(projectId, editingSubphase.id, {
            name: subphaseData.name,
            start_date: subphaseData.start_date,
            end_date: subphaseData.end_date,
            is_milestone: subphaseData.is_milestone,
          });
        }
      } else if (parentSubphaseId && projectId) {
        // Creating nested subphase under another subphase
        await createChildSubphase(parentSubphaseId, projectId, subphaseData);
        // Expand parent subphase so new child is visible
        ensureSubphaseExpanded(parentSubphaseId);
        // For nested subphases, cascade through parent subphases to phase to project
        cascadePhaseId = phaseId || null;
        cascadeParentSubphaseId = parentSubphaseId;
      } else if (phaseId && projectId) {
        // Creating subphase directly under a phase
        await createSubphase(phaseId, projectId, subphaseData);
        // Expand parent phase so new subphase is visible
        ensurePhaseExpanded(phaseId);
        cascadePhaseId = phaseId;
        // No parent subphase - direct child of phase
      } else {
        throw new Error('Missing phaseId or projectId');
      }
      
      // Cascade parent dates if the new subphase extends beyond bounds
      if (cascadePhaseId && !isEditing && project) {
        const newSubphaseStart = parseLocalDate(subphaseData.start_date);
        const newSubphaseEnd = parseLocalDate(subphaseData.end_date);
        
        await cascadeDatesUpward(
          project,
          cascadePhaseId,
          'expand',
          newSubphaseStart,
          newSubphaseEnd,
          cascadeParentSubphaseId
        );
      }
      
      // Reload projects
      const updatedProjects = await loadAllProjects();
      setProjects(updatedProjects);
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save subphase');
    } finally {
      endSubmit();
    }
  };
  
  const handleDelete = async () => {
    if (!isEditing || !editingSubphase) return;
    
    if (!confirm('Are you sure you want to delete this subphase? This will also delete all nested subphases and assignments.')) {
      return;
    }
    
    if (!beginSubmit()) return;
    setError(null);
    
    try {
      // Find the phase containing this subphase before deletion
      const containingPhase = project ? findPhaseContainingSubphase(project.phases || [], editingSubphase.id) : null;
      // Get the parent subphase ID (if this was a nested subphase)
      const parentSubphaseIdForCascade = editingSubphase.parent_subphase_id || undefined;
      
      await deleteSubphase(editingSubphase.id);
      if (project) removeSubphaseLocally(project.id, editingSubphase.id);
      
      // Reload projects to get updated structure
      const updatedProjects = await loadAllProjects();
      
      // Cascade shrink dates after deletion
      if (containingPhase && project) {
        // Find the updated project
        const updatedProject = updatedProjects.find(p => p.id === project.id);
        if (updatedProject) {
          await cascadeDatesUpward(
            updatedProject, 
            containingPhase.id, 
            'shrink',
            undefined,
            undefined,
            parentSubphaseIdForCascade
          );
          // Reload again to get the cascaded dates
          const finalProjects = await loadAllProjects();
          setProjects(finalProjects);
        } else {
          setProjects(updatedProjects);
        }
      } else {
        setProjects(updatedProjects);
      }
      
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete subphase');
    } finally {
      endSubmit();
    }
  };
  
  const footer = (
    <div className={styles.footer}>
      {isEditing && (
        <Button 
          variant="danger" 
          onClick={handleDelete} 
          disabled={isSubmitting}
          className={styles.deleteBtn}
        >
          Delete Subphase
        </Button>
      )}
      <div className={styles.footerRight}>
        <Button variant="secondary" onClick={closeModal} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={isSubmitting || !!createBlockedReason}
          title={createBlockedReason ?? undefined}
          loading={isSubmitting}
        >
          {isEditing ? 'Save Changes' : 'Add Subphase'}
        </Button>
      </div>
    </div>
  );
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title={isEditing ? 'Edit Subphase' : 'Add Subphase'}
      size="md"
      footer={footer}
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        {createBlockedReason && (
          <div className={styles.error} role="status">{createBlockedReason}</div>
        )}
        {error && error !== createBlockedReason && <div className={styles.error}>{error}</div>}
        
        {parentPhase && (
          <div className={styles.contextInfo}>
            Parent: <strong>{parentPhase.name}</strong>
          </div>
        )}
        
        <Input
          label="Subphase Name *"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Task 1, Setup, Review, etc."
          autoFocus
          fullWidth
        />
        
        <div className={styles.formGroup}>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={isMilestone}
              onChange={(e) => setIsMilestone(e.target.checked)}
            />
            <span>Milestone (single date, shown as diamond)</span>
          </label>
        </div>
        
        <div className={styles.formRow}>
          <Input
            label={isMilestone ? 'Date *' : 'Start Date *'}
            type="date"
            className={styles.field}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
          {!isMilestone && (
            <Input
              label="End Date *"
              type="date"
              className={styles.field}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          )}
        </div>
      </form>
    </Modal>
  );
}
