/**
 * Kanban card detail: status, assignees (which book time) and the comment thread.
 *
 * Uses the shared Modal, which enforces the no-backdrop-close rule -- clicking
 * outside must never discard an in-progress comment.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button, Select } from '@/components/common';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { AllocationSlider } from '@/components/common/AllocationSlider';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { useTeamFilter } from '@/hooks/useTeamFilter';
import { loadAllProjects, updateStaffAssignment } from '@/api/endpoints/projects';
import {
  assignCard,
  createComment,
  deleteComment,
  getComments,
  getMentionableUsers,
  moveCard,
  unassignCard,
  type CardComment,
  type MentionableUser,
} from '@/api/endpoints/kanban';
import {
  CARD_STATUSES,
  STATUS_LABELS,
  applyStatusToCard,
  collectProjectCards,
  isPendingAssignment,
  requestedAllocation,
  type KanbanCard,
} from '@/utils/kanbanCards';
import {
  buildMentionCandidates,
  mentionedUserIds,
  serializeMentions,
  type MentionAnchor,
} from '@/utils/mentions';
import { MentionText, MentionTextarea } from '@/components/common/MentionTextarea';
import { formatDateShort, parseDateISO } from '@/utils/date';
import { can, canEditAssignment, canSelf, isSelf, needsApproval } from '@/utils/permissions';
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
import type { CardStatus } from '@/types';
import styles from './KanbanCardModal.module.css';
import { confirmAction } from '@/utils/confirmDialog';

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

  const [comments, setComments] = useState<CardComment[]>([]);
  const [draft, setDraft] = useState('');
  const [anchors, setAnchors] = useState<MentionAnchor[]>([]);
  const { isSubmitting: busy, begin: begin, end: end } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);
  const [assigneeToAdd, setAssigneeToAdd] = useState<string>('');
  // Mentionable people are fetched per site rather than taken from the staff
  // slice, which excludes administrators.
  const [mentionable, setMentionable] = useState<{ siteId: number; users: MentionableUser[] } | null>(
    null
  );

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

  // Deleting someone else's comment (editing stays with the author).
  const canModerate = can(currentUser, 'kanban.moderate_comments');
  // Whoever manages others' bookings on the project (the key, or its manager)
  // adds and removes assignees; everyone else joins or leaves themself.
  const isEditor = can(currentUser, 'assignments.manage_others', project);
  // Approved on the card (moves it, gets reminders); a pending join does not count.
  const isAssigned = Boolean(currentUser && card?.assigneeIds.includes(currentUser.id));
  // On the card in any way, approved or awaiting approval (no second Join).
  const isOnCard = Boolean(currentUser && (isAssigned || card?.pendingAssigneeIds.includes(currentUser.id)));
  // Own bookings follow the role's assignments.self_* keys (allow, approval, or denied).
  const canJoin = canSelf(currentUser, 'assignments.self_create');
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

  const mentionCandidates = useMemo(
    () =>
      buildMentionCandidates(
        card?.assignments ?? [],
        (mentionable?.users ?? []).map((u) => ({
          id: u.id,
          name: u.name,
          role: u.job_title ?? undefined,
        })),
        // Mentioning yourself would render a pill that notifies nobody.
        currentUser?.id
      ),
    [card?.assignments, mentionable, currentUser?.id]
  );

  const reloadComments = useCallback(async () => {
    if (!cardEntityType || !cardEntityId) return;
    try {
      setComments(await getComments(cardEntityType, cardEntityId));
    } catch (err) {
      console.error('[Kanban] Failed to load comments:', err);
    }
  }, [cardEntityType, cardEntityId]);

  // One request per site per session: the component stays mounted between
  // card opens, so reopening cards in the same site reuses the list.
  useEffect(() => {
    const siteId = project?.site_id;
    if (!isOpen || siteId === undefined || siteId === null) return;
    if (mentionable?.siteId === siteId) return;
    let cancelled = false;
    getMentionableUsers(siteId)
      .then((users) => {
        if (!cancelled) setMentionable({ siteId, users });
      })
      .catch((err) => console.error('[Kanban] Failed to load mentionable users:', err));
    return () => {
      cancelled = true;
    };
  }, [isOpen, project?.site_id, mentionable?.siteId]);

  useEffect(() => {
    if (!isOpen) {
      setComments([]);
      setDraft('');
      setAnchors([]);
      setError(null);
      setAssigneeToAdd('');
      return;
    }
    void reloadComments();
  }, [isOpen, reloadComments]);

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

  const handleUnassign = async (staffId: number, staffName?: string | null) => {
    if (!card) return;
    // Removing an assignee deletes their booking (allocation and dates) and
    // cannot be undone -- confirm like the Gantt assignment dialog does.
    const who = staffName ? `"${staffName}"` : 'this assignee';
    const asRequest = !isEditor && isSelf(currentUser, staffId) && needsApproval(currentUser, 'assignments.self_remove');
    if (
      !(await confirmAction({
        title: 'Remove assignee',
        message: asRequest
          ? 'Ask to leave this card? Your removal will be sent for approval.'
          : `Remove ${who} from this card? Their booking on it will be deleted.`,
        destructive: true,
      }))
    )
      return;
    if (!begin()) return; // another write on this card is still running
    setError(null);
    try {
      const res = await unassignCard(card.entityType, card.entityId, staffId);
      const removed = card.assignments.find((a) => a.staff_id === staffId);
      if (isPendingResponse(res)) {
        // Sent for approval: the booking stays until someone decides.
        if (removed && currentUser) {
          markRequestPendingLocally(card.projectId, removed.id, card.entityType, currentUser.id,
            'assignments.self_remove', res, null);
        }
        flashSentForApproval();
      } else if (removed) {
        removeStaffAssignmentLocally(card.projectId, removed.id, card.entityType);
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

  const handleComment = async () => {
    if (!card || !draft.trim()) return;
    if (!begin()) return; // another write on this card is still running
    setError(null);
    try {
      // Serialize first, then trim: trimming the draft would shift every anchor
      // offset. Only picked mentions carry an anchor, so a hand-typed "@Alice"
      // stays plain text and notifies nobody.
      const body = serializeMentions(draft, anchors).trim();
      await createComment(card.entityType, card.entityId, body, mentionedUserIds(draft, anchors));
      setDraft('');
      setAnchors([]);
      // Only the thread changed -- do NOT reload every project for a comment.
      await reloadComments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the comment');
    } finally {
      end();
    }
  };

  const handleDeleteComment = async (commentId: number) => {
    if (
      !(await confirmAction({
        title: 'Delete comment',
        message: 'Delete this comment? This cannot be undone.',
        destructive: true,
      }))
    )
      return;
    if (!begin()) return; // another write on this card is still running
    try {
      await deleteComment(commentId);
      await reloadComments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the comment');
    } finally {
      end();
    }
  };

  // On a card of the current site, candidates also follow the header team
  // filter; a card of another site (opened from the cross-site view) lists
  // everyone there.
  const filterByTeam = project?.site_id === filterSiteId;
  const unassignedStaff = siteStaff.filter(
    (s) =>
      !card?.assigneeIds.includes(s.id) &&
      !card?.pendingAssigneeIds.includes(s.id) &&
      (!filterByTeam || staffMatches(s))
  );
  // After the early return, so no useMemo; the empty entry stays selectable (as before).
  const assigneeOptions = [
    { value: '', label: 'Add someone…' },
    ...unassignedStaff.map((s) => ({
      value: s.id,
      label: `${s.name} (books ${s.max_capacity ?? 100}%)`,
    })),
  ];

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
                          onClick={() => handleUnassign(a.staff_id, a.staff_name)}
                          disabled={busy}
                          aria-label={`Remove ${a.staff_name ?? 'assignee'}`}
                        >
                          &times;
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

            {isEditor && unassignedStaff.length > 0 && (
              <div className={styles.assignRow}>
                <Select
                  className={styles.assigneeSelect}
                  value={assigneeToAdd}
                  onChange={(e) => setAssigneeToAdd(e.target.value)}
                  aria-label="Add assignee"
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

          <section className={styles.section}>
            <h3 className={styles.heading}>Comments</h3>
            <ul className={styles.comments}>
              {comments.map((c) => (
                <li key={c.id} className={styles.comment}>
                  <div className={styles.commentHead}>
                    {/* author_id/author_name are null once the author's account is deleted */}
                    <span className={`${styles.author} ${c.author_name == null ? styles.deletedAuthor : ''}`}>
                      {c.author_name ?? 'Deleted user'}
                    </span>
                    <span className={styles.commentDate}>
                      {new Date(c.created_at).toLocaleString()}
                      {c.edited && ' (edited)'}
                    </span>
                    {((c.author_id != null && c.author_id === currentUser?.id) || canModerate) && (
                      <button
                        type="button"
                        className={styles.removeBtn}
                        onClick={() => handleDeleteComment(c.id)}
                        disabled={busy}
                        aria-label="Delete comment"
                      >
                        &times;
                      </button>
                    )}
                  </div>
                  <p className={styles.commentBody}>
                    <MentionText body={c.body} meUserId={currentUser?.id} />
                  </p>
                </li>
              ))}
              {comments.length === 0 && <li className={styles.none}>No comments yet</li>}
            </ul>

            <div className={styles.composer}>
              <MentionTextarea
                value={draft}
                anchors={anchors}
                onChange={(text, next) => {
                  setDraft(text);
                  setAnchors(next);
                }}
                candidates={mentionCandidates}
                rows={3}
                disabled={busy}
                aria-label="Comment"
                placeholder="Add a comment. Type @ to notify someone."
              />
              <Button onClick={handleComment} disabled={busy || !draft.trim()}>
                Comment
              </Button>
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}
