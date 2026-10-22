/**
 * A single Kanban card: one leaf phase or subphase.
 */

import { useMemo } from 'react';
import type { KanbanCard as KanbanCardData } from '@/utils/kanbanCards';
import { dueStateOf } from '@/utils/kanbanCards';
import { formatDateShort, parseDateISO } from '@/utils/date';
import { avatarColorFor } from '@/utils/avatarColor';
import { isPendingAssignment } from '@/utils/kanbanCards';
import { groupCardBookings } from '@/utils/bookingSegments';
import { PendingBadge } from '@/components/common/PendingBadge';
import { useAppStore } from '@/stores/appStore';
import styles from './KanbanCard.module.css';
import { Icon, CommentIcon } from '@/components/common/Icon';

interface KanbanCardProps {
  card: KanbanCardData;
  commentCount: number;
  /** Whether this user may drag the card between columns. */
  canMove: boolean;
  onOpen: (card: KanbanCardData) => void;
  onDragStart?: (e: React.DragEvent, card: KanbanCardData) => void;
  onDragEnd?: () => void;
  isDragging?: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function KanbanCard({
  card,
  commentCount,
  canMove,
  onOpen,
  onDragStart,
  onDragEnd,
  isDragging = false,
}: KanbanCardProps) {
  const due = useMemo(() => dueStateOf(card), [card]);
  // My own booking on the card awaits approval (My Todo lists such cards).
  const myId = useAppStore((s) => s.currentUser?.id);
  const myPendingRow =
    myId !== undefined && card.pendingAssigneeIds.includes(myId)
      ? card.assignments.find((a) => a.staff_id === myId && isPendingAssignment(a))
      : undefined;

  const classNames = [
    styles.card,
    isDragging ? styles.dragging : '',
    canMove ? styles.draggable : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classNames}
      style={{ borderLeftColor: card.color }}
      draggable={canMove}
      onDragStart={canMove && onDragStart ? (e) => onDragStart(e, card) : undefined}
      onDragEnd={canMove ? onDragEnd : undefined}
      onClick={() => onOpen(card)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(card);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${card.name}${card.isMilestone ? ' (milestone)' : ''}`}
      data-card-key={card.key}
    >
      <div className={styles.header}>
        {card.isMilestone && (
          <span className={styles.milestone} title="Milestone" aria-hidden="true" />
        )}
        <span className={styles.name}>{card.name}</span>
      </div>

      {card.swimlanePhaseName && <div className={styles.breadcrumb}>{card.path}</div>}

      <div className={styles.dates}>
        {formatDateShort(parseDateISO(card.startDate))} &ndash;{' '}
        {formatDateShort(parseDateISO(card.endDate))}
        {due && (
          <span className={due === 'overdue' ? styles.overdue : styles.dueSoon}>
            {due === 'overdue' ? 'Overdue' : 'Due soon'}
          </span>
        )}
        {myPendingRow && <PendingBadge assignment={myPendingRow} projectId={card.projectId} />}
      </div>

      {card.completion !== null && card.completion > 0 && (
        <div className={styles.progressTrack} title={`${card.completion}% complete`}>
          <div
            className={styles.progressFill}
            style={{ width: `${Math.min(100, Math.max(0, card.completion))}%` }}
          />
        </div>
      )}

      <div className={styles.footer}>
        <div className={styles.avatars}>
          {/* One avatar per person: someone may hold several bookings (segments) on a card */}
          {Array.from(groupCardBookings(card.assignments), ([staffId, rows]) => {
            // Dashed only while none of their bookings is approved yet
            const pending = rows.every((a) => isPendingAssignment(a));
            const name = rows[0].staff_name;
            return (
              <span
                key={staffId}
                className={pending ? `${styles.avatar} ${styles.pendingAvatar}` : styles.avatar}
                style={{ background: avatarColorFor(staffId) }}
                title={`${name ?? 'Staff'} - ${rows.map((a) => `${a.allocation}%`).join(', ')}${pending ? ' (pending approval)' : ''}`}
              >
                {initials(name ?? '?')}
              </span>
            );
          })}
        </div>
        {commentCount > 0 && (
          <span className={styles.comments} title={`${commentCount} comment(s)`}>
            <Icon icon={CommentIcon} size={12} />
            {commentCount}
          </span>
        )}
      </div>
    </div>
  );
}
