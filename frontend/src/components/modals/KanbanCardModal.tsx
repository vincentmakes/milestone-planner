/**
 * Kanban card detail: status, assignees (which book time) and the comment thread.
 *
 * Uses the shared Modal, which enforces the no-backdrop-close rule -- clicking
 * outside must never discard an in-progress comment.
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button, SearchableSelect } from '@/components/common';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { AllocationSlider } from '@/components/common/AllocationSlider';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { useTeamFilter } from '@/hooks/useTeamFilter';
import { deleteStaffAssignment, loadAllProjects, updateStaffAssignment } from '@/api/endpoints/projects';
import { assignCard, moveCard } from '@/api/endpoints/kanban';
import {
  CARD_STATUSES,
  STATUS_LABELS,
  applyStatusToCard,
  collectProjectCards,
  isPendingAssignment,
  requestedAllocation,
  type KanbanCard,
} from '@/utils/kanbanCards';
import { CardComments } from '@/components/common/CardComments';
import { formatDateShort, formatMediumDate, parseDateISO, toDateOnly } from '@/utils/date';
import { isUnlinkedBooking } from '@/utils/bookingSegments';
import { can, canBookSelf, canEditAssignment, isSelf, needsApproval } from '@/utils/permissions';
import { approvalsApi, isPendingResponse } from '@/api/endpoints/approvals';
import { ApprovalActions } from '@/components/common/ApprovalActions';
import { PendingBadge } from '@/components/common/PendingBadge';
import { flashSentForApproval, markRequestPendingLocally } from '@/utils/pendingBookings';
import { findSubphaseById } from '@/utils/subphaseUtils';
import {
  patchStaffAssignmentLocally,
  removeStaffAssignmentLocally,
  updateProjectLocally,
} from '@/utils/localProjectTree';
import { whatIfUnavailableMessage } from '@/utils/whatIf';
import type { CardStatus, StaffAssignment } from '@/types';
import styles from './KanbanCardModal.module.css';
import { confirmAction } from '@/utils/confirmDialog';
import { Icon, CloseIcon } from '@/components/common/Icon';

export function KanbanCardModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalContext = useUIStore((s) => s.modalContext);
  const closeModal = useUIStore((s) => s.closeModal);

  const projects = useAppStore((s) => s.projects);
  const staff = useAppStore((s) => s.staff);
  const currentUser = useAppStore((s) => s.currentUser);
  const setProjects = useAppStore((s) => s.setProjects);
  // The header team filter belongs to the current site (`filterSiteId`).
  const { siteId: filterSiteId, staffMatches } = useTeamFilter();
  // Adding an assignee creates a booking, which cannot show until Apply in
  // What-If mode; moving, re-allocating and removing stay available.
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  const assignBlockedReason = whatIfMode ? whatIfUnavailableMessage('Adding assignees') : null;
  // Approval decisions are real writes outside the sandbox.
  const decideBlockedReason = whatIfMode ? whatIfUnavailableMessage('Approval decisions') : null;

  // One write at a time on the card (status, assignees); the comment thread
  // has its own guard and error (CardComments).
  const { isSubmitting: busy, begin: begin, end: end } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  const [assigneeToAdd, setAssigneeToAdd] = useState<string>('');

  const isOpen = activeModal === 'kanbanCard';
  const { cardEntityType, cardEntityId, cardProjectId } = modalContext;

  // Derive the card from the store so it stays live through WebSocket refetches.
  const project = useMemo(
    () => projects.find((p) => p.id === cardProjectId) ?? null,
    [projects, cardProjectId]
  );

  const card: KanbanCard | null = useMemo(() => {
    if (!isOpen || !cardEntityType || !cardEntityId) return null;
    if (!project) return null;
    return (
      collectProjectCards(project).find(
        (c) => c.entityType === cardEntityType && c.entityId === cardEntityId
      ) ?? null
    );
  }, [isOpen, cardEntityType, cardEntityId, project]);

  // Whoever manages others' bookings on the project (the key, or its manager)
  // adds and removes assignees; everyone else joins or leaves themself.
  const isEditor = can(currentUser, 'assignments.manage_others', project);
  // Approved on the card (moves it, gets reminders); a pending join does not count.
  const isAssigned = Boolean(currentUser && card?.assigneeIds.includes(currentUser.id));
  // On the card in any way, approved or awaiting approval (no second Join).
  const isOnCard = Boolean(currentUser && (isAssigned || card?.pendingAssigneeIds.includes(currentUser.id)));
  // Own bookings follow the role's assignments.self_* keys (allow, approval, or
  // denied), and only someone bookable as a resource may join (else 400).
  const canJoin = canBookSelf(currentUser, currentUser?.id);
  const joinNeedsApproval = needsApproval(currentUser, 'assignments.self_create');
  // Mirrors app/services/card_access.py: any card, or the cards I am on.
  const canMove =
    can(currentUser, 'kanban.move_any', project) || (isAssigned && can(currentUser, 'kanban.move_assigned'));

  // staff holds one row per user-site pair, so scope to the CARD's site (not
  // currentSite -- the modal opens from the cross-site view too) and dedupe.
  const siteStaff = useMemo(() => {
    const siteId = project?.site_id;
    const byId = new Map<number, (typeof staff)[number]>();
    for (const s of staff) {
      if (siteId !== undefined && s.site_id !== siteId) continue;
      if (!byId.has(s.id)) byId.set(s.id, s);
    }
    return Array.from(byId.values());
  }, [staff, project?.site_id]);

  // Assignees can include people absent from `siteStaff` (an admin booked on a
  // card), so a missing entry means "no capacity to compare against", not 100.
  const capacityById = useMemo(() => {
    const byId = new Map<number, number>();
    for (const s of siteStaff) {
      if (s.max_capacity !== undefined && s.max_capacity !== null) byId.set(s.id, s.max_capacity);
    }
    return byId;
  }, [siteStaff]);

  // Closing forgets the card's error and the half-picked assignee (the
  // comment draft goes with the thread, which unmounts).
  useEffect(() => {
    if (isOpen) return;
    setError(null);
    setAssigneeToAdd('');
  }, [isOpen]);

  if (!isOpen) return null;

  const handleStatusChange = async (status: CardStatus) => {
    if (!card || status === card.status) return;
    if (!begin()) return; // another write on this card is still running
    setError(null);
    try {
      await moveCard(card.entityType, card.entityId, status);
      // Show the move right away (the reload below is a no-op in What-If).
      updateProjectLocally(card.projectId, (p) => {
        const item =
          card.entityType === 'phase'
            ? p.phases?.find((ph) => ph.id === card.entityId)
            : findSubphaseById(p.phases ?? [], card.entityId);
        if (item) applyStatusToCard(item, status);
      });
      setProjects(await loadAllProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the status');
    } finally {
      end();
    }
  };

  const handleAssign = async () => {
    if (!card || !assigneeToAdd || assignBlockedReason) return;
    if (!begin()) return; // another write on this card is still running
    setError(null);
    try {
      await assignCard(card.entityType, card.entityId, Number(assigneeToAdd));
      setAssigneeToAdd('');
      setProjects(await loadAllProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign');
    } finally {
      end();
    }
  };

  // Self-assignment: anyone may join a card, which books their own time at
  // their max capacity (resolved server-side, like every other assignment).
  const handleJoin = async () => {
    if (!card || !currentUser || assignBlockedReason) return;
    if (!begin()) return; // another write on this card is still running
    setError(null);
    try {
      const res = await assignCard(card.entityType, card.entityId, currentUser.id);
      setProjects(await loadAllProjects());
      if (isPendingResponse(res)) flashSentForApproval();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join the card');
    } finally {
      end();
    }
  };

  const handleAllocationChange = async (assignmentId: number, allocation: number) => {
    if (!card) return;
    if (!begin()) return; // another write on this card is still running
    setError(null);
    try {
      // Cards are phases and subphases, so the level is the card's own type --
      // never the project-level route.
      const res = await updateStaffAssignment(assignmentId, { allocation }, card.entityType);
      if (isPendingResponse(res)) {
        // Sent for approval: the slider stays at the current value, the
        // request shows next to it until someone decides.
        if (currentUser) {
          markRequestPendingLocally(card.projectId, assignmentId, card.entityType, currentUser.id,
            'assignments.self_update', res, { allocation });
        }
        flashSentForApproval();
      } else {
        patchStaffAssignmentLocally(card.projectId, assignmentId, card.entityType, { allocation });
      }
      setProjects(await loadAllProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the allocation');
    } finally {
      end();
    }
  };

  // One row at a time: a person may hold several bookings (segments) on a
  // card, so the row's own route removes exactly that one (the per-person
  // Kanban route answers 409 then).
  const handleRemoveRow = async (row: StaffAssignment) => {
    if (!card) return;
    // Removing an assignee deletes their booking (allocation and dates) and
    // cannot be undone -- confirm like the Gantt assignment dialog does.
    const who = row.staff_name ? `"${row.staff_name}"` : 'this assignee';
    const asRequest =
      !isEditor && isSelf(currentUser, row.staff_id) && needsApproval(currentUser, 'assignments.self_remove');
    const segment = isUnlinkedBooking(row)
      ? ` from ${formatMediumDate(toDateOnly(row.start_date))} to ${formatMediumDate(toDateOnly(row.end_date))}`
      : '';
    if (
      !(await confirmAction({
        title: 'Remove assignee',
        message: asRequest
          ? `Ask to leave this card${segment}? Your removal will be sent for approval.`
          : `Remove ${who} from this card${segment}? Their booking on it will be deleted.`,
        destructive: true,
      }))
    )
      return;
    if (!begin()) return; // another write on this card is still running
    setError(null);
    try {
      const res = await deleteStaffAssignment(row.id, card.entityType);
      if (isPendingResponse(res)) {
        // Sent for approval: the booking stays until someone decides.
        if (currentUser) {
          markRequestPendingLocally(card.projectId, row.id, card.entityType, currentUser.id,
            'assignments.self_remove', res, null);
        }
        flashSentForApproval();
      } else {
        removeStaffAssignmentLocally(card.projectId, row.id, card.entityType);
      }
      setProjects(await loadAllProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the assignment');
    } finally {
      end();
    }
  };

  // The requester withdraws their open request (booking, change or removal).
  const handleCancelRequest = async (requestId: number) => {
    if (!begin()) return;
    setError(null);
    try {
      await approvalsApi.cancel(requestId);
      setProjects(await loadAllProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel the request');
    } finally {
      end();
    }
  };

  // After a decision (or a 409: decided or expired meanwhile) show what happened.
  const reloadAfterDecision = async () => {
    try {
      setProjects(await loadAllProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reload the projects');
    }
  };

  // On a card of the current site, candidates also follow the header team
  // filter; a card of another site (opened from the cross-site view) lists
  // everyone there.
  // Someone already on the card stays a candidate: the server places a
  // second (dateless) booking itself — it halves the person's booking or
  // fills their largest free gap — or refuses with a 409 shown in place.
  // Not on a one-day card, which has no room for a second booking (the
  // server always refuses): there the people on it are left out.
  const filterByTeam = project?.site_id === filterSiteId;
  const onCard = (id: number) =>
    Boolean(card?.assigneeIds.includes(id) || card?.pendingAssigneeIds.includes(id));
  const oneDayCard = !!card?.startDate && card.startDate === card.endDate;
  const candidateStaff = siteStaff.filter(
    (s) => (!filterByTeam || staffMatches(s)) && !(oneDayCard && onCard(s.id))
  );
  // After the early return, so no useMemo. The picker's empty row stays
  // selectable (as before); the booking share is a note, never searched.
  const assigneeOptions = candidateStaff.map((s) => ({
    id: s.id,
    label: s.name,
    note: `books ${s.max_capacity ?? 100}%${onCard(s.id) ? ' — already on this card' : ''}`,
  }));

  return (
    <Modal
      isOpen={isOpen}
      onClose={closeModal}
      title={card ? card.name : 'Card'}
      size="lg"
      footer={<Button variant="secondary" onClick={closeModal}>Close</Button>}
    >
      {!card ? (
        <p className={styles.missing}>This card no longer exists.</p>
      ) : (
        <div className={styles.body}>
          {card.swimlanePhaseName && <div className={styles.path}>{card.path}</div>}

          <div className={styles.meta}>
            <span>
              {formatDateShort(parseDateISO(card.startDate))} &ndash;{' '}
              {formatDateShort(parseDateISO(card.endDate))}
            </span>
            {card.completion !== null && <span>{card.completion}% complete</span>}
            {card.isMilestone && <span className={styles.milestoneTag}>Milestone</span>}
          </div>

          {error && <div className={styles.error}>{error}</div>}

          <section className={styles.section}>
            <h3 className={styles.heading}>Status</h3>
            <div className={styles.statusRow}>
              {CARD_STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  className={`${styles.statusBtn} ${card.status === status ? styles.statusActive : ''}`}
                  onClick={() => handleStatusChange(status)}
                  disabled={busy || !canMove}
                  title={canMove ? undefined : 'Only assignees and managers can change the status'}
                >
                  {STATUS_LABELS[status]}
                </button>
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.heading}>Assignees</h3>
            <p className={styles.hint}>
              Assigning someone books their time over this card&apos;s dates.
            </p>
            <ul className={styles.assignees}>
              {card.assignments.map((a) => {
                const maxCapacity = capacityById.get(a.staff_id);
                const over = maxCapacity !== undefined && a.allocation > maxCapacity;
                const request = a.approval ?? null;
                const pending = isPendingAssignment(a);
                const isRequester = Boolean(request && currentUser && request.requester_id === currentUser.id);
                const requested = requestedAllocation(a);
                // A pending booking is its requester's to withdraw and a
                // decider's to approve or reject -- nobody edits it directly.
                // An open request on an approved row leaves editors in charge;
                // the requester withdraws it first.
                const locked = pending || isRequester;
                const canSlide = !locked && canEditAssignment(currentUser, project, a.staff_id);
                const canRemoveRow =
                  !locked && canEditAssignment(currentUser, project, a.staff_id, 'assignments.self_remove');
                const name = a.staff_name ?? `Staff ${a.staff_id}`;
                return (
                  <li key={a.id} className={`${styles.assignee} ${pending ? styles.assigneePending : ''}`}>
                    <span className={styles.assigneeName}>
                      {name}
                      {isUnlinkedBooking(a) && (
                        <span className={styles.segmentDates} title="Own dates inside this card">
                          {formatMediumDate(toDateOnly(a.start_date))} – {formatMediumDate(toDateOnly(a.end_date))}
                        </span>
                      )}
                      <PendingBadge assignment={a} projectId={card.projectId} className={styles.assigneeBadge} />
                    </span>
                    {canSlide ? (
                      <span className={styles.allocationCell}>
                        <AllocationSlider
                          compact
                          value={a.allocation}
                          maxCapacity={maxCapacity}
                          disabled={busy}
                          aria-label={`Allocation for ${a.staff_name ?? `staff ${a.staff_id}`}`}
                          // Commit on release only: a range input fires a change
                          // per step, and each one here is a write plus a reload.
                          onCommit={(pct) => handleAllocationChange(a.id, pct)}
                        />
                        {requested !== null && <span className={styles.requested}>requested {requested}%</span>}
                      </span>
                    ) : (
                      <span className={styles.allocationCell}>
                        <span className={`${styles.allocation} ${over ? styles.allocationOver : ''}`}>
                          {a.allocation}%
                        </span>
                        {requested !== null && <span className={styles.requested}>requested {requested}%</span>}
                      </span>
                    )}
                    <span className={styles.rowActions}>
                      {request?.can_decide && (
                        <ApprovalActions
                          requestId={request.request_id}
                          subject={name}
                          onDecided={reloadAfterDecision}
                          onError={setError}
                          disabledReason={decideBlockedReason}
                        />
                      )}
                      {request && isRequester && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleCancelRequest(request.request_id)}
                          disabled={busy || !!decideBlockedReason}
                          title={decideBlockedReason ?? undefined}
                        >
                          Cancel request
                        </Button>
                      )}
                      {canRemoveRow && (
                        <button
                          type="button"
                          className={styles.removeBtn}
                          onClick={() => handleRemoveRow(a)}
                          disabled={busy}
                          aria-label={`Remove ${a.staff_name ?? 'assignee'}`}
                        >
                          <Icon icon={CloseIcon} size={14} />
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
              {card.assignments.length === 0 && <li className={styles.none}>Nobody assigned</li>}
            </ul>

            {!isEditor && currentUser && !isOnCard && canJoin && (
              <div className={styles.assignRow}>
                <Button
                  onClick={handleJoin}
                  disabled={busy || !!assignBlockedReason}
                  title={assignBlockedReason ?? undefined}
                >
                  {joinNeedsApproval ? 'Request to join' : 'Join this card'}
                </Button>
              </div>
            )}

            {isEditor && candidateStaff.length > 0 && (
              <div className={styles.assignRow}>
                <SearchableSelect
                  className={styles.assigneeSelect}
                  value={assigneeToAdd === '' ? null : Number(assigneeToAdd)}
                  onChange={(id) => setAssigneeToAdd(id === null ? '' : String(id))}
                  aria-label="Add assignee"
                  emptyLabel="Add someone…"
                  disabled={!!assignBlockedReason}
                  title={assignBlockedReason ?? undefined}
                  options={assigneeOptions}
                />
                <Button onClick={handleAssign} disabled={busy || !assigneeToAdd || !!assignBlockedReason}>
                  Assign
                </Button>
              </div>
            )}

            {assignBlockedReason && (isEditor || (currentUser && !isAssigned)) && (
              <p className={styles.hint} role="status">{assignBlockedReason}</p>
            )}
          </section>

          <CardComments
            key={`${card.entityType}:${card.entityId}`}
            entityType={card.entityType}
            entityId={card.entityId}
            projectId={card.projectId}
            siteId={project?.site_id}
            participants={card.assignments}
            meUserId={currentUser?.id}
          />
        </div>
      )}
    </Modal>
  );
}
