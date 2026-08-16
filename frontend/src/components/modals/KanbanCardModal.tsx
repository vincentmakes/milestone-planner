/**
 * Kanban card detail: status, assignees (which book time) and the comment thread.
 *
 * Uses the shared Modal, which enforces the no-backdrop-close rule -- clicking
 * outside must never discard an in-progress comment.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { loadAllProjects } from '@/api/endpoints/projects';
import {
  assignCard,
  createComment,
  deleteComment,
  getComments,
  moveCard,
  unassignCard,
  type CardComment,
} from '@/api/endpoints/kanban';
import {
  CARD_STATUSES,
  STATUS_LABELS,
  collectProjectCards,
  type KanbanCard,
} from '@/utils/kanbanCards';
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assigneeToAdd, setAssigneeToAdd] = useState<string>('');

  const isOpen = activeModal === 'kanbanCard';
  const { cardEntityType, cardEntityId, cardProjectId } = modalContext;

  // Derive the card from the store so it stays live through WebSocket refetches.
  const card: KanbanCard | null = useMemo(() => {
    if (!isOpen || !cardEntityType || !cardEntityId) return null;
    const project = projects.find((p) => p.id === cardProjectId);
    if (!project) return null;
    return (
      collectProjectCards(project).find(
        (c) => c.entityType === cardEntityType && c.entityId === cardEntityId
      ) ?? null
    );
  }, [isOpen, cardEntityType, cardEntityId, cardProjectId, projects]);

  const isPrivileged = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  const canMove = Boolean(
    isPrivileged || (currentUser && card?.assigneeIds.includes(currentUser.id))
  );

  const reloadComments = useCallback(async () => {
    if (!cardEntityType || !cardEntityId) return;
    try {
      setComments(await getComments(cardEntityType, cardEntityId));
    } catch (err) {
      console.error('[Kanban] Failed to load comments:', err);
    }
  }, [cardEntityType, cardEntityId]);

  useEffect(() => {
    if (!isOpen) {
      setComments([]);
      setDraft('');
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
      // @mentions are matched against staff names in the composed text.
      const mentioned = staff
        .filter((s) => draft.includes(`@${s.name}`))
        .map((s) => s.id);
      await createComment(card.entityType, card.entityId, draft.trim(), mentioned);
      setDraft('');
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

  const unassignedStaff = staff.filter((s) => !card?.assigneeIds.includes(s.id));

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
              {card.assignments.map((a) => (
                <li key={a.id} className={styles.assignee}>
                  <span>{a.staff_name ?? `Staff ${a.staff_id}`}</span>
                  <span className={styles.allocation}>{a.allocation}%</span>
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
              ))}
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
                  <p className={styles.commentBody}>{c.body}</p>
                </li>
              ))}
              {comments.length === 0 && <li className={styles.none}>No comments yet</li>}
            </ul>

            <div className={styles.composer}>
              <textarea
                className={styles.textarea}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add a comment. Type @ and a name to notify someone."
                rows={3}
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
