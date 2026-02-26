/**
 * PhaseModal - Create/Edit Phase Modal
 * Supports phase creation, editing, milestone mode, and staff assignments
 */

import { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { createPhase, updatePhase, deletePhase, loadAllProjects, updateProject } from '@/api/endpoints/projects';
import { toInputDateFormat } from '@/utils/date';
import { getPhaseColor } from '@/utils/themeColors';
import type { Project } from '@/types';
import styles from './PhaseModal.module.css';

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

// Cascade project dates based on phases
async function cascadeProjectDates(
  project: Project,
  mode: 'expand' | 'shrink',
  newPhaseStart?: Date,
  newPhaseEnd?: Date
): Promise<boolean> {
  // Project must have dates
  if (!project.start_date || !project.end_date) return false;
  
  const projectStart = new Date(project.start_date);
  const projectEnd = new Date(project.end_date);
  
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
    await updateProject(project.id, {
      start_date: updatedProjectStart.toISOString().split('T')[0],
      end_date: updatedProjectEnd.toISOString().split('T')[0],
    });
    return true;
  }
  return false;
}

export function PhaseModal() {
  const { activeModal, editingPhase, modalContext, closeModal } = useUIStore();
  const projects = useAppStore((s) => s.projects);
  const setProjects = useAppStore((s) => s.setProjects);
  const { ensureProjectExpanded } = useViewStore();
  
  const isOpen = activeModal === 'phase';
  const isEditing = !!editingPhase;
  const projectId = editingPhase?.project_id || modalContext.projectId;
  
  // Form state
  const [name, setName] = useState('');
  const [isMilestone, setIsMilestone] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Get parent project for date constraints
  const project = useMemo(() => {
    return projects.find(p => p.id === projectId);
  }, [projects, projectId]);
  
  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen) {
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
        const today = new Date().toISOString().split('T')[0];
        const defaultStart = toInputDateFormat(project?.start_date) || today;
        const defaultEnd = toInputDateFormat(project?.end_date) || today;
        
        setName('');
        setIsMilestone(false);
        setStartDate(defaultStart);
        setEndDate(defaultEnd);
      }
      setError(null);
    }
  }, [isOpen, editingPhase, project, modalContext.phantomPreset]);
  
  // Sync end date with start date for milestones
  useEffect(() => {
    if (isMilestone && startDate) {
      setEndDate(startDate);
    }
  }, [isMilestone, startDate]);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
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
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      // Build phase data
      const phaseData: {
        name: string;
        start_date: string;
        end_date: string;
        is_milestone: boolean;
        color: string;
        dependencies?: { id: number; type: 'FS' | 'FF' | 'SS' | 'SF'; lag: number }[];
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
          const newStart = new Date(startDate);
          const sourceStart = new Date(sourcePhase.start_date.split('T')[0]);
          const sourceEnd = new Date(sourcePhase.end_date.split('T')[0]);
          
          if (dependencyType === 'SS') {
            // Start-to-Start: lag = new start - source start
            lag = Math.round((newStart.getTime() - sourceStart.getTime()) / (1000 * 60 * 60 * 24));
          } else {
            // Finish-to-Start: lag = new start - (source end + 1)
            const expectedStart = new Date(sourceEnd);
            expectedStart.setDate(expectedStart.getDate() + 1);
            lag = Math.round((newStart.getTime() - expectedStart.getTime()) / (1000 * 60 * 60 * 24));
          }
          
          phaseData.dependencies = [{
            id: predecessorId,
            type: dependencyType,
            lag,
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
      } else {
        await createPhase(projectId, phaseData);
        // Expand project so new phase is visible
        ensureProjectExpanded(projectId);
        
        // Cascade project dates if the new phase extends beyond project bounds
        if (project) {
          const newPhaseStart = new Date(phaseData.start_date);
          const newPhaseEnd = new Date(phaseData.end_date);
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
      setIsSubmitting(false);
    }
  };
  
  const handleDelete = async () => {
    if (!isEditing || !editingPhase || !projectId) return;
    
    if (!confirm('Are you sure you want to delete this phase? This will also delete all subphases and assignments.')) {
      return;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      await deletePhase(editingPhase.id);
      
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
          Delete Phase
        </Button>
      )}
      <div className={styles.footerRight}>
        <Button variant="secondary" onClick={closeModal} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Phase'}
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
        {error && <div className={styles.error}>{error}</div>}
        
        <div className={styles.formGroup}>
          <label className={styles.label}>Phase Name *</label>
          <input
            type="text"
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Preparation, Analytics, Trial, etc."
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
