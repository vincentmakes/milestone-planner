/**
 * AssignmentModal - Generic modal for assigning Staff or Equipment to Projects/Phases/Subphases
 * Supports both staff (with percentage-based allocation and max capacity awareness)
 * and equipment assignment modes.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Modal } from '@/components/common/Modal';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Select } from '@/components/common/Select';
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
import { useWhatIfStore } from '@/stores/whatIfStore';
import { toInputDateFormat, formatDateISO } from '@/utils/date';
import {
  patchEquipmentAssignmentLocally,
  patchStaffAssignmentLocally,
  removeEquipmentAssignmentLocally,
  removeStaffAssignmentLocally,
} from '@/utils/localProjectTree';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { findSubphaseById } from '@/utils/subphaseUtils';
import { canEditProject, isSelf } from '@/utils/permissions';
import { AllocationSlider, snapToStep } from '@/components/common/AllocationSlider';
import styles from './AssignmentModal.module.css';

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
  const projects = useAppStore((s) => s.projects);
  const staff = useAppStore((s) => s.staff);
  const equipment = useAppStore((s) => s.equipment);
  const currentSite = useAppStore((s) => s.currentSite);
  const currentUser = useAppStore((s) => s.currentUser);
  const setProjects = useAppStore((s) => s.setProjects);

  const isOpen = isStaff
    ? activeModal === 'staffAssignment'
    : activeModal === 'equipmentAssignment';

  const editingAssignment = isStaff ? editingStaffAssignment : editingEquipmentAssignment;
  const isEditing = !!editingAssignment;
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  // Creating inside What-If cannot show the new booking until Apply; edits are fine.
  const createBlockedReason = !isEditing && whatIfMode
    ? whatIfUnavailableMessage(isStaff ? 'Assigning staff' : 'Assigning equipment')
    : null;

  // Form state
  const [resourceId, setResourceId] = useState<string>('');
  const [allocation, setAllocation] = useState(100);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);

  // Get context (project, phase, or subphase)
  const projectId = editingAssignment?.project_id || modalContext.projectId;
  const phaseId = editingAssignment?.phase_id || modalContext.phaseId;
  const subphaseId = editingAssignment?.subphase_id || modalContext.subphaseId;

  // Project editors (admin, superuser, the project's manager) assign anyone.
  // Everyone else may only book their own time: the picker is fixed to them
  // and only their own booking can be removed.
  const isEditor = canEditProject(currentUser, projects.find((p) => p.id === projectId));
  const selfOnly = isStaff && !isEditor && Boolean(currentUser);
  const ownMaxCapacity = useMemo(() => {
    if (!currentUser) return 100;
    const row = staff.find((s) => s.id === currentUser.id);
    return row?.max_capacity ?? currentUser.max_capacity ?? 100;
  }, [staff, currentUser]);
  const canRemove = isEditing && (
    isStaff
      ? isEditor || isSelf(currentUser, editingStaffAssignment?.staff_id)
      : isEditor
  );

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

  // Initialize form when modal opens -- once per open. The inputs below
  // (staff, projects) are refetched on WebSocket changes; without the guard a
  // colleague's edit would wipe what the user has typed. The key changes when
  // the dialog is reopened on another assignment or target.
  const initializedForRef = useRef<string | null>(null);
  const initKey = `${mode}:${editingAssignment?.id ?? 'new'}:${projectId ?? ''}:${phaseId ?? ''}:${subphaseId ?? ''}`;
  useEffect(() => {
    if (!isOpen) {
      initializedForRef.current = null;
      return;
    }
    if (initializedForRef.current === initKey) return;
    initializedForRef.current = initKey;
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
      const today = formatDateISO(new Date());
      if (selfOnly && currentUser) {
        // Non-editors can only assign themselves, at their own capacity.
        setResourceId(String(currentUser.id));
        setAllocation(snapToStep(ownMaxCapacity));
      } else {
        setResourceId('');
        setAllocation(100);
      }
      setStartDate(toInputDateFormat(targetItem?.start_date) || today);
      setEndDate(toInputDateFormat(targetItem?.end_date) || today);
    }
    setError(null);
  }, [isOpen, initKey, editingAssignment, editingStaffAssignment, editingEquipmentAssignment, isStaff, targetItem, selfOnly, currentUser, ownMaxCapacity]);

  // Handle resource selection - for staff, auto-set allocation to their max capacity
  const handleResourceChange = useCallback((newResourceId: string) => {
    setResourceId(newResourceId);
    if (isStaff && newResourceId && !isEditing) {
      // Find the staff member's max capacity and set allocation to it
      const selectedStaff = staff.find(s => s.id === parseInt(newResourceId));
      const maxCap = selectedStaff?.max_capacity ?? 100;
      setAllocation(snapToStep(maxCap));
    }
  }, [isStaff, staff, isEditing]);

  // Determine assignment level for API calls
  const assignmentLevel: 'project' | 'phase' | 'subphase' = subphaseId ? 'subphase' : (phaseId ? 'phase' : 'project');
  const isPhaseOrSubphase = assignmentLevel !== 'project';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (createBlockedReason) {
      setError(createBlockedReason);
      return;
    }

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

    if (!beginSubmit()) return;
    setError(null);

    try {
      if (isStaff) {
        if (isEditing && editingStaffAssignment) {
          // For phase/subphase, only update allocation (no dates)
          const updateData = isPhaseOrSubphase
            ? { allocation }
            : { allocation, start_date: startDate, end_date: endDate };
          await updateStaffAssignment(editingStaffAssignment.id, updateData, assignmentLevel);
          // Show the edit right away (the reload below is a no-op in What-If).
          if (projectId) {
            patchStaffAssignmentLocally(projectId, editingStaffAssignment.id, assignmentLevel, updateData);
          }
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
          if (projectId) {
            patchEquipmentAssignmentLocally(projectId, editingEquipmentAssignment.id, {
              start_date: startDate,
              end_date: endDate,
            });
          }
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
      endSubmit();
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

    if (!beginSubmit()) return;
    setError(null);

    try {
      if (isStaff && editingStaffAssignment) {
        await deleteStaffAssignment(editingStaffAssignment.id, assignmentLevel);
        if (projectId) removeStaffAssignmentLocally(projectId, editingStaffAssignment.id, assignmentLevel);
      } else if (!isStaff && editingEquipmentAssignment) {
        await deleteEquipmentAssignment(editingEquipmentAssignment.id);
        if (projectId) removeEquipmentAssignmentLocally(projectId, editingEquipmentAssignment.id);
      }
      // Reload projects
      const updatedProjects = await loadAllProjects();
      setProjects(updatedProjects);
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete assignment');
    } finally {
      endSubmit();
    }
  };

  // Determine assignment level for display
  const assignmentLevelLabel = subphaseId ? 'Subphase' : phaseId ? 'Phase' : 'Project';
  const targetName = targetItem?.name || 'Unknown';

  const resourceLabel = isStaff ? 'Staff' : 'Equipment';

  // The empty first entry stays a real, selectable option (as before).
  const resourceOptions = useMemo(
    () => [
      { value: '', label: isStaff ? 'Select staff member' : 'Select equipment' },
      ...(isStaff
        ? siteResources.map((s) => {
            const maxCap = (s as typeof staff[0]).max_capacity ?? 100;
            const capacityLabel = maxCap < 100 ? ` - ${maxCap}% capacity` : '';
            return {
              value: s.id,
              label: `${s.name} (${(s as typeof staff[0]).role || 'No role'})${capacityLabel}`,
            };
          })
        : siteResources.map((e) => ({
            value: e.id,
            label: `${e.name} (${(e as typeof equipment[0]).type || 'No type'})`,
          }))),
    ],
    [isStaff, siteResources]
  );

  const footer = (
    <div className={styles.footer}>
      {canRemove && (
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
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={isSubmitting || !!createBlockedReason}
          title={createBlockedReason ?? undefined}
          loading={isSubmitting}
        >
          {isEditing ? 'Save Changes' : selfOnly ? 'Assign me' : `Assign ${resourceLabel}`}
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
        {createBlockedReason && (
          <div className={styles.error} role="status">{createBlockedReason}</div>
        )}
        {error && error !== createBlockedReason && <div className={styles.error}>{error}</div>}

        <div className={styles.contextInfo}>
          {assignmentLevelLabel}: <strong>{targetName}</strong>
        </div>

        {/* Resource selector */}
        {selfOnly ? (
          // Fixed to the current user: non-editors only book their own time.
          <Input
            label={isStaff ? 'Staff Member *' : 'Equipment *'}
            type="text"
            value="You"
            readOnly
            aria-label="Staff Member"
            title={currentUser?.name}
            fullWidth
          />
        ) : (
          <Select
            label={isStaff ? 'Staff Member *' : 'Equipment *'}
            value={resourceId}
            onChange={(e) => handleResourceChange(e.target.value)}
            disabled={isEditing}
            aria-label={isStaff ? 'Staff Member' : 'Equipment'}
            options={resourceOptions}
            fullWidth
          />
        )}

        {/* Allocation slider - staff mode only */}
        {isStaff && (
          <div className={styles.formGroup}>
            <AllocationSlider
              value={allocation}
              onChange={setAllocation}
              maxCapacity={selectedStaffMaxCapacity}
              aria-label="Allocation"
            />
          </div>
        )}

        {/* Date fields */}
        {/* Staff: only show for project-level assignments */}
        {/* Equipment: always show */}
        {(!isStaff || !isPhaseOrSubphase) && (
          <div className={styles.formRow}>
            <Input
              label="Start Date *"
              type="date"
              className={styles.field}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <Input
              label="End Date *"
              type="date"
              className={styles.field}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
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
