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
 *
 * `history` is the History tab: closed requests I decided (`decided`) or every
 * closed request at my sites (`all`, `approvals.view_all`), paged from the
 * server by 50 with a keyset cursor (`loadMoreHistory` sends the last row's id).
 * The view loads page 1 when the tab opens; a filter change reloads page 1;
 * the push and the slice reload page 1 once a page was loaded, rows or none
 * (`reloadHistoryIfHeld`: an open empty tab flips too). A counter drops an answer overtaken by a newer load.
 */

import { create } from 'zustand';
import { approvalsApi, HISTORY_PAGE_SIZE } from '@/api/endpoints/approvals';
import type { HistoryParams } from '@/api/endpoints/approvals';
import { useAppStore } from './appStore';
import type { ApprovalRequest, ApprovalRequestStatus } from '@/types';

export type WorkTab = 'approvals' | 'assignments' | 'requests' | 'history';
export type RequestsFilter = 'open' | 'done';
export type AssignmentsFilter = 'upcoming' | 'all';
/** History: the requests I decided, or every closed one at my sites */
export type HistoryScope = 'decided' | 'all';
export type HistoryOutcome = 'all' | Exclude<ApprovalRequestStatus, 'pending'>;

export interface HistoryFilters {
  scope: HistoryScope;
  outcome: HistoryOutcome;
  projectId: number | null;
  /** The requester */
  requesterId: number | null;
  /** Only in `all` mode (in `decided` the decider is me) */
  decidedBy: number | null;
}

export interface HistoryState {
  rows: ApprovalRequest[];
  /** The last page was full: Load more may find older rows */
  hasMore: boolean;
  loading: boolean;
  /** A page has loaded since the last filter change */
  loaded: boolean;
  error: string | null;
  filters: HistoryFilters;
}

/** The outcomes that only the All-requests mode offers. */
const ALL_MODE_OUTCOMES: ReadonlySet<HistoryOutcome> = new Set(['expired', 'superseded']);

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
  history: HistoryState;
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
  /** Change the History filters and reload from page 1 */
  setHistoryFilters: (patch: Partial<HistoryFilters>) => Promise<void>;
  /** Load the History's page 1 (replaces the rows) */
  loadHistory: () => Promise<void>;
  /** Append the next History page (after the last row held) */
  loadMoreHistory: () => Promise<void>;
  /** Reload page 1 once a History page was loaded, empty or not (the push and the WebSocket slice) */
  reloadHistoryIfHeld: () => Promise<void>;
  reset: () => void;
}

const initialHistory = (): HistoryState => ({
  rows: [],
  hasMore: false,
  loading: false,
  loaded: false,
  error: null,
  filters: { scope: 'decided', outcome: 'all', projectId: null, requesterId: null, decidedBy: null },
});

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
  history: initialHistory(),
});

const HISTORY_LOAD_ERROR = 'The history could not be loaded. Try again later.';

function historyParams(filters: HistoryFilters, beforeId?: number): HistoryParams {
  const all = filters.scope === 'all';
  return {
    scope: filters.scope,
    closed: all || undefined,
    status: filters.outcome === 'all' ? undefined : filters.outcome,
    project_id: filters.projectId ?? undefined,
    requester_id: filters.requesterId ?? undefined,
    decided_by: all ? (filters.decidedBy ?? undefined) : undefined,
    before_id: beforeId,
    limit: HISTORY_PAGE_SIZE,
  };
}

const PARTIAL_LOAD_ERROR = 'Some of your requests could not be loaded. They will reload on the next change.';
const LOAD_ERROR = 'Your requests could not be loaded. They will reload on the next change.';

// The refresh in flight (shared by concurrent callers) and a generation
// bumped by reset(), so a result that lands after a sign-out is dropped.
let inFlight: Promise<void> | null = null;
let generation = 0;
// Bumped by every History load (and reset): only the newest answer lands.
let historySeq = 0;

export const useWorkStore = create<WorkState>((set, get) => {
  const withToDecide = (toDecide: ApprovalRequest[]) => ({ toDecide, openCount: toDecide.length });
  const patchHistory = (patch: Partial<HistoryState>) => set({ history: { ...get().history, ...patch } });

  const fetchHistoryPage = async (append: boolean): Promise<void> => {
    const seq = ++historySeq;
    const { filters, rows } = get().history;
    const beforeId = append && rows.length > 0 ? rows[rows.length - 1].id : undefined;
    patchHistory({ loading: true, error: null });
    try {
      const page = await approvalsApi.listHistory(historyParams(filters, beforeId));
      if (seq !== historySeq) return;
      let next = page;
      if (append) {
        const held = get().history.rows;
        const ids = new Set(held.map((r) => r.id));
        next = [...held, ...page.filter((r) => !ids.has(r.id))];
      }
      patchHistory({ rows: next, hasMore: page.length === HISTORY_PAGE_SIZE, loading: false, loaded: true });
    } catch (err) {
      if (seq !== historySeq) return;
      console.error('[Work] Failed to load the history', err);
      // Page 1 failed: the rows held no longer match the filters.
      patchHistory({
        loading: false,
        loaded: true,
        error: HISTORY_LOAD_ERROR,
        ...(append ? {} : { rows: [], hasMore: false }),
      });
    }
  };

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

    setHistoryFilters: (patch) => {
      const filters = { ...get().history.filters, ...patch };
      if (filters.scope === 'decided') {
        // Those controls exist only in All-requests mode.
        filters.decidedBy = null;
        if (ALL_MODE_OUTCOMES.has(filters.outcome)) filters.outcome = 'all';
      }
      patchHistory({ filters, rows: [], hasMore: false, loaded: false });
      return fetchHistoryPage(false);
    },

    loadHistory: () => fetchHistoryPage(false),

    loadMoreHistory: () => fetchHistoryPage(true),

    // Once a page was requested (the tab was opened, empty or not); never for
    // a user who has not opened History since sign-in (reset clears `loaded`).
    reloadHistoryIfHeld: () => (get().history.loaded ? fetchHistoryPage(false) : Promise.resolve()),

    reset: () => {
      generation += 1;
      historySeq += 1;
      inFlight = null;
      set(initialData());
    },
  };
});
