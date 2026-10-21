/**
 * Todo Store — the My Todos view and the sidebar badge.
 *
 * Deliberately NOT persisted (like notificationStore): the server owns this
 * data. Three lists, loaded together by `refresh()`:
 * - `tasks`: my todo rows (assigned to me or created by me), every status;
 * - `mine`: my own approval requests, newest first;
 * - `toDecide`: the pending requests I may decide.
 * `openCount` (requests to decide + my open tasks) is recomputed inside every
 * setter so the sidebar badge selects a primitive. The WebSocket pushes
 * (`todo:changed`, `approval:changed`) and the `todos` / `approvals` slices
 * call `refresh()`; the view also refreshes on mount and window focus.
 */

import { create } from 'zustand';
import { todosApi, isTask } from '@/api/endpoints/todos';
import { approvalsApi } from '@/api/endpoints/approvals';
import { useAppStore } from './appStore';
import type { ApprovalRequest, ApprovalRequestStatus, StaffAssignmentLevel, TodoTask } from '@/types';

export type TodoTab = 'decide' | 'tasks' | 'requests';
export type TodoStatusFilter = 'open' | 'done';

/** The `toDecideByAssignment` key of a booking row (ids are unique per level only). */
export function assignmentRequestKey(level: StaffAssignmentLevel, assignmentId: number): string {
  return `${level}:${assignmentId}`;
}

interface TodoData {
  tasks: TodoTask[];
  mine: ApprovalRequest[];
  toDecide: ApprovalRequest[];
  /** Requests to decide + my open tasks (the sidebar badge) */
  openCount: number;
  /** Requests to decide by their booking row (`assignmentRequestKey`) */
  toDecideByAssignment: Map<string, ApprovalRequest>;
  activeTab: TodoTab;
  statusFilter: TodoStatusFilter;
  loading: boolean;
  /** At least one refresh has completed */
  loaded: boolean;
}

interface TodoState extends TodoData {
  setTasks: (tasks: TodoTask[]) => void;
  setMine: (requests: ApprovalRequest[]) => void;
  setToDecide: (requests: ApprovalRequest[]) => void;
  setActiveTab: (tab: TodoTab) => void;
  setStatusFilter: (filter: TodoStatusFilter) => void;
  /** Reload the three lists; concurrent calls share one round trip */
  refresh: () => Promise<void>;
  /** A request was decided here: it leaves "to decide"; with a status, my copy takes it */
  applyDecisionLocal: (requestId: number, status?: ApprovalRequestStatus) => void;
  upsertTaskLocal: (task: TodoTask) => void;
  removeTaskLocal: (id: number) => void;
  reset: () => void;
}

const initialData = (): TodoData => ({
  tasks: [],
  mine: [],
  toDecide: [],
  openCount: 0,
  toDecideByAssignment: new Map(),
  activeTab: 'tasks',
  statusFilter: 'open',
  loading: false,
  loaded: false,
});

function countOpen(tasks: TodoTask[], toDecide: ApprovalRequest[]): number {
  const me = useAppStore.getState().currentUser?.id ?? null;
  const openTasks = tasks.filter((t) => t.status === 'open' && (me === null || t.assignee_id === me));
  return toDecide.length + openTasks.length;
}

function indexByAssignment(requests: ApprovalRequest[]): Map<string, ApprovalRequest> {
  const map = new Map<string, ApprovalRequest>();
  for (const r of requests) {
    if (r.assignment_id != null) map.set(assignmentRequestKey(r.level, r.assignment_id), r);
  }
  return map;
}

// The refresh in flight (shared by concurrent callers) and a generation
// bumped by reset(), so a result that lands after a sign-out is dropped.
let inFlight: Promise<void> | null = null;
let generation = 0;

export const useTodoStore = create<TodoState>((set, get) => {
  const withTasks = (tasks: TodoTask[]) => ({ tasks, openCount: countOpen(tasks, get().toDecide) });
  const withToDecide = (toDecide: ApprovalRequest[]) => ({
    toDecide,
    toDecideByAssignment: indexByAssignment(toDecide),
    openCount: countOpen(get().tasks, toDecide),
  });

  const load = async (): Promise<void> => {
    const started = generation;
    set({ loading: true });
    const [tasks, mine, toDecide] = await Promise.allSettled([
      todosApi.getMine('all'),
      approvalsApi.getMine(),
      approvalsApi.getToDecide(),
    ]);
    if (started !== generation) return;
    for (const result of [tasks, mine, toDecide]) {
      if (result.status === 'rejected') console.error('[Todos] Failed to load', result.reason);
    }
    if (tasks.status === 'fulfilled') set(withTasks(tasks.value.filter(isTask)));
    if (mine.status === 'fulfilled') set({ mine: mine.value });
    if (toDecide.status === 'fulfilled') set(withToDecide(toDecide.value));
    set({ loading: false, loaded: true });
  };

  return {
    ...initialData(),

    setTasks: (tasks) => set(withTasks(tasks)),
    setMine: (mine) => set({ mine }),
    setToDecide: (toDecide) => set(withToDecide(toDecide)),
    setActiveTab: (activeTab) => set({ activeTab }),
    setStatusFilter: (statusFilter) => set({ statusFilter }),

    refresh: () => {
      if (!useAppStore.getState().currentUser) return Promise.resolve();
      if (!inFlight) {
        const current: Promise<void> = load().finally(() => {
          if (inFlight === current) inFlight = null;
        });
        inFlight = current;
      }
      return inFlight;
    },

    applyDecisionLocal: (requestId, status) => {
      const { toDecide, mine } = get();
      set({
        ...withToDecide(toDecide.filter((r) => r.id !== requestId)),
        mine: status ? mine.map((r) => (r.id === requestId ? { ...r, status } : r)) : mine,
      });
    },

    upsertTaskLocal: (task) => {
      const { tasks } = get();
      const exists = tasks.some((t) => t.id === task.id);
      set(withTasks(exists ? tasks.map((t) => (t.id === task.id ? task : t)) : [task, ...tasks]));
    },

    removeTaskLocal: (id) => set(withTasks(get().tasks.filter((t) => t.id !== id))),

    reset: () => {
      generation += 1;
      inFlight = null;
      set(initialData());
    },
  };
});
