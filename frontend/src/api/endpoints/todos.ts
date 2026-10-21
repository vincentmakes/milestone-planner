/**
 * Todos API (My Todos).
 *
 * A todo is private: the server answers only its assignee and its creator,
 * and pushes `todo:changed` to them (never a tenant-wide broadcast).
 * `GET /todos/mine` merges two kinds: `task` (a todo row) and `approval` (a
 * request the caller may decide, id `approval:<n>`). What-If exempt (see
 * ../client.ts): a todo is not plan data. Imported directly, like kanban.ts.
 */

import { apiDelete, apiGet, apiPost, apiPut } from '../client';
import { toDateOnly } from '@/utils/date';
import type { CreateTodoRequest, TodoItem, TodoTask, UpdateTodoRequest } from '@/types';

/** The list's status filter: `open` only, or every status. */
export type TodoListStatus = 'open' | 'all';

/** Due dates as `YYYY-MM-DD` (the server may send the midnight form) and nulls for absent fields. */
export function normalizeTodo(item: TodoItem): TodoItem {
  return {
    ...item,
    notes: item.notes ?? null,
    due_date: item.due_date ? toDateOnly(item.due_date) : null,
    assignee_id: item.assignee_id ?? null,
    assignee_name: item.assignee_name ?? null,
    created_by: item.created_by ?? null,
    created_by_name: item.created_by_name ?? null,
    project_id: item.project_id ?? null,
    project_name: item.project_name ?? null,
    entity_type: item.entity_type ?? null,
    entity_id: item.entity_id ?? null,
    completed_at: item.completed_at ?? null,
    approval_request: item.approval_request ?? null,
    created_at: item.created_at ?? null,
    updated_at: item.updated_at ?? null,
  };
}

/** A todo row (as opposed to a merged approval item). */
export function isTask(item: TodoItem): item is TodoTask {
  return item.kind === 'task' && typeof item.id === 'number';
}

export const todosApi = {
  /** The caller's tasks (assigned to or created by them) plus the approvals they may decide. */
  getMine: async (status: TodoListStatus = 'open') =>
    (await apiGet<TodoItem[]>(`/api/todos/mine?status=${status}`)).map(normalizeTodo),

  create: async (body: CreateTodoRequest) => normalizeTodo(await apiPost<TodoItem>('/api/todos', body)),

  /** Partial update, `status` included; an explicit null clears a field. */
  update: async (id: number, body: UpdateTodoRequest) =>
    normalizeTodo(await apiPut<TodoItem>(`/api/todos/${id}`, body)),

  /** The creator deletes (or the assignee, once the creator is gone). */
  remove: (id: number) => apiDelete<{ success: boolean; id: number }>(`/api/todos/${id}`),
};
