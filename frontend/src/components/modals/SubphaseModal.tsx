/**
 * SubphaseModal - Create/Edit Subphase Modal
 * Supports subphase creation, editing, milestone mode
 * Can create under a phase or under another subphase
 */

import { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { createSubphase, createChildSubphase, updateSubphase, deleteSubphase, loadAllProjects, updatePhase, updateProject } from '@/api/endpoints/projects';
import { toInputDateFormat } from '@/utils/date';
import { getDepthColor } from '@/utils/themeColors';
import type { Phase, Subphase, Project, CreateSubphaseRequest } from '@/types';
import styles from './PhaseModal.module.css'; // Reuse phase modal styles

// Helper to find subphase by ID in nested structure
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

// Find the phase that contains a subphase
function findPhaseContainingSubphase(phases: Phase[], subphaseId: number): Phase | null {
  for (const phase of phases) {
    const found = findSubphaseInChildren(phase.children || [], subphaseId);
    if (found) return phase;
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
      const start = new Date(sub.start_date);
      const end = new Date(sub.end_date);
      
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
    const start = new Date(phase.start_date);
    const end = new Date(phase.end_date);
    
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
      const start = new Date(sub.start_date);
      const end = new Date(sub.end_date);
      
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
  project: Project,
  phaseId: number,
  mode: 'expand' | 'shrink',
  newChildStart?: Date,
  newChildEnd?: Date,
  parentSubphaseId?: number // The immediate parent subphase (if any)
): Promise<CascadeResult> {
  const result: CascadeResult = { subphasesUpdated: 0, phaseUpdated: false, projectUpdated: false };
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
      const subStart = new Date(parentSubphase.start_date);
      const subEnd = new Date(parentSubphase.end_date);
      
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
        console.log('[Cascade] Updating parent subphase dates:', {
          subphaseId: parentSubphase.id,
          name: parentSubphase.name,
          oldStart: parentSubphase.start_date,
          oldEnd: parentSubphase.end_date,
          newStart: updatedStart.toISOString().split('T')[0],
          newEnd: updatedEnd.toISOString().split('T')[0],
        });
        await updateSubphase(parentSubphase.id, {
          start_date: updatedStart.toISOString().split('T')[0],
          end_date: updatedEnd.toISOString().split('T')[0],
        });
        result.subphasesUpdated++;
        
        // Update local object for next iteration
        parentSubphase.start_date = updatedStart.toISOString().split('T')[0];
        parentSubphase.end_date = updatedEnd.toISOString().split('T')[0];
      }
      
      // Update current bounds for next parent
      currentStart = updatedStart;
      currentEnd = updatedEnd;
    }
  }
  
  // Now cascade to phase
  const phaseStart = new Date(phase.start_date);
  const phaseEnd = new Date(phase.end_date);
  
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
    console.log('[Cascade] Updating phase dates:', {
      phaseId,
      oldStart: phase.start_date,
      oldEnd: phase.end_date,
      newStart: updatedPhaseStart.toISOString().split('T')[0],
      newEnd: updatedPhaseEnd.toISOString().split('T')[0],
    });
    await updatePhase(phaseId, {
      start_date: updatedPhaseStart.toISOString().split('T')[0],
      end_date: updatedPhaseEnd.toISOString().split('T')[0],
    });
    result.phaseUpdated = true;
    
    // Update local phase object for project cascade calculation
    phase.start_date = updatedPhaseStart.toISOString().split('T')[0];
    phase.end_date = updatedPhaseEnd.toISOString().split('T')[0];
  }
  
  // Now cascade to project
  const projectStart = new Date(project.start_date);
  const projectEnd = new Date(project.end_date);
  
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
    console.log('[Cascade] Updating project dates:', {
      projectId: project.id,
      oldStart: project.start_date,
      oldEnd: project.end_date,
      newStart: updatedProjectStart.toISOString().split('T')[0],
      newEnd: updatedProjectEnd.toISOString().split('T')[0],
    });
    await updateProject(project.id, {
      start_date: updatedProjectStart.toISOString().split('T')[0],
      end_date: updatedProjectEnd.toISOString().split('T')[0],
    });
    result.projectUpdated = true;
  }
  
  return result;
}

export function SubphaseModal() {
  const { activeModal, editingSubphase, modalContext, closeModal } = useUIStore();
  const { projects, setProjects, ensurePhaseExpanded, ensureSubphaseExpanded } = useAppStore();
  
  const isOpen = activeModal === 'subphase';
  const isEditing = !!editingSubphase;
  const projectId = modalContext.projectId;
  const phaseId = editingSubphase?.parent_phase_id || modalContext.phaseId;
  const parentSubphaseId = modalContext.subphaseId; // For creating nested subphases
  
  // Form state
  const [name, setName] = useState('');
  const [isMilestone, setIsMilestone] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
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
  
  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen) {
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
        const today = new Date().toISOString().split('T')[0];
        const defaultStart = toInputDateFormat(parentPhase?.start_date) || today;
        const defaultEnd = toInputDateFormat(parentPhase?.end_date) || today;
        
        setName('');
        setIsMilestone(false);
        setStartDate(defaultStart);
        setEndDate(defaultEnd);
      }
      setError(null);
    }
  }, [isOpen, editingSubphase, parentPhase, modalContext.phantomPreset]);
  
  // Sync end date with start date for milestones
  useEffect(() => {
    if (isMilestone && startDate) {
      setEndDate(startDate);
    }
  }, [isMilestone, startDate]);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
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
    
    setIsSubmitting(true);
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
          const newStart = new Date(startDate);
          const sourceStart = new Date(sourceSubphase.start_date.split('T')[0]);
          const sourceEnd = new Date(sourceSubphase.end_date.split('T')[0]);
          
          if (dependencyType === 'SS') {
            // Start-to-Start: lag = new start - source start
            lag = Math.round((newStart.getTime() - sourceStart.getTime()) / (1000 * 60 * 60 * 24));
          } else {
            // Finish-to-Start: lag = new start - (source end + 1)
            const expectedStart = new Date(sourceEnd);
            expectedStart.setDate(expectedStart.getDate() + 1);
            lag = Math.round((newStart.getTime() - expectedStart.getTime()) / (1000 * 60 * 60 * 24));
          }
          
          subphaseData.dependencies = [{
            id: predecessorId,
            type: dependencyType,
            lag,
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
        const newSubphaseStart = new Date(subphaseData.start_date);
        const newSubphaseEnd = new Date(subphaseData.end_date);
        
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
      setIsSubmitting(false);
    }
  };
  
  const handleDelete = async () => {
    if (!isEditing || !editingSubphase) return;
    
    if (!confirm('Are you sure you want to delete this subphase? This will also delete all nested subphases and assignments.')) {
      return;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      // Find the phase containing this subphase before deletion
      const containingPhase = project ? findPhaseContainingSubphase(project.phases || [], editingSubphase.id) : null;
      // Get the parent subphase ID (if this was a nested subphase)
      const parentSubphaseIdForCascade = editingSubphase.parent_subphase_id || undefined;
      
      await deleteSubphase(editingSubphase.id);
      
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
      setIsSubmitting(false);
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
        <Button variant="primary" onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Subphase'}
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
        {error && <div className={styles.error}>{error}</div>}
        
        {parentPhase && (
          <div className={styles.contextInfo}>
            Parent: <strong>{parentPhase.name}</strong>
          </div>
        )}
        
        <div className={styles.formGroup}>
          <label className={styles.label}>Subphase Name *</label>
          <input
            type="text"
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Task 1, Setup, Review, etc."
            autoFocus
          />
        </div>
        
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
          <div className={styles.formGroup}>
            <label className={styles.label}>{isMilestone ? 'Date *' : 'Start Date *'}</label>
            <input
              type="date"
              className={styles.input}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          {!isMilestone && (
            <div className={styles.formGroup}>
              <label className={styles.label}>End Date *</label>
              <input
                type="date"
                className={styles.input}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
