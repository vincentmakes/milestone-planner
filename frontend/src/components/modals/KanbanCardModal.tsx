/**
 * Kanban card detail: status, assignees (which book time) and the comment thread.
 *
 * Uses the shared Modal, which enforces the no-backdrop-close rule -- clicking
 * outside must never discard an in-progress comment.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common';
import { AllocationSlider } from '@/components/common/AllocationSlider';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
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
  collectProjectCards,
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
import type { CardStatus } from '@/types';
import styles from './KanbanCardModal.module.css';

export function KanbanCardModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalContext = useUIStore((s) => s.modalContext);
  const closeModal = useUIStore((s) => s.closeModal);

  const projects = useAppStore((s) => s.projects);
  const staff = useAppStore((s) => s.staff);
  const currentUser = useAppStore((s) => s.currentUser);
  const setProjects = useAppStore((s) => s.setProjects);

  const [comments, setComments] = useState<CardComment[]>([]);
  const [draft, setDraft] = useState('');
  const [anchors, setAnchors] = useState<MentionAnchor[]>([]);
  const [busy, setBusy] = useState(false);
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

  const isPrivileged = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  const canMove = Boolean(
    isPrivileged || (currentUser && card?.assigneeIds.includes(currentUser.id))
  );

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
    setBusy(true);
    setError(null);
    try {
      await moveCard(card.entityType, card.entityId, status);
      setProjects(await loadAllProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the status');
    } finally {
      setBusy(false);
    }
  };

  const handleAssign = async () => {
    if (!card || !assigneeToAdd) return;
    setBusy(true);
    setError(null);
    try {
      await assignCard(card.entityType, card.entityId, Number(assigneeToAdd));
      setAssigneeToAdd('');
      setProjects(await loadAllProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign');
    } finally {
      setBusy(false);
    }
  };

  const handleAllocationChange = async (assignmentId: number, allocation: number) => {
    if (!card) return;
    setBusy(true);
    setError(null);
    try {
      // Cards are phases and subphases, so the level is the card's own type --
      // never the project-level route.
      await updateStaffAssignment(assignmentId, { allocation }, card.entityType);
      setProjects(await loadAllProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the allocation');
    } finally {
      setBusy(false);
    }
  };

  const handleUnassign = async (staffId: number) => {
    if (!card) return;
    setBusy(true);
    setError(null);
    try {
      await unassignCard(card.entityType, card.entityId, staffId);
      setProjects(await loadAllProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the assignment');
    } finally {
      setBusy(false);
    }
  };

  const handleComment = async () => {
    if (!card || !draft.trim()) return;
    setBusy(true);
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
      setBusy(false);
    }
  };

  const handleDeleteComment = async (commentId: number) => {
    setBusy(true);
    try {
      await deleteComment(commentId);
      await reloadComments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the comment');
    } finally {
      setBusy(false);
    }
  };

  const unassignedStaff = siteStaff.filter((s) => !card?.assigneeIds.includes(s.id));

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
                return (
                  <li key={a.id} className={styles.assignee}>
                    <span className={styles.assigneeName}>
                      {a.staff_name ?? `Staff ${a.staff_id}`}
                    </span>
                    {isPrivileged ? (
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
                    ) : (
                      <span className={`${styles.allocation} ${over ? styles.allocationOver : ''}`}>
                        {a.allocation}%
                      </span>
                    )}
                    {isPrivileged && (
                      <button
                        type="button"
                        className={styles.removeBtn}
                        onClick={() => handleUnassign(a.staff_id)}
                        disabled={busy}
                        aria-label={`Remove ${a.staff_name ?? 'assignee'}`}
                      >
                        &times;
                      </button>
                    )}
                  </li>
                );
              })}
              {card.assignments.length === 0 && <li className={styles.none}>Nobody assigned</li>}
            </ul>

            {isPrivileged && unassignedStaff.length > 0 && (
              <div className={styles.assignRow}>
                <select
                  className={styles.select}
                  value={assigneeToAdd}
                  onChange={(e) => setAssigneeToAdd(e.target.value)}
                  aria-label="Add assignee"
                >
                  <option value="">Add someone&hellip;</option>
                  {unassignedStaff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} (books {s.max_capacity ?? 100}%)
                    </option>
                  ))}
                </select>
                <Button onClick={handleAssign} disabled={busy || !assigneeToAdd}>
                  Assign
                </Button>
              </div>
            )}
          </section>

          <section className={styles.section}>
            <h3 className={styles.heading}>Comments</h3>
            <ul className={styles.comments}>
              {comments.map((c) => (
                <li key={c.id} className={styles.comment}>
                  <div className={styles.commentHead}>
                    <span className={styles.author}>{c.author_name ?? 'Unknown'}</span>
                    <span className={styles.commentDate}>
                      {new Date(c.created_at).toLocaleString()}
                      {c.edited && ' (edited)'}
                    </span>
                    {(c.author_id === currentUser?.id || isPrivileged) && (
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
