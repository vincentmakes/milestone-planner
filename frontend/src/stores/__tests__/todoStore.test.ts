/**
 * todoStore: one refresh loads tasks, my requests and the requests to decide
 * (shared while in flight, a failing list keeps its last value, a reset
 * mid-flight drops the result); openCount is the requests to decide plus my
 * open tasks, recomputed by every setter; decisions and task edits apply
 * locally; toDecideByAssignment indexes the requests by their booking row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assignmentRequestKey, isMyOpenTask, useTodoStore } from '../todoStore';
import { useAppStore } from '../appStore';
import { todosApi } from '@/api/endpoints/todos';
import { approvalsApi } from '@/api/endpoints/approvals';
import { makeApprovalRequest, makeTodo, makeUser } from '@/test/factories';
import type { TodoItem } from '@/types';

vi.mock('@/api/endpoints/todos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/todos')>()),
  todosApi: { getMine: vi.fn() },
}));
vi.mock('@/api/endpoints/approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/endpoints/approvals')>()),
  approvalsApi: { getMine: vi.fn(), getToDecide: vi.fn() },
}));

const approvalItem = { ...makeTodo({ id: 9 }), id: 'approval:31', kind: 'approval' } as TodoItem;

beforeEach(() => {
  vi.clearAllMocks();
  useTodoStore.getState().reset();
  useAppStore.setState({ currentUser: makeUser({ id: 4 }) });
  vi.mocked(todosApi.getMine).mockResolvedValue([makeTodo(), approvalItem]);
  vi.mocked(approvalsApi.getMine).mockResolvedValue([makeApprovalRequest({ id: 40 })]);
  vi.mocked(approvalsApi.getToDecide).mockResolvedValue([makeApprovalRequest({ requester_id: 7, can_decide: true })]);
});

describe('refresh', () => {
  it('loads the three lists, keeping only task rows', async () => {
    await useTodoStore.getState().refresh();
    const s = useTodoStore.getState();
    expect(todosApi.getMine).toHaveBeenCalledWith('all');
    expect(s.tasks.map((t) => t.id)).toEqual([1]);
    expect(s.mine.map((r) => r.id)).toEqual([40]);
    expect(s.toDecide.map((r) => r.id)).toEqual([31]);
    expect(s.loaded).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.openCount).toBe(2);
  });

  it('shares one request while a refresh is in flight', async () => {
    await Promise.all([useTodoStore.getState().refresh(), useTodoStore.getState().refresh()]);
    expect(todosApi.getMine).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a signed-in user', async () => {
    useAppStore.setState({ currentUser: null });
    await useTodoStore.getState().refresh();
    expect(todosApi.getMine).not.toHaveBeenCalled();
  });

  it('keeps the last value of a list that failed, logs it and reports it in loadError', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await useTodoStore.getState().refresh();
    expect(useTodoStore.getState().loadError).toBeNull();
    vi.mocked(approvalsApi.getToDecide).mockRejectedValueOnce(new Error('500'));
    vi.mocked(todosApi.getMine).mockResolvedValueOnce([]);
    await useTodoStore.getState().refresh();
    expect(useTodoStore.getState().toDecide).toHaveLength(1);
    expect(useTodoStore.getState().tasks).toEqual([]);
    expect(useTodoStore.getState().loadError).toBe('Some of your todos could not be loaded. They will reload on the next change.');
    expect(error).toHaveBeenCalledWith('[Todos] Failed to load', expect.any(Error));

    // A good refresh clears it.
    await useTodoStore.getState().refresh();
    expect(useTodoStore.getState().loadError).toBeNull();
    error.mockRestore();
  });

  it('says so when nothing could be loaded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(todosApi.getMine).mockRejectedValueOnce(new Error('500'));
    vi.mocked(approvalsApi.getMine).mockRejectedValueOnce(new Error('500'));
    vi.mocked(approvalsApi.getToDecide).mockRejectedValueOnce(new Error('500'));
    await useTodoStore.getState().refresh();
    expect(useTodoStore.getState().loadError).toBe('Your todos could not be loaded. They will reload on the next change.');
    expect(useTodoStore.getState().loaded).toBe(true);
    error.mockRestore();
  });

  it('drops a result that lands after a reset (sign-out)', async () => {
    const pending = useTodoStore.getState().refresh();
    useTodoStore.getState().reset();
    await pending;
    expect(useTodoStore.getState().tasks).toEqual([]);
    expect(useTodoStore.getState().loaded).toBe(false);
  });
});

describe('openCount', () => {
  it('counts the requests to decide and my open tasks, not tasks I gave others or done ones', () => {
    useTodoStore.getState().setTasks([
      makeTodo({ id: 1 }),
      makeTodo({ id: 2, status: 'done' }),
      makeTodo({ id: 3, assignee_id: 7 }),
    ]);
    expect(useTodoStore.getState().openCount).toBe(1);
    useTodoStore.getState().setToDecide([makeApprovalRequest(), makeApprovalRequest({ id: 32 })]);
    expect(useTodoStore.getState().openCount).toBe(3);
  });

  it('isMyOpenTask is the one rule for the badge and the My tasks tab count', () => {
    expect(isMyOpenTask(makeTodo(), 4)).toBe(true);
    expect(isMyOpenTask(makeTodo({ status: 'done' }), 4)).toBe(false);
    expect(isMyOpenTask(makeTodo({ assignee_id: 7 }), 4)).toBe(false);
    expect(isMyOpenTask(makeTodo({ assignee_id: 7 }), null)).toBe(true);
  });

  it('counts every open task while no user is known', () => {
    useAppStore.setState({ currentUser: null });
    useTodoStore.getState().setTasks([makeTodo({ id: 1 }), makeTodo({ id: 3, assignee_id: 7 })]);
    expect(useTodoStore.getState().openCount).toBe(2);
  });
});

describe('local writes', () => {
  it('applies a decision: leaves "to decide", updates my request', () => {
    useTodoStore.getState().setToDecide([makeApprovalRequest({ id: 31 })]);
    useTodoStore.getState().setMine([makeApprovalRequest({ id: 31 }), makeApprovalRequest({ id: 40 })]);
    useTodoStore.getState().applyDecisionLocal(31, 'cancelled');
    const s = useTodoStore.getState();
    expect(s.toDecide).toEqual([]);
    expect(s.mine.map((r) => [r.id, r.status])).toEqual([[31, 'cancelled'], [40, 'pending']]);
    expect(s.openCount).toBe(0);
    expect(s.toDecideByAssignment.size).toBe(0);
  });

  it('applies a decision of unknown outcome by removing it from "to decide" only', () => {
    useTodoStore.getState().setToDecide([makeApprovalRequest({ id: 31 })]);
    useTodoStore.getState().setMine([makeApprovalRequest({ id: 31 })]);
    useTodoStore.getState().applyDecisionLocal(31);
    expect(useTodoStore.getState().toDecide).toEqual([]);
    expect(useTodoStore.getState().mine[0].status).toBe('pending');
  });

  it('upserts and removes a task', () => {
    useTodoStore.getState().upsertTaskLocal(makeTodo({ id: 5, title: 'New' }));
    useTodoStore.getState().upsertTaskLocal(makeTodo({ id: 5, title: 'Renamed', status: 'done' }));
    expect(useTodoStore.getState().tasks.map((t) => [t.id, t.title])).toEqual([[5, 'Renamed']]);
    expect(useTodoStore.getState().openCount).toBe(0);
    useTodoStore.getState().removeTaskLocal(5);
    expect(useTodoStore.getState().tasks).toEqual([]);
  });
});

describe('toDecideByAssignment', () => {
  it('indexes the requests by level and booking row, skipping those without a row', () => {
    useTodoStore.getState().setToDecide([
      makeApprovalRequest({ id: 31, level: 'phase', assignment_id: 71 }),
      makeApprovalRequest({ id: 32, level: 'project', assignment_id: 71 }),
      makeApprovalRequest({ id: 33, assignment_id: null }),
    ]);
    const map = useTodoStore.getState().toDecideByAssignment;
    expect(map.get(assignmentRequestKey('phase', 71))?.id).toBe(31);
    expect(map.get(assignmentRequestKey('project', 71))?.id).toBe(32);
    expect(map.size).toBe(2);
  });
});

describe('view state and reset', () => {
  it('switches tab and filter, and reset forgets everything', () => {
    useTodoStore.getState().setActiveTab('requests');
    useTodoStore.getState().setStatusFilter('done');
    useTodoStore.getState().setTasks([makeTodo()]);
    useTodoStore.getState().reset();
    const s = useTodoStore.getState();
    expect(s.activeTab).toBe('tasks');
    expect(s.statusFilter).toBe('open');
    expect(s.tasks).toEqual([]);
    expect(s.openCount).toBe(0);
    expect(s.loadError).toBeNull();
  });
});
