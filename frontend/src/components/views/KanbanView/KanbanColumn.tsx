/**
 * One status column inside one swimlane. This is the drop target.
 */

import type { CardStatus } from '@/types';
import type { KanbanCard as KanbanCardData } from '@/utils/kanbanCards';
import { STATUS_LABELS } from '@/utils/kanbanCards';
import { KanbanCard } from './KanbanCard';
import styles from './KanbanColumn.module.css';

interface KanbanColumnProps {
  status: CardStatus;
  laneKey: string;
  cards: KanbanCardData[];
  commentCounts: Map<string, number>;
  canMoveCard: (card: KanbanCardData) => boolean;
  onOpenCard: (card: KanbanCardData) => void;
  /** Drag wiring - omitted while the board is read-only. */
  onCardDragStart?: (e: React.DragEvent, card: KanbanCardData) => void;
  onCardDragEnd?: () => void;
  onDragOver?: (e: React.DragEvent, laneKey: string, status: CardStatus) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent, laneKey: string, status: CardStatus) => void;
  isDropTarget?: boolean;
  draggingCardKey?: string | null;
}

const STATUS_CLASS: Record<CardStatus, string> = {
  todo: 'todo',
  in_progress: 'inProgress',
  blocked: 'blocked',
  done: 'done',
};

export function KanbanColumn({
  status,
  laneKey,
  cards,
  commentCounts,
  canMoveCard,
  onOpenCard,
  onCardDragStart,
  onCardDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  isDropTarget = false,
  draggingCardKey = null,
}: KanbanColumnProps) {
  const className = [
    styles.column,
    styles[STATUS_CLASS[status]],
    isDropTarget ? styles.dropTarget : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      onDragOver={onDragOver ? (e) => onDragOver(e, laneKey, status) : undefined}
      onDragLeave={onDragLeave}
      onDrop={onDrop ? (e) => onDrop(e, laneKey, status) : undefined}
      aria-label={STATUS_LABELS[status]}
    >
      <div className={styles.header}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.title}>{STATUS_LABELS[status]}</span>
        <span className={styles.count}>{cards.length}</span>
      </div>

      <div className={styles.cards}>
        {cards.map((card) => (
          <KanbanCard
            key={card.key}
            card={card}
            commentCount={commentCounts.get(card.key) ?? 0}
            canMove={canMoveCard(card)}
            onOpen={onOpenCard}
            onDragStart={onCardDragStart}
            onDragEnd={onCardDragEnd}
            isDragging={draggingCardKey === card.key}
          />
        ))}
        {cards.length === 0 && <div className={styles.empty}>No cards</div>}
      </div>
    </div>
  );
}
