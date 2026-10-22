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
import { DateRangeField } from '@/components/common/DateRangeField';
import { Select } from '@/components/common/Select';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useTeamFilter } from '@/hooks/useTeamFilter';
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
import { toInputDateFormat, formatDateISO, toDateOnly } from '@/utils/date';
import type { UpdateStaffAssignmentRequest } from '@/types';
import {
  patchEquipmentAssignmentLocally,
  patchStaffAssignmentLocally,
  removeEquipmentAssignmentLocally,
  removeStaffAssignmentLocally,
} from '@/utils/localProjectTree';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import { findSubphaseById } from '@/utils/subphaseUtils';
import { can, canBookEquipment, canSelf, isBookable, isSelf, needsApproval } from '@/utils/permissions';
import { Notice } from '@/components/common/Notice';
import { isPendingResponse } from '@/api/endpoints/approvals';
import { flashSentForApproval, markRequestPendingLocally } from '@/utils/pendingBookings';
import { AllocationSlider, snapToStep } from '@/components/common/AllocationSlider';
import styles from './AssignmentModal.module.css';
import { confirmAction } from '@/utils/confirmDialog';

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
  const { staffMatches, equipmentMatches } = useTeamFilter();

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
  // Phase / subphase staff: the booking follows the card's dates (linked) or
  // has its own dates inside the card (an unlinked segment).
  const [followCard, setFollowCard] = useState(true);
  const { isSubmitting, begin: beginSubmit, end: endSubmit } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);

  // Get context (project, phase, or subphase)
  const projectId = editingAssignment?.project_id || modalContext.projectId;
  const phaseId = editingAssignment?.phase_id || modalContext.phaseId;
  const subphaseId = editingAssignment?.subphase_id || modalContext.subphaseId;

  // Whoever manages others' bookings on the project (the key, or managing
  // the project) assigns anyone. Everyone else may only book their own time:
  // the picker is fixed to them and only their own booking can be removed.
  // Equipment bookings: equipment_bookings.manage (or managing the project).
  const dialogProject = projects.find((p) => p.id === projectId);
  const isEditor = isStaff
    ? can(currentUser, 'assignments.manage_others', dialogProject)
    : canBookEquipment(currentUser, dialogProject);
  const selfOnly = isStaff && !isEditor && Boolean(currentUser);
  // Own bookings follow the role's assignments.self_* keys: allowed, sent for
  // approval (the server answers 202 and files a request), or denied (the
  // control is hidden and a notice says why).
  const ownKey = isEditing ? 'assignments.self_update' : 'assignments.self_create';
  // A new booking also needs the user to be bookable as a resource (the
  // server answers 400 otherwise); an existing one stays editable.
  const selfNotBookable = selfOnly && !isEditing && !isBookable(currentUser);
  const selfDenied = selfOnly && (!canSelf(currentUser, ownKey) || selfNotBookable);
  const selfNeedsApproval = selfOnly && needsApproval(currentUser, ownKey);
  const removalNeedsApproval = selfOnly && needsApproval(currentUser, 'assignments.self_remove');
  const ownMaxCapacity = useMemo(() => {
    if (!currentUser) return 100;
    const row = staff.find((s) => s.id === currentUser.id);
    return row?.max_capacity ?? currentUser.max_capacity ?? 100;
  }, [staff, currentUser]);
  const canRemove = isEditing && (
    isStaff
      ? isEditor ||
        (isSelf(currentUser, editingStaffAssignment?.staff_id) && canSelf(currentUser, 'assignments.self_remove'))
      : isEditor
  );

  // Resources of the current site, narrowed by the header team filter; the
  // edited booking's resource stays listed so an edit never drops it.
  const editingStaffId = editingStaffAssignment?.staff_id;
  const editingEquipmentId = editingEquipmentAssignment?.equipment_id;
  const siteResources = useMemo(() => {
    if (!currentSite) return [];
    if (isStaff) {
      return staff.filter(
        (s) => s.site_id === currentSite.id && (staffMatches(s) || s.id === editingStaffId)
      );
    }
    return equipment.filter(
      (e) => e.site_id === currentSite.id && (equipmentMatches(e) || e.id === editingEquipmentId)
    );
  }, [isStaff, staff, equipment, currentSite, staffMatches, equipmentMatches, editingStaffId, editingEquipmentId]);

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
        setFollowCard(editingStaffAssignment.linked !== false);
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
      // A new booking is linked by default; the switch gives it own dates.
      setFollowCard(true);
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
  // A card booking with its own dates: the date fields show, bounded by the card.
  const ownCardDates = isStaff && isPhaseOrSubphase && !followCard;
  const cardStart = isPhaseOrSubphase && targetItem?.start_date ? toDateOnly(targetItem.start_date) : undefined;
  const cardEnd = isPhaseOrSubphase && targetItem?.end_date ? toDateOnly(targetItem.end_date) : undefined;

  const handleFollowCardChange = (follow: boolean) => {
    setFollowCard(follow);
    if (!follow && cardStart && cardEnd) {
      // Own dates start inside the card (the card's own dates when unset or outside)
      const s = startDate ? toDateOnly(startDate) : '';
      const e = endDate ? toDateOnly(endDate) : '';
      if (!s || !e || s < cardStart || e > cardEnd || s > e) {
        setStartDate(cardStart);
        setEndDate(cardEnd);
      }
    }
  };

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

    if (isStaff && allocation < 5) {
      setError('Allocation must be at least 5%');
      return;
    }

    if (selfDenied) return;
    if (!beginSubmit()) return;
    setError(null);

    let sentForApproval = false;
    try {
      if (isStaff) {
        if (isEditing && editingStaffAssignment) {
          // Phase / subphase: the allocation, plus own dates (unlinked) or
          // null dates to follow the card again (only when it had own dates).
          const wasUnlinked = editingStaffAssignment.linked === false;
          const updateData: UpdateStaffAssignmentRequest = !isPhaseOrSubphase
            ? { allocation, start_date: startDate, end_date: endDate }
            : !followCard
              ? { allocation, start_date: startDate, end_date: endDate }
              : wasUnlinked
                ? { allocation, start_date: null, end_date: null }
                : { allocation };
          const res = await updateStaffAssignment(editingStaffAssignment.id, updateData, assignmentLevel);
          if (isPendingResponse(res)) {
            // Sent for approval: the booking keeps its values until decided.
            sentForApproval = true;
            if (projectId && currentUser) {
              markRequestPendingLocally(projectId, editingStaffAssignment.id, assignmentLevel, currentUser.id,
                'assignments.self_update', res, updateData);
            }
          } else if (projectId) {
            // Show the edit right away (the reload below is a no-op in What-If).
            patchStaffAssignmentLocally(
              projectId,
              editingStaffAssignment.id,
              assignmentLevel,
              isPhaseOrSubphase
                ? {
                    allocation,
                    linked: followCard,
                    start_date: followCard ? cardStart ?? startDate : startDate,
                    end_date: followCard ? cardEnd ?? endDate : endDate,
                  }
                : { allocation, start_date: startDate, end_date: endDate }
            );
          }
        } else {
          // On a phase / subphase, dates make an unlinked segment: sent only
          // when the booking does not follow the card.
          const withDates = !isPhaseOrSubphase || !followCard;
          const assignmentData = {
            staff_id: parseInt(resourceId),
            allocation,
            ...(withDates ? { start_date: startDate, end_date: endDate } : {}),
            project_id: projectId || undefined,
            phase_id: phaseId || undefined,
            subphase_id: subphaseId || undefined,
          };
          sentForApproval = isPendingResponse(await createStaffAssignment(assignmentData));
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
      if (sentForApproval) flashSentForApproval();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save assignment');
    } finally {
      endSubmit();
    }
  };

  const handleDelete = async () => {
    if (!isEditing || !editingAssignment) return;

    const confirmMsg = !isStaff
      ? 'Are you sure you want to remove this equipment assignment?'
      : removalNeedsApproval
        ? 'Request the removal of your booking? It will be sent for approval.'
        : 'Are you sure you want to remove this staff assignment?';

    if (!(await confirmAction({ title: 'Remove assignment', message: confirmMsg, destructive: true }))) {
      return;
    }

    if (!beginSubmit()) return;
    setError(null);

    let sentForApproval = false;
    try {
      if (isStaff && editingStaffAssignment) {
        const res = await deleteStaffAssignment(editingStaffAssignment.id, assignmentLevel);
        if (isPendingResponse(res)) {
          // Sent for approval: the booking stays until someone decides.
          sentForApproval = true;
          if (projectId && currentUser) {
            markRequestPendingLocally(projectId, editingStaffAssignment.id, assignmentLevel, currentUser.id,
              'assignments.self_remove', res, null);
          }
        } else if (projectId) {
          removeStaffAssignmentLocally(projectId, editingStaffAssignment.id, assignmentLevel);
        }
      } else if (!isStaff && editingEquipmentAssignment) {
        await deleteEquipmentAssignment(editingEquipmentAssignment.id);
        if (projectId) removeEquipmentAssignmentLocally(projectId, editingEquipmentAssignment.id);
      }
      // Reload projects
      const updatedProjects = await loadAllProjects();
      setProjects(updatedProjects);
      closeModal();
      if (sentForApproval) flashSentForApproval();
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

  const submitLabel = isEditing
    ? selfNeedsApproval
      ? 'Request change'
      : 'Save Changes'
    : selfOnly
      ? selfNeedsApproval
        ? 'Request to assign me'
        : 'Assign me'
      : `Assign ${resourceLabel}`;

  const footer = (
    <div className={styles.footer}>
      {canRemove && (
        <Button
          variant="danger"
          onClick={handleDelete}
          disabled={isSubmitting}
          className={styles.deleteBtn}
        >
          {removalNeedsApproval ? 'Request removal' : 'Remove Assignment'}
        </Button>
      )}
      <div className={styles.footerRight}>
        <Button variant="secondary" onClick={closeModal} disabled={isSubmitting}>
          Cancel
        </Button>
        {!selfDenied && (
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isSubmitting || !!createBlockedReason}
            title={createBlockedReason ?? undefined}
            loading={isSubmitting}
          >
            {submitLabel}
          </Button>
        )}
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
        {error && error !== createBlockedReason && <Notice tone="error">{error}</Notice>}
        {selfDenied && (
          <Notice tone="info">
            {isEditing
              ? 'You cannot change your own booking on this project.'
              : selfNotBookable
                ? 'You are not bookable as a resource, so you cannot book your own time.'
                : 'You cannot book your own time on this project.'}
          </Notice>
        )}
        {selfNeedsApproval && !selfDenied && (
          <Notice tone="info">
            {isEditing
              ? 'Changes to your booking are sent for approval.'
              : 'Your booking is sent for approval before it counts.'}
          </Notice>
        )}

        <div className={styles.contextInfo}>
          {assignmentLevelLabel}: <strong>{targetName}</strong>
        </div>

        {/* Resource selector */}
        {selfOnly ? (
          // Fixed to the current user: non-editors only book their own time
          // (selfOnly implies a staff assignment).
          <Input
            label="Staff Member *"
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

        {/* Phase / subphase staff: follow the card's dates, or own dates inside it */}
        {isStaff && isPhaseOrSubphase && (
          <ToggleSwitch
            checked={followCard}
            onChange={handleFollowCardChange}
            label={`Follow the ${assignmentLevelLabel.toLowerCase()} dates`}
          />
        )}

        {/* Info for linked phase/subphase assignments - staff mode only */}
        {isStaff && isPhaseOrSubphase && followCard && (
          <div className={styles.infoBox}>
            <p>📌 This assignment uses the {assignmentLevelLabel.toLowerCase()}'s dates automatically.</p>
          </div>
        )}

        {/* Date fields: project-level staff, own-dates card staff (bounded by the card), equipment */}
        {(!isStaff || !isPhaseOrSubphase || ownCardDates) && (
          <div className={styles.formRow}>
            <DateRangeField
              startLabel="Start Date *"
              endLabel="End Date *"
              fieldClassName={styles.field}
              start={startDate}
              end={endDate}
              minDate={ownCardDates ? cardStart : undefined}
              maxDate={ownCardDates ? cardEnd : undefined}
              onChange={({ start, end }) => {
                setStartDate(start);
                setEndDate(end);
              }}
            />
          </div>
        )}
      </form>
    </Modal>
  );
}
