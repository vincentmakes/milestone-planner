/**
 * AssignmentModal - Generic modal for assigning Staff or Equipment to Projects/Phases/Subphases
 * Supports both staff (with percentage-based allocation and max capacity awareness)
 * and equipment assignment modes.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import {
  createStaffAssignment,
  updateStaffAssignment,
  deleteStaffAssignment,
  createEquipmentAssignment,
  updateEquipmentAssignment,
  deleteEquipmentAssignment,
  loadAllProjects
} from '@/api/endpoints/projects';
import { toInputDateFormat } from '@/utils/date';
import { findSubphaseById } from '@/utils/subphaseUtils';
import styles from './AssignmentModal.module.css';

// Snap allocation value to nearest 5%
const snapTo5Percent = (value: number): number => {
  return Math.round(value / 5) * 5;
};

interface AssignmentModalProps {
  mode: 'staff' | 'equipment';
}

export function AssignmentModal({ mode }: AssignmentModalProps) {
  const isStaff = mode === 'staff';

  const {
    activeModal,
    editingStaffAssignment,
    editingEquipmentAssignment,
    modalContext,
    closeModal
  } = useUIStore();
  const { projects, staff, equipment, currentSite, setProjects } = useAppStore();

  const isOpen = isStaff
    ? activeModal === 'staffAssignment'
    : activeModal === 'equipmentAssignment';

  const editingAssignment = isStaff ? editingStaffAssignment : editingEquipmentAssignment;
  const isEditing = !!editingAssignment;

  // Form state
  const [resourceId, setResourceId] = useState<string>('');
  const [allocation, setAllocation] = useState(100);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get context (project, phase, or subphase)
  const projectId = editingAssignment?.project_id || modalContext.projectId;
  const phaseId = editingAssignment?.phase_id || modalContext.phaseId;
  const subphaseId = editingAssignment?.subphase_id || modalContext.subphaseId;

  // Filter resources by current site
  const siteResources = useMemo(() => {
    if (!currentSite) return [];
    if (isStaff) {
      return staff.filter(s => s.site_id === currentSite.id);
    }
    return equipment.filter(e => e.site_id === currentSite.id);
  }, [isStaff, staff, equipment, currentSite]);

  // Get selected staff's max capacity (default to 100 if not set) - staff mode only
  const selectedStaffMaxCapacity = useMemo(() => {
    if (!isStaff || !resourceId) return 100;
    const selected = staff.find(s => s.id === parseInt(resourceId));
    return selected?.max_capacity ?? 100;
  }, [isStaff, resourceId, staff]);

  // Check if allocation exceeds max capacity - staff mode only
  const isOverallocated = isStaff && allocation > selectedStaffMaxCapacity;

  // Get the target item (project, phase, or subphase) for dates
  const targetItem = useMemo(() => {
    if (!projectId) return null;
    const project = projects.find(p => p.id === projectId);
    if (!project) return null;

    if (subphaseId) {
      return findSubphaseById(project.phases || [], subphaseId);
    }

    if (phaseId) {
      return project.phases?.find(ph => ph.id === phaseId) || null;
    }

    return project;
  }, [projects, projectId, phaseId, subphaseId]);

  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen) {
      if (editingAssignment) {
        // Editing mode - convert ISO datetime to input format
        if (isStaff && editingStaffAssignment) {
          setResourceId(editingStaffAssignment.staff_id.toString());
          setAllocation(editingStaffAssignment.allocation);
        } else if (!isStaff && editingEquipmentAssignment) {
          setResourceId(editingEquipmentAssignment.equipment_id.toString());
        }
        setStartDate(toInputDateFormat(editingAssignment.start_date));
        setEndDate(toInputDateFormat(editingAssignment.end_date));
      } else {
        // New assignment mode - use target item dates as default
        const today = new Date().toISOString().split('T')[0];
        setResourceId('');
        setAllocation(100);
        setStartDate(toInputDateFormat(targetItem?.start_date) || today);
        setEndDate(toInputDateFormat(targetItem?.end_date) || today);
      }
      setError(null);
    }
  }, [isOpen, editingAssignment, editingStaffAssignment, editingEquipmentAssignment, isStaff, targetItem]);

  // Handle resource selection - for staff, auto-set allocation to their max capacity
  const handleResourceChange = useCallback((newResourceId: string) => {
    setResourceId(newResourceId);
    if (isStaff && newResourceId && !isEditing) {
      // Find the staff member's max capacity and set allocation to it
      const selectedStaff = staff.find(s => s.id === parseInt(newResourceId));
      const maxCap = selectedStaff?.max_capacity ?? 100;
      setAllocation(snapTo5Percent(maxCap));
    }
  }, [isStaff, staff, isEditing]);

  // Handle allocation slider change with 5% increments - staff mode only
  const handleAllocationChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = parseInt(e.target.value);
    setAllocation(snapTo5Percent(rawValue));
  }, []);

  // Determine assignment level for API calls
  const assignmentLevel: 'project' | 'phase' | 'subphase' = subphaseId ? 'subphase' : (phaseId ? 'phase' : 'project');
  const isPhaseOrSubphase = assignmentLevel !== 'project';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!resourceId) {
      setError(isStaff ? 'Please select a staff member' : 'Please select equipment');
      return;
    }

    // Staff: only require dates for project-level assignments
    // Equipment: always require dates
    if (isStaff) {
      if (!isPhaseOrSubphase && (!startDate || !endDate)) {
        setError('Please select start and end dates');
        return;
      }
      if (allocation < 5) {
        setError('Allocation must be at least 5%');
        return;
      }
    } else {
      if (!startDate || !endDate) {
        setError('Please select start and end dates');
        return;
      }
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (isStaff) {
        if (isEditing && editingStaffAssignment) {
          // For phase/subphase, only update allocation (no dates)
          const updateData = isPhaseOrSubphase
            ? { allocation }
            : { allocation, start_date: startDate, end_date: endDate };
          await updateStaffAssignment(editingStaffAssignment.id, updateData, assignmentLevel);
        } else {
          const assignmentData = {
            staff_id: parseInt(resourceId),
            allocation,
            start_date: startDate,
            end_date: endDate,
            project_id: projectId || undefined,
            phase_id: phaseId || undefined,
            subphase_id: subphaseId || undefined,
          };
          await createStaffAssignment(assignmentData);
        }
      } else {
        const assignmentData = {
          equipment_id: parseInt(resourceId),
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
    if (!isEditing || !editingAssignment) return;

    const confirmMsg = isStaff
      ? 'Are you sure you want to remove this staff assignment?'
      : 'Are you sure you want to remove this equipment assignment?';

    if (!confirm(confirmMsg)) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (isStaff && editingStaffAssignment) {
        await deleteStaffAssignment(editingStaffAssignment.id, assignmentLevel);
      } else if (!isStaff && editingEquipmentAssignment) {
        await deleteEquipmentAssignment(editingEquipmentAssignment.id);
      }
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
  const assignmentLevelLabel = subphaseId ? 'Subphase' : phaseId ? 'Phase' : 'Project';
  const targetName = targetItem?.name || 'Unknown';

  const resourceLabel = isStaff ? 'Staff' : 'Equipment';

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
          {isSubmitting ? 'Saving...' : isEditing ? 'Save Changes' : `Assign ${resourceLabel}`}
        </Button>
      </div>
    </div>
  );

  const modalTitle = isEditing
    ? `Edit ${resourceLabel} Assignment`
    : `Assign ${resourceLabel}`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title={modalTitle}
      size="md"
      footer={footer}
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.contextInfo}>
          {assignmentLevelLabel}: <strong>{targetName}</strong>
        </div>

        {/* Resource selector */}
        <div className={styles.formGroup}>
          <label className={styles.label}>
            {isStaff ? 'Staff Member *' : 'Equipment *'}
          </label>
          <select
            className={styles.input}
            value={resourceId}
            onChange={(e) => handleResourceChange(e.target.value)}
            disabled={isEditing}
          >
            <option value="">
              {isStaff ? 'Select staff member' : 'Select equipment'}
            </option>
            {isStaff
              ? siteResources.map(s => {
                  const maxCap = (s as typeof staff[0]).max_capacity ?? 100;
                  const capacityLabel = maxCap < 100 ? ` - ${maxCap}% capacity` : '';
                  return (
                    <option key={s.id} value={s.id}>
                      {s.name} ({(s as typeof staff[0]).role || 'No role'}){capacityLabel}
                    </option>
                  );
                })
              : siteResources.map(e => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({(e as typeof equipment[0]).type || 'No type'})
                  </option>
                ))
            }
          </select>
        </div>

        {/* Allocation slider - staff mode only */}
        {isStaff && (
          <div className={styles.formGroup}>
            <label className={styles.label}>
              Allocation: {allocation}%
              {selectedStaffMaxCapacity < 100 && (
                <span className={styles.capacityHint}> (Max capacity: {selectedStaffMaxCapacity}%)</span>
              )}
            </label>
            <div className={styles.sliderContainer}>
              <input
                type="range"
                className={`${styles.slider} ${isOverallocated ? styles.sliderOverallocated : ''}`}
                min="5"
                max="100"
                step="5"
                value={Math.min(allocation, 100)}
                onChange={handleAllocationChange}
              />
              <div className={styles.sliderLabels}>
                <span>5%</span>
                {selectedStaffMaxCapacity < 100 && selectedStaffMaxCapacity > 25 && selectedStaffMaxCapacity < 75 && (
                  <span className={styles.maxCapacityMarker}>{selectedStaffMaxCapacity}%</span>
                )}
                <span>50%</span>
                <span>100%</span>
              </div>
            </div>
            {isOverallocated && (
              <div className={styles.overallocationWarning}>
                ⚠️ Allocation exceeds staff's max capacity of {selectedStaffMaxCapacity}%
              </div>
            )}
          </div>
        )}

        {/* Date fields */}
        {/* Staff: only show for project-level assignments */}
        {/* Equipment: always show */}
        {(!isStaff || !isPhaseOrSubphase) && (
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
        )}

        {/* Info for phase/subphase assignments - staff mode only */}
        {isStaff && isPhaseOrSubphase && (
          <div className={styles.infoBox}>
            <p>📌 This assignment uses the {assignmentLevelLabel.toLowerCase()}'s dates automatically.</p>
          </div>
        )}
      </form>
    </Modal>
  );
}
