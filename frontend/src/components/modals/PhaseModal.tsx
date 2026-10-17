/**
 * PhaseModal - Create/Edit Phase Modal
 * Supports phase creation, editing, milestone mode, and staff assignments
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { Modal } from '@/components/common/Modal';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { createPhase, updatePhase, deletePhase, loadAllProjects, updateProject } from '@/api/endpoints/projects';
import { useWhatIfStore } from '@/stores/whatIfStore';
import {
  toInputDateFormat,
  parseLocalDate,
  formatLocalDate,
  formatDateISO,
  addDaysToDateString,
  daysBetweenDateStrings,
} from '@/utils/date';
import { getPhaseColor } from '@/utils/themeColors';
import { patchPhaseLocally, removePhaseLocally, updateProjectLocally } from '@/utils/localProjectTree';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import type { Dependency, Project } from '@/types';
import styles from './PhaseModal.module.css';

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

// Cascade project dates based on phases
async function cascadeProjectDates(
  project: Project,
  mode: 'expand' | 'shrink',
  newPhaseStart?: Date,
  newPhaseEnd?: Date
): Promise<boolean> {
  // Project must have dates
  if (!project.start_date || !project.end_date) return false;
  
  const projectStart = parseLocalDate(project.start_date);
  const projectEnd = parseLocalDate(project.end_date);
  
  let updatedProjectStart = projectStart;
  let updatedProjectEnd = projectEnd;
  
  if (mode === 'expand' && newPhaseStart && newPhaseEnd) {
    // Expand project if new phase extends beyond
    if (newPhaseStart < projectStart) updatedProjectStart = newPhaseStart;
    if (newPhaseEnd > projectEnd) updatedProjectEnd = newPhaseEnd;
  } else if (mode === 'shrink') {
    // Recalculate project bounds from remaining phases
    const projectRange = calculateProjectDateRange(project);
    if (projectRange) {
      updatedProjectStart = projectRange.start;
      updatedProjectEnd = projectRange.end;
    }
  }
  
  // Update project if dates changed
  if (updatedProjectStart.getTime() !== projectStart.getTime() || 
      updatedProjectEnd.getTime() !== projectEnd.getTime()) {
    const dates = {
      start_date: formatLocalDate(updatedProjectStart),
      end_date: formatLocalDate(updatedProjectEnd),
    };
    await updateProject(project.id, dates);
    // Mirror locally: during What-If the write is only queued.
    updateProjectLocally(project.id, (p) => Object.assign(p, dates));
    return true;
  }
  return false;
}

export function PhaseModal() {
  const { activeModal, editingPhase, modalContext, closeModal } = useUIStore();
  const projects = useAppStore((s) => s.projects);
  const setProjects = useAppStore((s) => s.setProjects);
  const { ensureProjectExpanded } = useViewStore();
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  
  const isOpen = activeModal === 'phase';
  const isEditing = !!editingPhase;
  // Creating inside What-If cannot show the new phase until Apply; edits are fine.
  const createBlockedReason = !isEditing && whatIfMode ? whatIfUnavailableMessage('Adding phases') : null;
  const projectId = editingPhase?.project_id || modalContext.projectId;
  
  // Form state
  const [name, setName] = useState('');
  const [isMilestone, setIsMilestone] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  
  // Get parent project for date constraints
  const project = useMemo(() => {
    return projects.find(p => p.id === projectId);
  }, [projects, projectId]);
  
  // Initialize form when modal opens -- once per open. `project` is derived
  // from `projects`, which a WebSocket refetch replaces with new objects;
  // without the guard a colleague's edit would wipe what the user has typed.
  // The key changes when the dialog is reopened on another phase / project.
  const initializedForRef = useRef<string | null>(null);
  const phantomPreset = modalContext.phantomPreset;
  const initKey = `${isEditing ? 'edit' : 'new'}:${editingPhase?.id ?? 'new'}:${projectId ?? ''}:${phantomPreset ? `${phantomPreset.startDate}:${phantomPreset.endDate}` : ''}`;
  useEffect(() => {
    if (!isOpen) {
      initializedForRef.current = null;
      return;
    }
    if (initializedForRef.current === initKey) return;
    initializedForRef.current = initKey;
    if (editingPhase) {
      // Editing mode - convert ISO datetime to input format
      setName(editingPhase.name);
      // Handle both boolean true and integer 1 from SQLite
      setIsMilestone(Boolean(editingPhase.is_milestone));
      setStartDate(toInputDateFormat(editingPhase.start_date));
      setEndDate(toInputDateFormat(editingPhase.end_date));
    } else if (modalContext.phantomPreset) {
      // Phantom sibling mode - use preset dates
      setName('');
      setIsMilestone(false);
      setStartDate(toInputDateFormat(modalContext.phantomPreset.startDate));
      setEndDate(toInputDateFormat(modalContext.phantomPreset.endDate));
    } else {
      // New phase mode - use project dates as default
      const today = formatDateISO(new Date());
      const defaultStart = toInputDateFormat(project?.start_date) || today;
      const defaultEnd = toInputDateFormat(project?.end_date) || today;
      
      setName('');
      setIsMilestone(false);
      setStartDate(defaultStart);
      setEndDate(defaultEnd);
    }
    setError(null);
  }, [isOpen, initKey, editingPhase, project, modalContext.phantomPreset]);
  
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
      setError('Please enter a phase name');
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
    
    if (!projectId) {
      setError('No project selected');
      return;
    }
    
    if (!beginSubmit()) return;
    setError(null);
    
    try {
      // Build phase data
      const phaseData: {
        name: string;
        start_date: string;
        end_date: string;
        is_milestone: boolean;
        color: string;
        dependencies?: Dependency[];
        order_index?: number;
      } = {
        name: name.trim(),
        start_date: startDate,
        end_date: isMilestone ? startDate : endDate,
        is_milestone: isMilestone,
        color: editingPhase?.color || getPhaseColor(),
      };
      
      // If this was created via phantom sibling mode, add dependency and order
      if (modalContext.phantomPreset) {
        const { predecessorId, dependencyType } = modalContext.phantomPreset;
        
        // Find the source phase to calculate lag
        const sourcePhase = project?.phases?.find(p => p.id === predecessorId);
        if (sourcePhase) {
          // Calculate lag based on dependency type
          let lag = 0;
          if (dependencyType === 'SS') {
            // Start-to-Start: lag = new start - source start
            lag = daysBetweenDateStrings(sourcePhase.start_date, startDate);
          } else {
            // Finish-to-Start: lag = new start - (source end + 1)
            lag = daysBetweenDateStrings(addDaysToDateString(sourcePhase.end_date, 1), startDate);
          }
          
          phaseData.dependencies = [{
            id: predecessorId,
            type: dependencyType,
            lag,
            entity: 'phase',
          }];
          
          // Use the source phase's order_index to insert after it
          const sourceSortOrder = sourcePhase.order_index ?? 0;
          phaseData.order_index = sourceSortOrder + 1;
        } else {
          console.warn('[PhaseModal] sourcePhase not found for predecessorId:', predecessorId);
        }
      }
      
      if (isEditing && editingPhase) {
        await updatePhase(editingPhase.id, phaseData);
        // Show the edit right away (the reload below is a no-op in What-If).
        patchPhaseLocally(projectId, editingPhase.id, {
          name: phaseData.name,
          start_date: phaseData.start_date,
          end_date: phaseData.end_date,
          is_milestone: phaseData.is_milestone,
        });
      } else {
        await createPhase(projectId, phaseData);
        // Expand project so new phase is visible
        ensureProjectExpanded(projectId);
        
        // Cascade project dates if the new phase extends beyond project bounds
        if (project) {
          const newPhaseStart = parseLocalDate(phaseData.start_date);
          const newPhaseEnd = parseLocalDate(phaseData.end_date);
          await cascadeProjectDates(project, 'expand', newPhaseStart, newPhaseEnd);
        }
      }
      
      // Reload projects
      const updatedProjects = await loadAllProjects();
      setProjects(updatedProjects);
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save phase');
    } finally {
      endSubmit();
    }
  };
  
  const handleDelete = async () => {
    if (!isEditing || !editingPhase || !projectId) return;
    
    if (!confirm('Are you sure you want to delete this phase? This will also delete all subphases and assignments.')) {
      return;
    }
    
    if (!beginSubmit()) return;
    setError(null);
    
    try {
      await deletePhase(editingPhase.id);
      removePhaseLocally(projectId, editingPhase.id);
      
      // Reload projects to get updated structure
      const updatedProjects = await loadAllProjects();
      
      // Cascade shrink project dates after deletion
      if (project) {
        const updatedProject = updatedProjects.find(p => p.id === project.id);
        if (updatedProject) {
          const didCascade = await cascadeProjectDates(updatedProject, 'shrink');
          if (didCascade) {
            // Reload again to get the cascaded dates
            const finalProjects = await loadAllProjects();
            setProjects(finalProjects);
          } else {
            setProjects(updatedProjects);
          }
        } else {
          setProjects(updatedProjects);
        }
      } else {
        setProjects(updatedProjects);
      }
      
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete phase');
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
          Delete Phase
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
          {isEditing ? 'Save Changes' : 'Add Phase'}
        </Button>
      </div>
    </div>
  );
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title={isEditing ? 'Edit Phase' : 'Add Phase'}
      size="md"
      footer={footer}
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        {createBlockedReason && (
          <div className={styles.error} role="status">{createBlockedReason}</div>
        )}
        {error && error !== createBlockedReason && <div className={styles.error}>{error}</div>}
        
        <Input
          label="Phase Name *"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Preparation, Analytics, Trial, etc."
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
        
        {/* Staff assignments section - only shown when editing */}
        {isEditing && editingPhase?.staffAssignments && editingPhase.staffAssignments.length > 0 && (
          <div className={styles.assignmentsSection}>
            <label className={styles.label}>Assigned Staff</label>
            <div className={styles.assignmentsList}>
              {editingPhase.staffAssignments.map(assignment => (
                <div key={assignment.id} className={styles.assignmentItem}>
                  <span className={styles.assignmentName}>
                    {assignment.staff_name || `Staff #${assignment.staff_id}`}
                  </span>
                  <span className={styles.assignmentAllocation}>
                    {assignment.allocation}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}
