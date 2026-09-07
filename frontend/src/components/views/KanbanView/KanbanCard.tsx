/**
 * A single Kanban card: one leaf phase or subphase.
 */

import { useMemo } from 'react';
import type { KanbanCard as KanbanCardData } from '@/utils/kanbanCards';
import { dueStateOf } from '@/utils/kanbanCards';
import { formatDateShort, parseDateISO } from '@/utils/date';
import styles from './KanbanCard.module.css';

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

/** Deterministic avatar colour, matching OnlineUsers/ActivityFeed. */
function avatarColorIndex(staffId: number): number {
  return staffId % 8;
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
          {card.assignments.map((a) => (
            <span
              key={a.id}
              className={`${styles.avatar} ${styles[`avatar${avatarColorIndex(a.staff_id)}`]}`}
              title={`${a.staff_name ?? 'Staff'} - ${a.allocation}%`}
            >
              {initials(a.staff_name ?? '?')}
            </span>
          ))}
        </div>
        {commentCount > 0 && (
          <span className={styles.comments} title={`${commentCount} comment(s)`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {commentCount}
          </span>
        )}
      </div>
    </div>
  );
}
