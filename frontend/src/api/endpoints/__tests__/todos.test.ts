/**
 * Todos API: the list is normalised (due dates to YYYY-MM-DD, a task's id a
 * number), and the helpers that tell tasks from approval items apart.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as client from '@/api/client';
import { isTask, normalizeTodo, todosApi } from '../todos';
import type { TodoItem } from '@/types';

vi.mock('@/api/client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

const raw = (over: Partial<TodoItem> = {}): TodoItem => ({
  id: 3,
  kind: 'task',
  title: 'Order reagents',
  notes: null,
  due_date: '2026-11-02T00:00:00.000Z',
  status: 'open',
  assignee_id: 4,
  assignee_name: 'Bob Brown',
  created_by: 4,
  created_by_name: 'Bob Brown',
  project_id: null,
  project_name: null,
  entity_type: null,
  entity_id: null,
  completed_at: null,
  approval_request: null,
  created_at: '2026-10-20T08:00:00.000Z',
  updated_at: null,
  ...over,
});

beforeEach(() => {
  vi.mocked(client.apiGet).mockReset();
  vi.mocked(client.apiPost).mockReset();
  vi.mocked(client.apiPut).mockReset();
});

describe('normalizeTodo', () => {
  it('cuts a midnight due date to the day and keeps null', () => {
    expect(normalizeTodo(raw()).due_date).toBe('2026-11-02');
    expect(normalizeTodo(raw({ due_date: '2026-11-03' })).due_date).toBe('2026-11-03');
    expect(normalizeTodo(raw({ due_date: null })).due_date).toBeNull();
  });

  it('defaults missing optional fields to null', () => {
    const partial = { id: 1, kind: 'task', title: 'x', status: 'open' } as unknown as TodoItem;
    expect(normalizeTodo(partial)).toMatchObject({ notes: null, assignee_id: null, approval_request: null });
  });
});

describe('isTask', () => {
  it('is true for a task row and false for an approval item', () => {
    expect(isTask(raw())).toBe(true);
    expect(isTask(raw({ id: 'approval:7', kind: 'approval' }))).toBe(false);
  });
});

describe('todosApi', () => {
  it('normalises the list and the written rows', async () => {
    vi.mocked(client.apiGet).mockResolvedValueOnce([raw()]);
    await expect(todosApi.getMine('all')).resolves.toEqual([expect.objectContaining({ due_date: '2026-11-02' })]);
    vi.mocked(client.apiPost).mockResolvedValueOnce(raw());
    await expect(todosApi.create({ title: 'Order reagents' })).resolves.toMatchObject({ due_date: '2026-11-02' });
    vi.mocked(client.apiPut).mockResolvedValueOnce(raw({ status: 'done' }));
    await expect(todosApi.update(3, { status: 'done' })).resolves.toMatchObject({ status: 'done', due_date: '2026-11-02' });
  });
});
