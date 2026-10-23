/**
 * Drag-to-reorder for one list of Settings rows (Tags, Project fields and
 * their items): the dragged row drops before or after the hovered row's
 * midpoint, the same interaction as Absence types and Predefined phases.
 *
 * `canDrop` limits drops (e.g. items to their own field); `classes` are the
 * panel's own row classes for the dragged row and the drop marker.
 */

import { useState } from 'react';
import type { DragEvent } from 'react';

export type DropPosition = 'before' | 'after';

export interface DragReorderClasses {
  dragging: string;
  dropBefore: string;
  dropAfter: string;
}

export function useDragReorder(
  onDrop: (draggedId: number, targetId: number, position: DropPosition) => void,
  classes: DragReorderClasses,
  canDrop: (draggedId: number, targetId: number) => boolean = () => true
) {
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const [position, setPosition] = useState<DropPosition | null>(null);

  const reset = () => {
    setDraggedId(null);
    setOverId(null);
    setPosition(null);
  };

  const rowProps = (id: number, enabled: boolean) => ({
    draggable: enabled,
    onDragStart: (e: DragEvent) => {
      // A drag that starts on a nested row (an item inside a field) belongs to it alone
      e.stopPropagation();
      setDraggedId(id);
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e: DragEvent) => {
      if (draggedId === null || draggedId === id || !canDrop(draggedId, id)) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setOverId(id);
      setPosition(e.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
    },
    onDragLeave: () => {
      setOverId(null);
      setPosition(null);
    },
    onDrop: (e: DragEvent) => {
      if (draggedId === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (overId !== null && draggedId !== overId && position) {
        onDrop(draggedId, overId, position);
      }
      reset();
    },
    onDragEnd: reset,
  });

  const rowClass = (id: number) =>
    [
      draggedId === id ? classes.dragging : '',
      overId === id && position === 'before' ? classes.dropBefore : '',
      overId === id && position === 'after' ? classes.dropAfter : '',
    ]
      .filter(Boolean)
      .join(' ');

  return { rowProps, rowClass };
}

/** Move `draggedId` before/after `targetId` in `order`. Returns a new array. */
export function moveId(order: number[], draggedId: number, targetId: number, position: DropPosition): number[] {
  const next = order.filter((id) => id !== draggedId);
  let index = next.indexOf(targetId);
  if (position === 'after') index += 1;
  next.splice(index, 0, draggedId);
  return next;
}
