/**
 * The board: swimlanes (rows) x status columns.
 */

import { useState } from 'react';
import type { CardStatus } from '@/types';
import type { KanbanCard as KanbanCardData, KanbanLane } from '@/utils/kanbanCards';
import { CARD_STATUSES, cardsForColumn } from '@/utils/kanbanCards';
import { KanbanColumn } from './KanbanColumn';
import styles from './KanbanBoard.module.css';

interface KanbanBoardProps {
  lanes: KanbanLane[];
  /** False when grouping is 'none' - render the columns without a lane header. */
  showLaneHeaders: boolean;
  commentCounts: Map<string, number>;
  canMoveCard: (card: KanbanCardData) => boolean;
  onOpenCard: (card: KanbanCardData) => void;
  onCardDragStart?: (e: React.DragEvent, card: KanbanCardData) => void;
  onCardDragEnd?: () => void;
  onDragOver?: (e: React.DragEvent, laneKey: string, status: CardStatus) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent, laneKey: string, status: CardStatus) => void;
  dropTarget?: { laneKey: string; status: CardStatus } | null;
  draggingCardKey?: string | null;
}

export function KanbanBoard({
  lanes,
  showLaneHeaders,
  commentCounts,
  canMoveCard,
  onOpenCard,
  onCardDragStart,
  onCardDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  dropTarget = null,
  draggingCardKey = null,
}: KanbanBoardProps) {
  // Lane collapse is transient UI, kept local rather than in viewStore
  // (same convention as StaffView's local expansion state).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleLane = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (lanes.length === 0) {
    return <div className={styles.empty}>No cards match the current filter.</div>;
  }

  return (
    <div className={styles.board}>
      {lanes.map((lane) => {
        const isCollapsed = collapsed.has(lane.key);
        return (
          <section key={lane.key} className={styles.lane}>
            {showLaneHeaders && (
              <button
                type="button"
                className={styles.laneHeader}
                onClick={() => toggleLane(lane.key)}
                aria-expanded={!isCollapsed}
              >
                <span className={`${styles.chevron} ${isCollapsed ? styles.collapsed : ''}`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </span>
                <span className={styles.laneLabel}>{lane.label}</span>
                <span className={styles.laneCount}>{lane.cards.length}</span>
              </button>
            )}

            {!isCollapsed && (
              <div className={styles.columns}>
                {CARD_STATUSES.map((status) => (
                  <KanbanColumn
                    key={status}
                    status={status}
                    laneKey={lane.key}
                    cards={cardsForColumn(lane.cards, status)}
                    commentCounts={commentCounts}
                    canMoveCard={canMoveCard}
                    onOpenCard={onOpenCard}
                    onCardDragStart={onCardDragStart}
                    onCardDragEnd={onCardDragEnd}
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                    isDropTarget={
                      dropTarget?.laneKey === lane.key && dropTarget?.status === status
                    }
                    draggingCardKey={draggingCardKey}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
