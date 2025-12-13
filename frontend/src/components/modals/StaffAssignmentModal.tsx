/**
 * StaffAssignmentModal - Assign Staff to Projects/Phases/Subphases
 * Supports percentage-based allocation
 */

import { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { 
  createStaffAssignment, 
  updateStaffAssignment, 
  deleteStaffAssignment,
  loadAllProjects 
} from '@/api/endpoints/projects';
import { toInputDateFormat } from '@/utils/date';
import styles from './AssignmentModal.module.css';

export function StaffAssignmentModal() {
  const { activeModal, editingStaffAssignment, modalContext, closeModal } = useUIStore();
  const { projects, staff, currentSite, setProjects } = useAppStore();
  
  const isOpen = activeModal === 'staffAssignment';
  const isEditing = !!editingStaffAssignment;
  
  // Form state
  const [staffId, setStaffId] = useState<string>('');
  const [allocation, setAllocation] = useState(100);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Get context (project, phase, or subphase)
  const projectId = editingStaffAssignment?.project_id || modalContext.projectId;
  const phaseId = editingStaffAssignment?.phase_id || modalContext.phaseId;
  const subphaseId = editingStaffAssignment?.subphase_id || modalContext.subphaseId;
  
  // Filter staff by current site
  const siteStaff = useMemo(() => {
    if (!currentSite) return [];
    return staff.filter(s => s.site_id === currentSite.id);
  }, [staff, currentSite]);
  
  // Get the target item (project, phase, or subphase) for dates
  const targetItem = useMemo(() => {
    if (!projectId) return null;
    const project = projects.find(p => p.id === projectId);
    if (!project) return null;
    
    if (subphaseId) {
      // Find subphase recursively
      const findSubphase = (phases: typeof project.phases): typeof project.phases[0]['children'][0] | null => {
        for (const phase of phases || []) {
          const findInChildren = (children: typeof phase.children): typeof phase.children[0] | null => {
            for (const child of children || []) {
              if (child.id === subphaseId) return child;
              const found = findInChildren(child.children || []);
              if (found) return found;
            }
            return null;
          };
          const found = findInChildren(phase.children || []);
          if (found) return found;
        }
        return null;
      };
      return findSubphase(project.phases || []);
    }
    
    if (phaseId) {
      return project.phases?.find(ph => ph.id === phaseId) || null;
    }
    
    return project;
  }, [projects, projectId, phaseId, subphaseId]);
  
  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen) {
      if (editingStaffAssignment) {
        // Editing mode - convert ISO datetime to input format
        setStaffId(editingStaffAssignment.staff_id.toString());
        setAllocation(editingStaffAssignment.allocation);
        setStartDate(toInputDateFormat(editingStaffAssignment.start_date));
        setEndDate(toInputDateFormat(editingStaffAssignment.end_date));
      } else {
        // New assignment mode - use target item dates as default
        const today = new Date().toISOString().split('T')[0];
        setStaffId('');
        setAllocation(100);
        setStartDate(toInputDateFormat(targetItem?.start_date) || today);
        setEndDate(toInputDateFormat(targetItem?.end_date) || today);
      }
      setError(null);
    }
  }, [isOpen, editingStaffAssignment, targetItem]);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!staffId) {
      setError('Please select a staff member');
      return;
    }
    
    if (!startDate || !endDate) {
      setError('Please select start and end dates');
      return;
    }
    
    if (allocation < 1 || allocation > 100) {
      setError('Allocation must be between 1 and 100');
      return;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      const assignmentData = {
        staff_id: parseInt(staffId),
        allocation,
        start_date: startDate,
        end_date: endDate,
        project_id: projectId || undefined,
        phase_id: phaseId || undefined,
        subphase_id: subphaseId || undefined,
      };
      
      if (isEditing && editingStaffAssignment) {
        await updateStaffAssignment(editingStaffAssignment.id, assignmentData);
      } else {
        await createStaffAssignment(assignmentData);
      }
      
      // Reload projects
      const updatedProjects = await loadAllProjects();
      setProjects(updatedProjects);
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save assignment');
    } finally {
      setIsSubmitting(false);
    }
  };
  
  const handleDelete = async () => {
    if (!isEditing || !editingStaffAssignment) return;
    
    if (!confirm('Are you sure you want to remove this staff assignment?')) {
      return;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      await deleteStaffAssignment(editingStaffAssignment.id);
      // Reload projects
      const updatedProjects = await loadAllProjects();
      setProjects(updatedProjects);
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete assignment');
    } finally {
      setIsSubmitting(false);
    }
  };
  
  // Determine assignment level for display
  const assignmentLevel = subphaseId ? 'Subphase' : phaseId ? 'Phase' : 'Project';
  const targetName = targetItem?.name || 'Unknown';
  
  const footer = (
    <div className={styles.footer}>
      {isEditing && (
        <Button 
          variant="danger" 
          onClick={handleDelete} 
          disabled={isSubmitting}
          className={styles.deleteBtn}
        >
          Remove Assignment
        </Button>
      )}
      <div className={styles.footerRight}>
        <Button variant="secondary" onClick={closeModal} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Assign Staff'}
        </Button>
      </div>
    </div>
  );
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title={isEditing ? 'Edit Staff Assignment' : 'Assign Staff'}
      size="md"
      footer={footer}
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        {error && <div className={styles.error}>{error}</div>}
        
        <div className={styles.contextInfo}>
          {assignmentLevel}: <strong>{targetName}</strong>
        </div>
        
        <div className={styles.formGroup}>
          <label className={styles.label}>Staff Member *</label>
          <select
            className={styles.input}
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            disabled={isEditing} // Can't change staff member when editing
          >
            <option value="">Select staff member</option>
            {siteStaff.map(s => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.role || 'No role'})
              </option>
            ))}
          </select>
        </div>
        
        <div className={styles.formGroup}>
          <label className={styles.label}>Allocation: {allocation}%</label>
          <div className={styles.sliderContainer}>
            <input
              type="range"
              className={styles.slider}
              min="1"
              max="100"
              value={allocation}
              onChange={(e) => setAllocation(parseInt(e.target.value))}
            />
            <div className={styles.sliderLabels}>
              <span>1%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
          </div>
        </div>
        
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Start Date *</label>
            <input
              type="date"
              className={styles.input}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>End Date *</label>
            <input
              type="date"
              className={styles.input}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>
      </form>
    </Modal>
  );
}
