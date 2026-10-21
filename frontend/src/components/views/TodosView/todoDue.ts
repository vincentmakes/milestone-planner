/**
 * The due chip of a task: overdue before today, due soon within
 * DUE_SOON_DAYS (the Kanban rule), nothing for a done task or no date.
 */

import { daysBetweenDateStrings } from '@/utils/date';
import { DUE_SOON_DAYS } from '@/utils/kanbanCards';
import type { TodoItem } from '@/types';

export type TaskDueState = 'overdue' | 'due-soon' | null;

export function taskDueState(task: Pick<TodoItem, 'status' | 'due_date'>, today: string): TaskDueState {
  if (task.status !== 'open' || !task.due_date) return null;
  const days = daysBetweenDateStrings(today, task.due_date);
  if (days < 0) return 'overdue';
  if (days <= DUE_SOON_DAYS) return 'due-soon';
  return null;
}
