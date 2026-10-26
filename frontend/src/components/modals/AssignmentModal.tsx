/**
 * AssignmentModal - Generic modal for assigning Staff or Equipment to Projects/Phases/Subphases
 * Supports both staff (with percentage-based allocation and max capacity awareness)
 * and equipment assignment modes.
 *
 * Editing a staff booking also shows its comment thread (`CardComments`): the
 * card's — shared with the Kanban card dialog — or, for a project-level
 * booking, the project's. The thread renders OUTSIDE the `<form>` so that
 * posting a comment never submits (and closes) the booking. A booking the
 * user may not change (`assignmentLock`: someone else's pending join, an open
 * request of mine, no right) opens read-only with a Notice saying why — My
 * Work's Open always lands here — while its comments stay usable.
 *
 * A new staff booking may carry a comment (`MentionTextarea`, inside the
 * form — Enter in it adds a line, it never submits): assigned directly it is
 * added to the booking's comment thread, so the field shows only with
 * `kanban.comment`; as a request ("Request to assign me") it is the message
 * for the approver, always offered, and added to the thread once approved
 * when the user may comment. Equipment bookings carry an optional note
 * (create and edit; an edit always sends it, `""` clears it).
 */

import { useState, useEffect, useMemo, useCallback, useRef, useId } from 'react';
import { Modal } from '@/components/common/Modal';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { DateRangeField } from '@/components/common/DateRangeField';
import { SearchableSelect } from '@/components/common/SearchableSelect';
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
  findStaffAssignment,
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
import {
  ASSIGNMENT_LOCK_MESSAGES,
  assignmentLock,
  flashSentForApproval,
  markRequestPendingLocally,
} from '@/utils/pendingBookings';
import { CardComments } from '@/components/common/CardComments';
import { MentionTextarea } from '@/components/common/MentionTextarea';
import { useHasPermission } from '@/hooks/useCan';
import { useMentionCandidates } from '@/hooks/useMentionCandidates';
import { serializeMentions, type MentionAnchor } from '@/utils/mentions';
import { AllocationSlider, snapToStep } from '@/components/common/AllocationSlider';
import styles from './AssignmentModal.module.css';
import { confirmAction } from '@/utils/confirmDialog';
import { Icon, PinIcon } from '@/components/common/Icon';

// Stable empty list: a fresh [] per render would recompute the mention candidates.
const NO_PARTICIPANTS: readonly never[] = [];

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
  // A new staff booking's comment (text + picked mentions), an equipment booking's note.
  const [commentDraft, setCommentDraft] = useState('');
  const [commentAnchors, setCommentAnchors] = useState<MentionAnchor[]>([]);
  const [note, setNote] = useState('');
  const canComment = useHasPermission('kanban.comment');
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
  // edited booking's resource stays listed so an edit never drops it — even
  // a booking at another site (opened from My Work).
  const editingStaffId = editingStaffAssignment?.staff_id;
  const editingEquipmentId = editingEquipmentAssignment?.equipment_id;
  const siteResources = useMemo(() => {
    if (!currentSite) return [];
    if (isStaff) {
      const listed = staff.filter(
        (s) => s.site_id === currentSite.id && (staffMatches(s) || s.id === editingStaffId)
      );
      const edited =
        editingStaffId !== undefined && !listed.some((s) => s.id === editingStaffId)
          ? staff.find((s) => s.id === editingStaffId)
          : undefined;
      return edited ? [...listed, edited] : listed;
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
        setNote(editingEquipmentAssignment.note ?? '');
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
      setNote('');
    }
    setCommentDraft('');
    setCommentAnchors([]);
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

  // The Gantt's lock rule, on the live row (its pending state and open
  // request; the edited copy may not carry them): a locked booking shows
  // read-only, its comments stay usable.
  const liveStaffRow =
    isStaff && editingStaffAssignment
      ? findStaffAssignment(dialogProject, assignmentLevel, editingStaffAssignment.id)
      : undefined;
  const lock =
    isStaff && editingStaffAssignment
      ? assignmentLock(liveStaffRow ?? editingStaffAssignment, currentUser, dialogProject)
      : null;
  const locked = lock !== null;
  // Remove follows the context menu's rule: only the pending locks stop it
  // (a role may hold assignments.self_remove without self_update).
  const removeLocked = lock === 'request-open' || lock === 'pending-other';
  const isPhaseOrSubphase = assignmentLevel !== 'project';
  // A card booking with its own dates: the date fields show, bounded by the card.
  const ownCardDates = isStaff && isPhaseOrSubphase && !followCard;
  const cardStart = isPhaseOrSubphase && targetItem?.start_date ? toDateOnly(targetItem.start_date) : undefined;
  const cardEnd = isPhaseOrSubphase && targetItem?.end_date ? toDateOnly(targetItem.end_date) : undefined;

  // The comment of a new staff booking: a request's message for the approver
  // (always offered), or a direct booking's first word in its thread (only
  // for those who may comment -- the server answers 403 otherwise).
  const isRequest = selfNeedsApproval;
  const showCommentField =
    isStaff && !isEditing && !selfDenied && !createBlockedReason && (isRequest || canComment);
  const commentCandidates = useMentionCandidates(
    showCommentField ? dialogProject?.site_id : null,
    targetItem?.staffAssignments ?? NO_PARTICIPANTS,
    currentUser?.id
  );
  const commentFieldId = useId();
  const commentLabel = isRequest ? 'Message for the approver (optional)' : 'Comment (optional)';
  // A request's @-mentions notify nobody until it is approved, and only if the
  // requester may comment (the note is then added to the thread).
  const commentPlaceholder = !isRequest
    ? 'Type @ to notify someone.'
    : canComment
      ? 'Type @ to mention someone; they are notified once the request is approved.'
      : 'Why you need this booking.';
  const commentHint = !canComment
    ? null
    : isRequest
      ? "Added to the booking's comment thread once approved."
      : "Added to the booking's comment thread.";

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

    if (selfDenied || locked) return;
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
          // Serialize first, then trim: trimming the draft would shift the
          // mention anchors' offsets.
          const comment = showCommentField
            ? serializeMentions(commentDraft, commentAnchors).trim()
            : '';
          const assignmentData = {
            staff_id: parseInt(resourceId),
            allocation,
            ...(withDates ? { start_date: startDate, end_date: endDate } : {}),
            ...(comment ? { comment } : {}),
            project_id: projectId || undefined,
            phase_id: phaseId || undefined,
            subphase_id: subphaseId || undefined,
          };
          sentForApproval = isPendingResponse(await createStaffAssignment(assignmentData));
        }
      } else {
        const trimmedNote = note.trim();
        if (isEditing && editingEquipmentAssignment) {
          // Always sent on an edit: "" clears the note.
          await updateEquipmentAssignment(editingEquipmentAssignment.id, {
            equipment_id: parseInt(resourceId),
            start_date: startDate,
            end_date: endDate,
            note: trimmedNote,
          });
          if (projectId) {
            patchEquipmentAssignmentLocally(projectId, editingEquipmentAssignment.id, {
              start_date: startDate,
              end_date: endDate,
              note: trimmedNote || null,
            });
          }
        } else {
          if (!projectId) {
            setError('No project to book the equipment on');
            return;
          }
          // Equipment is booked on the project, also from a phase or subphase row.
          await createEquipmentAssignment({
            equipment_id: parseInt(resourceId),
            start_date: startDate,
            end_date: endDate,
            ...(trimmedNote ? { note: trimmedNote } : {}),
            project_id: projectId,
          });
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
    if (!isEditing || !editingAssignment || removeLocked) return;

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

  // The picker's rows, searched by name and role / type; its empty first
  // row stays a real, selectable choice (as before).
  const resourceOptions = useMemo(
    () =>
      isStaff
        ? siteResources.map((s) => {
            const maxCap = (s as typeof staff[0]).max_capacity ?? 100;
            return {
              id: s.id,
              label: s.name,
              hint: (s as typeof staff[0]).role || 'No role',
              note: maxCap < 100 ? `${maxCap}% capacity` : undefined,
            };
          })
        : siteResources.map((e) => ({
            id: e.id,
            label: e.name,
            hint: (e as typeof equipment[0]).type || 'No type',
          })),
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
          disabled={isSubmitting || removeLocked}
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
            disabled={isSubmitting || !!createBlockedReason || locked}
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

  // The thread of the edited staff booking: its card's, or its project's.
  const commentEntityId = assignmentLevel === 'project' ? projectId : subphaseId || phaseId;
  const showComments = isStaff && isEditing && Boolean(projectId) && Boolean(commentEntityId);

  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title={modalTitle}
      size={showComments ? 'lg' : 'md'}
      footer={footer}
    >
      <form
        onSubmit={handleSubmit}
        className={isEditing ? styles.form : `${styles.form} ${styles.formTall}`}
      >
        {createBlockedReason && (
          <div className={styles.error} role="status">{createBlockedReason}</div>
        )}
        {error && error !== createBlockedReason && <Notice tone="error">{error}</Notice>}
        {/* Own changes denied by the role: the more precise notice below says so */}
        {lock && !(lock === 'no-right' && selfDenied) && (
          <Notice tone="info">{ASSIGNMENT_LOCK_MESSAGES[lock]}</Notice>
        )}
        {selfDenied && (lock === null || lock === 'no-right') && (
          <Notice tone="info">
            {isEditing
              ? 'You cannot change your own booking on this project.'
              : selfNotBookable
                ? 'You are not bookable as a resource, so you cannot book your own time.'
                : 'You cannot book your own time on this project.'}
          </Notice>
        )}
        {selfNeedsApproval && !selfDenied && !locked && (
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
          <SearchableSelect
            label={isStaff ? 'Staff Member *' : 'Equipment *'}
            value={resourceId === '' ? null : Number(resourceId)}
            // Fires only on a real change: re-picking keeps the allocation.
            onChange={(id) => handleResourceChange(id === null ? '' : String(id))}
            disabled={isEditing}
            options={resourceOptions}
            emptyLabel={isStaff ? 'Select staff member' : 'Select equipment'}
            searchLabel={isStaff ? 'Find a person' : 'Find equipment'}
            noMatchText={isStaff ? 'No one matches' : 'No equipment matches'}
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
              disabled={locked}
              aria-label="Allocation"
            />
          </div>
        )}

        {/* Phase / subphase staff: follow the card's dates, or own dates inside it */}
        {isStaff && isPhaseOrSubphase && (
          <ToggleSwitch
            checked={followCard}
            onChange={handleFollowCardChange}
            disabled={locked}
            label={`Follow the ${assignmentLevelLabel.toLowerCase()} dates`}
          />
        )}

        {/* Info for linked phase/subphase assignments - staff mode only */}
        {isStaff && isPhaseOrSubphase && followCard && (
          <div className={styles.infoBox}>
            <p className={styles.infoLine}>
              <Icon icon={PinIcon} size={14} />
              This assignment uses the {assignmentLevelLabel.toLowerCase()}&apos;s dates automatically.
            </p>
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
              disabled={locked}
              onChange={({ start, end }) => {
                setStartDate(start);
                setEndDate(end);
              }}
            />
          </div>
        )}

        {/* A new staff booking's comment: inside the form, Enter adds a line */}
        {showCommentField && (
          <div className={styles.formGroup}>
            <label htmlFor={commentFieldId} className={styles.fieldLabel}>
              {commentLabel}
            </label>
            <MentionTextarea
              id={commentFieldId}
              value={commentDraft}
              anchors={commentAnchors}
              onChange={(text, next) => {
                setCommentDraft(text);
                setCommentAnchors(next);
              }}
              candidates={commentCandidates}
              rows={3}
              disabled={isSubmitting}
              targetGroupLabel={assignmentLevel === 'project' ? 'On this project' : 'On this card'}
              placeholder={commentPlaceholder}
            />
            {commentHint && <span className={styles.fieldHint}>{commentHint}</span>}
          </div>
        )}

        {/* An equipment booking's note (create and edit) */}
        {!isStaff && (
          <Input
            label="Note (optional)"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            fullWidth
          />
        )}
      </form>

      {/* Outside the form: a Comment click must never submit the booking. */}
      {showComments && commentEntityId && projectId && (
        <div className={styles.comments}>
          <CardComments
            key={`${assignmentLevel}:${commentEntityId}`}
            entityType={assignmentLevel}
            entityId={commentEntityId}
            projectId={projectId}
            siteId={dialogProject?.site_id}
            participants={targetItem?.staffAssignments ?? []}
            meUserId={currentUser?.id}
          />
        </div>
      )}
    </Modal>
  );
}
