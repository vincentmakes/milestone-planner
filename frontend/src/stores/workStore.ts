/**
 * Work Store — the My Work view and the sidebar badge.
 *
 * Deliberately NOT persisted (like notificationStore): the server owns this
 * data. Two lists, loaded together by `refresh()`:
 * - `mine`: my own approval requests, newest first (My Requests);
 * - `toDecide`: the pending requests I may decide (My Approvals).
 * My Assignments is derived from `appStore.projects` by the view, so it is
 * not stored here. `openCount` (the requests to decide, the sidebar badge) is
 * recomputed inside every setter so the badge selects a primitive. The
 * per-user `approval:changed` push and the `approvals` slice call
 * `refresh()`; the WebSocket provider and the view also refresh on mount and
 * window focus.
 */

import { create } from 'zustand';
import { approvalsApi } from '@/api/endpoints/approvals';
import { useAppStore } from './appStore';
import type { ApprovalRequest, ApprovalRequestStatus } from '@/types';

export type WorkTab = 'approvals' | 'assignments' | 'requests';
export type RequestsFilter = 'open' | 'done';
export type AssignmentsFilter = 'upcoming' | 'all';

interface WorkData {
  mine: ApprovalRequest[];
  toDecide: ApprovalRequest[];
  /** Requests to decide (the sidebar badge) */
  openCount: number;
  activeTab: WorkTab;
  /** My Requests: pending ones, or decided / closed ones */
  requestsFilter: RequestsFilter;
  /** My Assignments: current and upcoming bookings, or every one */
  assignmentsFilter: AssignmentsFilter;
  loading: boolean;
  /** At least one refresh has completed */
  loaded: boolean;
  /** The last refresh could not load one or both lists (shown in place by the view) */
  loadError: string | null;
}

interface WorkState extends WorkData {
  setMine: (requests: ApprovalRequest[]) => void;
  setToDecide: (requests: ApprovalRequest[]) => void;
  setActiveTab: (tab: WorkTab) => void;
  setRequestsFilter: (filter: RequestsFilter) => void;
  setAssignmentsFilter: (filter: AssignmentsFilter) => void;
  /** Reload both lists; concurrent calls share one round trip */
  refresh: () => Promise<void>;
  /** A request was decided here: it leaves "to decide"; with a status, my copy takes it */
  applyDecisionLocal: (requestId: number, status?: ApprovalRequestStatus) => void;
  reset: () => void;
}

const initialData = (): WorkData => ({
  mine: [],
  toDecide: [],
  openCount: 0,
  activeTab: 'assignments',
  requestsFilter: 'open',
  assignmentsFilter: 'upcoming',
  loading: false,
  loaded: false,
  loadError: null,
});

const PARTIAL_LOAD_ERROR = 'Some of your requests could not be loaded. They will reload on the next change.';
const LOAD_ERROR = 'Your requests could not be loaded. They will reload on the next change.';

// The refresh in flight (shared by concurrent callers) and a generation
// bumped by reset(), so a result that lands after a sign-out is dropped.
let inFlight: Promise<void> | null = null;
let generation = 0;

export const useWorkStore = create<WorkState>((set, get) => {
  const withToDecide = (toDecide: ApprovalRequest[]) => ({ toDecide, openCount: toDecide.length });

  const load = async (): Promise<void> => {
    const started = generation;
    set({ loading: true });
    const [mine, toDecide] = await Promise.allSettled([approvalsApi.getMine(), approvalsApi.getToDecide()]);
    if (started !== generation) return;
    const results = [mine, toDecide];
    for (const result of results) {
      if (result.status === 'rejected') console.error('[Work] Failed to load', result.reason);
    }
    // A list that failed keeps its last value; the view says so in place.
    if (mine.status === 'fulfilled') set({ mine: mine.value });
    if (toDecide.status === 'fulfilled') set(withToDecide(toDecide.value));
    const failed = results.filter((r) => r.status === 'rejected').length;
    set({
      loading: false,
      loaded: true,
      loadError: failed === 0 ? null : failed === results.length ? LOAD_ERROR : PARTIAL_LOAD_ERROR,
    });
  };

  return {
    ...initialData(),

    setMine: (mine) => set({ mine }),
    setToDecide: (toDecide) => set(withToDecide(toDecide)),
    setActiveTab: (activeTab) => set({ activeTab }),
    setRequestsFilter: (requestsFilter) => set({ requestsFilter }),
    setAssignmentsFilter: (assignmentsFilter) => set({ assignmentsFilter }),

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

    reset: () => {
      generation += 1;
      inFlight = null;
      set(initialData());
    },
  };
});
