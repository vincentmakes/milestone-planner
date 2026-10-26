/**
 * A comment thread with @-mentions: a phase / subphase card's (shared by the
 * Kanban card dialog and the Gantt booking dialog) or a project's (the
 * booking dialog of a project-level booking).
 *
 * It owns the thread, the composer (`MentionTextarea`), posting and deleting
 * (asked first with `confirmAction`; offered to the author, or to anyone
 * holding `kanban.moderate_comments`), its own submit guard and its own error
 * Notice — so a dialog around it keeps its own busy state and messages. The
 * composer always shows; without `kanban.comment` the server's refusal shows
 * in the Notice. Mention candidates are the people on the target first
 * (`participants`), then everyone mentionable at the site (cached per site
 * for the session, `useMentionCandidates`), never yourself.
 *
 * Every button is `type="button"`: a host may render the thread next to its
 * own form, and a submit button would send that form. Render it OUTSIDE any
 * `<form>` anyway (the booking dialog does) — a textarea inside one is fine,
 * but nothing here is meant to submit it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/common/Button';
import { Notice } from '@/components/common/Notice';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { MentionText, MentionTextarea } from '@/components/common/MentionTextarea';
import { Icon, CloseIcon } from '@/components/common/Icon';
import {
  createComment,
  deleteComment,
  getComments,
  type CardComment,
  type CommentEntityType,
} from '@/api/endpoints/kanban';
import { useHasPermission } from '@/hooks/useCan';
import { useMentionCandidates } from '@/hooks/useMentionCandidates';
import { mentionedUserIds, serializeMentions, type MentionAnchor } from '@/utils/mentions';
import { confirmAction } from '@/utils/confirmDialog';
import type { StaffAssignment } from '@/types';
import styles from './CardComments.module.css';

export interface CardCommentsProps {
  /** The thread: a card ('phase' | 'subphase') or a project */
  entityType: CommentEntityType;
  /** The card's id, or the project's for a project thread */
  entityId: number;
  /** The project the thread belongs to */
  projectId: number;
  /** The project's site: whose people may be mentioned (none when unknown) */
  siteId: number | null | undefined;
  /** The bookings on the target: their people come first in the mention picker */
  participants: readonly StaffAssignment[];
  /** The signed-in user: their own mentions render highlighted, they are never a candidate */
  meUserId: number | null | undefined;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function CardComments({
  entityType,
  entityId,
  projectId,
  siteId,
  participants,
  meUserId,
}: CardCommentsProps) {
  const canModerate = useHasPermission('kanban.moderate_comments');
  const [comments, setComments] = useState<CardComment[]>([]);
  const [draft, setDraft] = useState('');
  const [anchors, setAnchors] = useState<MentionAnchor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { isSubmitting: busy, begin, end } = useSubmitGuard();

  const reloadComments = useCallback(async () => {
    try {
      setComments(await getComments(entityType, entityId));
    } catch (err) {
      console.error('[Comments] Failed to load comments:', err);
    }
  }, [entityType, entityId]);

  // A new thread starts clean: no comments of the previous one, no draft.
  useEffect(() => {
    setComments([]);
    setDraft('');
    setAnchors([]);
    setError(null);
    void reloadComments();
  }, [reloadComments, projectId]);

  const mentionCandidates = useMentionCandidates(siteId, participants, meUserId);

  const handleComment = async () => {
    if (!draft.trim()) return;
    if (!begin()) return; // a post or a delete is still running
    setError(null);
    try {
      // Serialize first, then trim: trimming the draft would shift every anchor
      // offset. Only picked mentions carry an anchor, so a hand-typed "@Alice"
      // stays plain text and notifies nobody.
      const body = serializeMentions(draft, anchors).trim();
      await createComment(entityType, entityId, body, mentionedUserIds(draft, anchors));
      setDraft('');
      setAnchors([]);
      // Only the thread changed -- do NOT reload every project for a comment.
      await reloadComments();
    } catch (err) {
      setError(message(err, 'Could not post the comment'));
    } finally {
      end();
    }
  };

  const handleDelete = async (commentId: number) => {
    if (
      !(await confirmAction({
        title: 'Delete comment',
        message: 'Delete this comment? This cannot be undone.',
        destructive: true,
      }))
    )
      return;
    if (!begin()) return;
    setError(null);
    try {
      await deleteComment(commentId);
      await reloadComments();
    } catch (err) {
      setError(message(err, 'Could not delete the comment'));
    } finally {
      end();
    }
  };

  return (
    <section className={styles.section} aria-label="Comments">
      <h3 className={styles.heading}>Comments</h3>
      {error && <Notice tone="error">{error}</Notice>}
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
              {((c.author_id != null && c.author_id === meUserId) || canModerate) && (
                <button
                  type="button"
                  className={styles.removeBtn}
                  onClick={() => void handleDelete(c.id)}
                  disabled={busy}
                  aria-label="Delete comment"
                >
                  <Icon icon={CloseIcon} size={14} />
                </button>
              )}
            </div>
            <p className={styles.commentBody}>
              <MentionText body={c.body} meUserId={meUserId ?? undefined} />
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
          targetGroupLabel={entityType === 'project' ? 'On this project' : 'On this card'}
          placeholder="Add a comment. Type @ to notify someone."
        />
        <Button type="button" onClick={() => void handleComment()} disabled={busy || !draft.trim()}>
          Comment
        </Button>
      </div>
    </section>
  );
}
