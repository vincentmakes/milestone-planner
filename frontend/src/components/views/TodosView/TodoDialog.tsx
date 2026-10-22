/**
 * TodoDialog — create or edit a task, on the shared Modal (closes only via
 * its buttons or Escape).
 *
 * Fields: title (required), notes (a textarea: the shared Input has no
 * multi-line form), due date, assignee, project and card. The assignee is the
 * signed-in user only without `todos.assign_others` — held outright or
 * through the PM bundle on the chosen project, as the server checks it
 * (changing the project re-checks it and falls back to the default). The
 * default is "me", unless the role assigns others but lacks
 * `todos.manage_own`: then "me" is disabled and the first other person on the
 * list is the default. Cards are the
 * chosen project's (`collectCardsForProjects`). One submit guard covers save
 * and delete; failures show in place. An edit sends every field, so a
 * cleared one goes out as an explicit null.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { DateField } from '@/components/common/DateRangeField';
import { Select } from '@/components/common/Select';
import { Notice } from '@/components/common/Notice';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { useAppStore } from '@/stores/appStore';
import { useTodoStore } from '@/stores/todoStore';
import { useCan } from '@/hooks/useCan';
import { todosApi } from '@/api/endpoints/todos';
import { collectCardsForProjects } from '@/utils/kanbanCards';
import { confirmAction } from '@/utils/confirmDialog';
import { toDateOnly } from '@/utils/date';
import type { CreateTodoRequest, TodoTask } from '@/types';
import styles from './TodoDialog.module.css';

export interface TodoDialogProps {
  isOpen: boolean;
  /** The task to edit; null creates one */
  task: TodoTask | null;
  onClose: () => void;
}

const NONE = '';

interface AssigneeOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function cardValue(entityType: string | null, entityId: number | null): string {
  return (entityType === 'phase' || entityType === 'subphase') && entityId != null ? `${entityType}:${entityId}` : NONE;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function TodoDialog({ isOpen, task, onClose }: TodoDialogProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const projects = useAppStore((s) => s.projects);
  const staff = useAppStore((s) => s.staff);
  const can = useCan();
  const { isSubmitting, begin, end } = useSubmitGuard();
  const notesId = useId();

  const meId = currentUser?.id ?? 0;
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [due, setDue] = useState('');
  const [assigneeId, setAssigneeId] = useState(String(meId));
  const [projectId, setProjectId] = useState(NONE);
  const [card, setCard] = useState(NONE);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Start from the task (or blank) every time the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    setTitle(task?.title ?? '');
    setNotes(task?.notes ?? '');
    setDue(task?.due_date ? toDateOnly(task.due_date) : '');
    // A new task: the fallback effect below picks the default assignee.
    setAssigneeId(task?.assignee_id != null ? String(task.assignee_id) : NONE);
    setProjectId(task?.project_id != null ? String(task.project_id) : NONE);
    setCard(cardValue(task?.entity_type ?? null, task?.entity_id ?? null));
    setTitleError(null);
    setError(null);
  }, [isOpen, task, meId]);

  const project = useMemo(
    () => (projectId === NONE ? null : (projects.find((p) => p.id === Number(projectId)) ?? null)),
    [projects, projectId]
  );
  const canAssignOthers = can('todos.assign_others', project);
  // A role that hands out tasks but may hold none itself: "me" is not an
  // option (an edited task that is already mine keeps it).
  const meBlocked = canAssignOthers && !can('todos.manage_own') && task?.assignee_id !== meId;

  const projectOptions = useMemo(
    () => [
      { value: NONE, label: 'No project' },
      ...projects
        .filter((p) => !p.archived || p.id === task?.project_id)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ value: String(p.id), label: p.name })),
    ],
    [projects, task]
  );

  const cardOptions = useMemo(
    () => [
      { value: NONE, label: 'No card' },
      ...(project
        ? collectCardsForProjects([project]).map((c) => ({
            value: `${c.entityType}:${c.entityId}`,
            label: c.path || c.name,
          }))
        : []),
    ],
    [project]
  );

  const assigneeOptions = useMemo<AssigneeOption[]>(() => {
    const me = {
      value: String(meId),
      label: `${currentUser?.first_name ?? ''} ${currentUser?.last_name ?? ''}`.trim() + ' (me)',
      disabled: meBlocked,
    };
    const others = new Map<number, string>();
    if (canAssignOthers) {
      for (const s of staff) {
        if (s.active && s.id !== meId) others.set(s.id, s.name);
      }
    }
    // A task I gave someone else keeps its assignee on the list.
    if (task?.assignee_id != null && task.assignee_id !== meId && !others.has(task.assignee_id)) {
      others.set(task.assignee_id, task.assignee_name ?? `User ${task.assignee_id}`);
    }
    return [
      me,
      ...Array.from(others, ([id, name]) => ({ value: String(id), label: name })).sort((a, b) =>
        a.label.localeCompare(b.label)
      ),
    ];
  }, [canAssignOthers, meBlocked, staff, meId, currentUser, task]);

  // "me", or the first other person when "me" is disabled (none: still "me").
  const defaultAssignee = (assigneeOptions.find((o) => !o.disabled) ?? assigneeOptions[0]).value;

  // No assignee yet (a new task), or the chosen one left the list (another
  // project, staff reloaded) or is now disabled: back to the default.
  useEffect(() => {
    if (!isOpen || assigneeId === defaultAssignee) return;
    if (!assigneeOptions.some((o) => o.value === assigneeId && !o.disabled)) setAssigneeId(defaultAssignee);
  }, [isOpen, assigneeOptions, assigneeId, defaultAssignee]);

  const handleProjectChange = (value: string) => {
    setProjectId(value);
    setCard(NONE);
  };

  const canDelete = task !== null && (task.created_by === meId || (task.created_by === null && task.assignee_id === meId));

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError('Title is required');
      return;
    }
    if (!begin()) return;
    setTitleError(null);
    setError(null);
    const [entityType, entityId] = card === NONE ? [null, null] : card.split(':');
    const body: CreateTodoRequest = {
      title: trimmed,
      notes: notes.trim() || null,
      due_date: due || null,
      assignee_id: Number(assigneeId),
      project_id: projectId === NONE ? null : Number(projectId),
      entity_type: entityType as CreateTodoRequest['entity_type'],
      entity_id: entityId === null ? null : Number(entityId),
    };
    try {
      const saved = task ? await todosApi.update(task.id, body) : await todosApi.create(body);
      useTodoStore.getState().upsertTaskLocal(saved as TodoTask);
      onClose();
    } catch (err) {
      setError(message(err, task ? 'Could not save the task' : 'Could not create the task'));
    } finally {
      end();
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    if (!(await confirmAction({ title: 'Delete task', message: `Delete the task "${task.title}"?`, destructive: true }))) {
      return;
    }
    if (!begin()) return;
    setError(null);
    try {
      await todosApi.remove(task.id);
      useTodoStore.getState().removeTaskLocal(task.id);
      onClose();
    } catch (err) {
      setError(message(err, 'Could not delete the task'));
    } finally {
      end();
    }
  };

  const footer = (
    <div className={styles.footer}>
      {canDelete && (
        <Button variant="danger" className={styles.deleteButton} onClick={handleDelete} disabled={isSubmitting}>
          Delete
        </Button>
      )}
      <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button onClick={() => void handleSubmit()} loading={isSubmitting} disabled={isSubmitting}>
        {task ? 'Save Changes' : 'Create task'}
      </Button>
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={task ? 'Edit task' : 'New task'} size="md" footer={footer}>
      <form className={styles.form} onSubmit={(e) => void handleSubmit(e)}>
        {error && <Notice tone="error">{error}</Notice>}
        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={titleError ?? undefined}
          maxLength={200}
          fullWidth
          autoFocus
        />
        <div className={styles.field}>
          <label htmlFor={notesId} className={styles.label}>
            Notes
          </label>
          <textarea
            id={notesId}
            className={styles.textarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={5000}
            rows={3}
          />
        </div>
        <div className={styles.columns}>
          <DateField label="Due date" value={due} onChange={setDue} clearable fullWidth />
          <Select
            label="Assignee"
            options={assigneeOptions}
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            disabled={assigneeOptions.length < 2}
            hint={
              !canAssignOthers
                ? 'You can assign tasks only to yourself'
                : meBlocked
                  ? 'You can assign tasks only to others'
                  : undefined
            }
            fullWidth
          />
        </div>
        <div className={styles.columns}>
          <Select
            label="Project"
            options={projectOptions}
            value={projectId}
            onChange={(e) => handleProjectChange(e.target.value)}
            fullWidth
          />
          <Select
            label="Card"
            options={cardOptions}
            value={card}
            onChange={(e) => setCard(e.target.value)}
            disabled={!project}
            fullWidth
          />
        </div>
      </form>
    </Modal>
  );
}
