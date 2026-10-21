/**
 * My tasks: one entry per task with the Done switch, the title (opens the
 * task for editing), the due chip, who it is from or for, and the linked
 * project / card. Entries are list items, not rows: no class name holds
 * "row" (the Gantt hooks find rows by that substring).
 */

import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { formatSingleDate } from '@/utils/date';
import { CardLink } from './CardLink';
import { taskDueState } from './todoDue';
import type { TodoTask } from '@/types';
import styles from './TodosView.module.css';

interface TodoListProps {
  tasks: TodoTask[];
  currentUserId: number | null;
  /** YYYY-MM-DD */
  today: string;
  /** Card names by `phase:<id>` / `subphase:<id>` */
  cardNames: ReadonlyMap<string, string>;
  /** Tasks whose write is in flight (their switch is disabled) */
  busyIds: ReadonlySet<number>;
  onToggleDone: (task: TodoTask, done: boolean) => void;
  onEdit: (task: TodoTask) => void;
}

const DUE_LABELS = { overdue: 'Overdue', 'due-soon': 'Due' } as const;

export function TodoList({ tasks, currentUserId, today, cardNames, busyIds, onToggleDone, onEdit }: TodoListProps) {
  return (
    <ul className={styles.list}>
      {tasks.map((task) => {
        const due = taskDueState(task, today);
        const linksCard = Boolean(task.entity_type && task.entity_id != null);
        const cardName = linksCard ? (cardNames.get(`${task.entity_type}:${task.entity_id}`) ?? 'Linked card') : null;
        const forSomeoneElse = task.assignee_id !== null && task.assignee_id !== currentUserId;
        const fromSomeoneElse = !forSomeoneElse && task.created_by !== null && task.created_by !== currentUserId;
        return (
          <li key={task.id} className={`${styles.item} ${task.status !== 'open' ? styles.itemDone : ''}`}>
            <ToggleSwitch
              checked={task.status === 'done'}
              onChange={(checked) => onToggleDone(task, checked)}
              disabled={busyIds.has(task.id)}
              aria-label="Done"
            />
            <div className={styles.itemMain}>
              <button type="button" className={styles.itemTitleButton} onClick={() => onEdit(task)}>
                {task.title}
              </button>
              <span className={styles.itemMeta}>
                {task.due_date && (
                  <span className={`${styles.dueChip} ${due ? styles[due === 'overdue' ? 'dueOverdue' : 'dueSoon'] : ''}`}>
                    {due ? `${DUE_LABELS[due]} ` : 'Due '}
                    {formatSingleDate(task.due_date)}
                  </span>
                )}
                {forSomeoneElse && <span>For {task.assignee_name ?? 'someone else'}</span>}
                {fromSomeoneElse && <span>From {task.created_by_name ?? 'someone else'}</span>}
                {task.project_name && <span className={styles.cardName}>{task.project_name}</span>}
                {cardName && (
                  <CardLink
                    entityType={task.entity_type}
                    entityId={task.entity_id}
                    projectId={task.project_id}
                    label={cardName}
                  />
                )}
              </span>
              {task.notes && <span className={styles.itemNote}>{task.notes}</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
