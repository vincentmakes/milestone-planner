/**
 * EquipmentAssignmentModal - Assign Equipment to Projects/Phases/Subphases
 */

import { useState, useEffect, useMemo } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { 
  createEquipmentAssignment, 
  updateEquipmentAssignment, 
  deleteEquipmentAssignment,
  loadAllProjects 
} from '@/api/endpoints/projects';
import { toInputDateFormat } from '@/utils/date';
import styles from './AssignmentModal.module.css';

export function EquipmentAssignmentModal() {
  const { activeModal, editingEquipmentAssignment, modalContext, closeModal } = useUIStore();
  const { projects, equipment, currentSite, setProjects } = useAppStore();
  
  const isOpen = activeModal === 'equipmentAssignment';
  const isEditing = !!editingEquipmentAssignment;
  
  // Form state
  const [equipmentId, setEquipmentId] = useState<string>('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Get context (project, phase, or subphase)
  const projectId = editingEquipmentAssignment?.project_id || modalContext.projectId;
  const phaseId = editingEquipmentAssignment?.phase_id || modalContext.phaseId;
  const subphaseId = editingEquipmentAssignment?.subphase_id || modalContext.subphaseId;
  
  // Filter equipment by current site
  const siteEquipment = useMemo(() => {
    if (!currentSite) return [];
    return equipment.filter(e => e.site_id === currentSite.id);
  }, [equipment, currentSite]);
  
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
      if (editingEquipmentAssignment) {
        // Editing mode - convert ISO datetime to input format
        setEquipmentId(editingEquipmentAssignment.equipment_id.toString());
        setStartDate(toInputDateFormat(editingEquipmentAssignment.start_date));
        setEndDate(toInputDateFormat(editingEquipmentAssignment.end_date));
      } else {
        // New assignment mode - use target item dates as default
        const today = new Date().toISOString().split('T')[0];
        setEquipmentId('');
        setStartDate(toInputDateFormat(targetItem?.start_date) || today);
        setEndDate(toInputDateFormat(targetItem?.end_date) || today);
      }
      setError(null);
    }
  }, [isOpen, editingEquipmentAssignment, targetItem]);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!equipmentId) {
      setError('Please select equipment');
      return;
    }
    
    if (!startDate || !endDate) {
      setError('Please select start and end dates');
      return;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      const assignmentData = {
        equipment_id: parseInt(equipmentId),
        start_date: startDate,
        end_date: endDate,
        project_id: projectId || undefined,
        phase_id: phaseId || undefined,
        subphase_id: subphaseId || undefined,
      };
      
      if (isEditing && editingEquipmentAssignment) {
        await updateEquipmentAssignment(editingEquipmentAssignment.id, assignmentData);
      } else {
        await createEquipmentAssignment(assignmentData);
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
    if (!isEditing || !editingEquipmentAssignment) return;
    
    if (!confirm('Are you sure you want to remove this equipment assignment?')) {
      return;
    }
    
    setIsSubmitting(true);
    setError(null);
    
    try {
      await deleteEquipmentAssignment(editingEquipmentAssignment.id);
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
          {isSubmitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Assign Equipment'}
        </Button>
      </div>
    </div>
  );
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title={isEditing ? 'Edit Equipment Assignment' : 'Assign Equipment'}
      size="md"
      footer={footer}
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        {error && <div className={styles.error}>{error}</div>}
        
        <div className={styles.contextInfo}>
          {assignmentLevel}: <strong>{targetName}</strong>
        </div>
        
        <div className={styles.formGroup}>
          <label className={styles.label}>Equipment *</label>
          <select
            className={styles.input}
            value={equipmentId}
            onChange={(e) => setEquipmentId(e.target.value)}
            disabled={isEditing} // Can't change equipment when editing
          >
            <option value="">Select equipment</option>
            {siteEquipment.map(e => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.type || 'No type'})
              </option>
            ))}
          </select>
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
