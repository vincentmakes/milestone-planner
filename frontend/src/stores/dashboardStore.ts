/**
 * Dashboard Store — the Dashboards view (2.1.0).
 *
 * Server-owned and deliberately NOT persisted (like workStore): the list of
 * dashboards shared with the user, the one open (`current`, with its
 * widgets) and its widgets' results (`data`, keyed by widget id: a
 * `MetricResult` or `{error}`). Only the last opened dashboard id is a
 * per-browser preference, kept in `viewStore.lastDashboardId` (per tenant).
 *
 * Live reloads: the WebSocket provider calls `reloadData()` when the plan
 * data changes (projects, staff, teams, project fields) and
 * `refreshCurrent()` when a dashboard changes; both go through this store's
 * one **2 s trailing debounce** (the only throttle of live reloads — the
 * context never calls the API itself). Opening a dashboard, mounting the
 * view, window focus and the Refresh button load at once
 * (`reloadData(true)`). A 404 on the dashboard or its data means it is no
 * longer shared with the user: `current` is cleared, the notice says so and
 * the list reloads.
 *
 * While the builder edits the open dashboard (`editing`, set by
 * `useDashboardEditor`), a live "dashboard changed" reload never replaces
 * `current` under the draft: it is skipped and run once editing ends (a save
 * shows the saved dashboard instead). The list and the data still refresh.
 */

import { create } from 'zustand';
import { dashboardsApi } from '@/api/endpoints/dashboards';
import { ApiError } from '@/api/client';
import { tenantKey } from '@/utils/tags';
import { useViewStore } from './viewStore';
import type {
  Dashboard,
  DashboardDraft,
  DashboardSummary,
  MetricError,
  MetricResult,
} from '@/types';

/** The trailing debounce of live (WebSocket) reloads. */
export const LIVE_RELOAD_DELAY_MS = 2000;

export const NO_LONGER_SHARED = 'This dashboard is no longer shared with you';
const LIST_ERROR = 'The dashboards could not be loaded.';
const OPEN_ERROR = 'This dashboard could not be loaded.';
const DATA_ERROR = 'The dashboard data could not be loaded. Try Refresh.';

interface DashboardData {
  dashboards: DashboardSummary[];
  current: Dashboard | null;
  /** Widget id → its result, or `{error}` for that widget alone */
  data: Record<number, MetricResult | MetricError>;
  /** When the server computed `data` (ISO timestamp) */
  loadedAt: string | null;
  /** The open dashboard is loading */
  loading: boolean;
  /** Its data is loading */
  dataLoading: boolean;
  loadError: string | null;
  /** The list has loaded at least once (the WebSocket provider reloads only a list the view asked for) */
  listLoaded: boolean;
  /** The builder is editing the open dashboard: live reloads leave `current` alone */
  editing: boolean;
}

interface DashboardState extends DashboardData {
  /** Reload the list; concurrent calls share one round trip */
  refreshList: () => Promise<void>;
  /** Open a dashboard: its widgets, then their data; remembered per tenant */
  open: (id: number) => Promise<void>;
  /**
   * Reload the open dashboard's data: at once when `immediate` (open, mount,
   * focus, Refresh), else after the 2 s trailing debounce (live changes).
   */
  reloadData: (immediate?: boolean) => Promise<void>;
  /** Reload the open dashboard itself and its data, after the debounce (a dashboard changed) */
  refreshCurrent: () => void;
  /** Drop a pending debounced reload (the view unmounts) */
  cancelPendingReload: () => void;
  /** Create (no `id`) or replace a dashboard; it becomes the open one */
  save: (draft: DashboardDraft) => Promise<Dashboard>;
  /** Delete a dashboard; when it was open, the next initial pick opens */
  remove: (id: number) => Promise<void>;
  /** Copy a dashboard's widgets into a new private one named `name`; it opens */
  duplicate: (id: number, name: string) => Promise<Dashboard>;
  /**
   * The builder enters / leaves edit mode. Leaving runs the reload of the
   * open dashboard that a live change asked for meanwhile.
   */
  setEditing: (editing: boolean) => void;
  /** The dashboard to open first: the last opened if still listed, else the default, else the first */
  pickInitial: () => number | null;
  reset: () => void;
}

const initialData = (): DashboardData => ({
  dashboards: [],
  current: null,
  data: {},
  loadedAt: null,
  loading: false,
  dataLoading: false,
  loadError: null,
  listLoaded: false,
  editing: false,
});

const isNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404;

// Module state: the list refresh in flight (shared), the debounce timer and
// whether its run must reload the dashboard itself, a generation bumped by
// reset() (results landing after a sign-out are dropped) and a sequence per
// kind of load (a newer open or data load wins over an older one).
let listInFlight: Promise<void> | null = null;
let reloadTimer: number | null = null;
let pendingDetail = false;
let generation = 0;
let openSeq = 0;
let dataSeq = 0;
/** A live reload of the open dashboard was skipped while the builder edited it. */
let skippedWhileEditing = false;

function clearReloadTimer(): void {
  if (reloadTimer !== null) {
    window.clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}

export const useDashboardStore = create<DashboardState>((set, get) => {
  /** The open dashboard is gone for this user: clear it, say so, reload the list. */
  const noLongerShared = (): void => {
    clearReloadTimer();
    pendingDetail = false;
    set({ current: null, data: {}, loadedAt: null, loading: false, dataLoading: false, loadError: NO_LONGER_SHARED });
    void get().refreshList();
  };

  const loadList = async (): Promise<void> => {
    const started = generation;
    try {
      const dashboards = await dashboardsApi.list();
      if (started !== generation) return;
      set({ dashboards, listLoaded: true });
    } catch (err) {
      if (started !== generation) return;
      console.error('[Dashboards] Failed to load the list', err);
      set({ listLoaded: true, loadError: get().loadError ?? LIST_ERROR });
    }
  };

  const loadData = async (): Promise<void> => {
    const dashboard = get().current;
    if (!dashboard) return;
    const started = generation;
    const seq = ++dataSeq;
    // Another dashboard opened since: this answer (even a 404) is not its.
    const opened = openSeq;
    const stale = () => started !== generation || seq !== dataSeq || opened !== openSeq;
    set({ dataLoading: true });
    try {
      const result = await dashboardsApi.data(dashboard.id);
      if (stale() || get().current?.id !== dashboard.id) return;
      const data: Record<number, MetricResult | MetricError> = {};
      for (const [id, value] of Object.entries(result.widgets ?? {})) data[Number(id)] = value;
      set({
        data,
        loadedAt: result.loaded_at ?? null,
        dataLoading: false,
        loadError: get().loadError === DATA_ERROR ? null : get().loadError,
      });
    } catch (err) {
      if (stale()) return;
      if (isNotFound(err)) {
        noLongerShared();
        return;
      }
      console.error('[Dashboards] Failed to load the data', err);
      // The last results stay on screen; the notice says they are stale.
      set({ dataLoading: false, loadError: DATA_ERROR });
    }
  };

  /** Fetch the open dashboard again (widgets may have been replaced), then its data. */
  const reloadCurrent = async (): Promise<void> => {
    const dashboard = get().current;
    if (!dashboard) return;
    // Never under the builder's draft: run it when editing ends.
    if (get().editing) {
      skippedWhileEditing = true;
      return;
    }
    const started = generation;
    const seq = ++openSeq;
    try {
      const fresh = await dashboardsApi.get(dashboard.id);
      if (started !== generation || seq !== openSeq || get().current?.id !== dashboard.id) return;
      if (get().editing) {
        skippedWhileEditing = true;
        return;
      }
      set({ current: fresh });
    } catch (err) {
      if (started !== generation || seq !== openSeq) return;
      if (isNotFound(err)) {
        noLongerShared();
        return;
      }
      console.error('[Dashboards] Failed to reload the dashboard', err);
    }
    await loadData();
  };

  const schedule = (withDetail: boolean): void => {
    pendingDetail = pendingDetail || withDetail;
    clearReloadTimer();
    reloadTimer = window.setTimeout(() => {
      reloadTimer = null;
      const detail = pendingDetail;
      pendingDetail = false;
      void (detail ? reloadCurrent() : loadData());
    }, LIVE_RELOAD_DELAY_MS);
  };

  /** A saved or copied dashboard becomes the open one, with fresh data. */
  const showSaved = async (saved: Dashboard): Promise<void> => {
    clearReloadTimer();
    pendingDetail = false;
    skippedWhileEditing = false;
    openSeq += 1;
    set({ current: saved, data: {}, loadedAt: null, loading: false, loadError: null });
    useViewStore.getState().setLastDashboardId(saved.id);
    await Promise.all([get().refreshList(), loadData()]);
  };

  return {
    ...initialData(),

    refreshList: () => {
      if (!listInFlight) {
        const current: Promise<void> = loadList().finally(() => {
          if (listInFlight === current) listInFlight = null;
        });
        listInFlight = current;
      }
      return listInFlight;
    },

    open: async (id) => {
      const started = generation;
      const seq = ++openSeq;
      clearReloadTimer();
      pendingDetail = false;
      const switching = get().current?.id !== id;
      set({
        loading: true,
        loadError: null,
        ...(switching ? { current: null, data: {}, loadedAt: null } : {}),
      });
      useViewStore.getState().setLastDashboardId(id);
      try {
        const dashboard = await dashboardsApi.get(id);
        if (started !== generation || seq !== openSeq) return;
        set({ current: dashboard, loading: false });
      } catch (err) {
        if (started !== generation || seq !== openSeq) return;
        if (isNotFound(err)) {
          noLongerShared();
          return;
        }
        console.error('[Dashboards] Failed to open a dashboard', err);
        set({ loading: false, loadError: OPEN_ERROR });
        return;
      }
      await loadData();
    },

    reloadData: async (immediate = false) => {
      if (!get().current) return;
      if (!immediate) {
        schedule(false);
        return;
      }
      clearReloadTimer();
      // An immediate reload replaces a pending live one; a pending detail
      // reload (the dashboard itself changed) still has to happen.
      if (pendingDetail) {
        pendingDetail = false;
        await reloadCurrent();
        return;
      }
      await loadData();
    },

    refreshCurrent: () => {
      if (!get().current) return;
      schedule(true);
    },

    cancelPendingReload: () => {
      clearReloadTimer();
      pendingDetail = false;
    },

    save: async (draft) => {
      const { id, ...body } = draft;
      const saved = id === undefined ? await dashboardsApi.create(body) : await dashboardsApi.update(id, body);
      await showSaved(saved);
      return saved;
    },

    remove: async (id) => {
      await dashboardsApi.remove(id);
      const wasOpen = get().current?.id === id;
      if (wasOpen) {
        clearReloadTimer();
        pendingDetail = false;
        set({ current: null, data: {}, loadedAt: null });
      }
      if (useViewStore.getState().lastDashboardId[tenantKey()] === id) {
        useViewStore.getState().setLastDashboardId(null);
      }
      await get().refreshList();
      if (wasOpen) {
        const next = get().pickInitial();
        if (next !== null) await get().open(next);
      }
    },

    duplicate: async (id, name) => {
      const saved = await dashboardsApi.create({ name, visibility: 'private', role_ids: [], source_id: id });
      await showSaved(saved);
      return saved;
    },

    setEditing: (editing) => {
      if (get().editing === editing) return;
      set({ editing });
      if (!editing && skippedWhileEditing) {
        skippedWhileEditing = false;
        void reloadCurrent();
      }
    },

    pickInitial: () => {
      const { dashboards } = get();
      if (dashboards.length === 0) return null;
      const last = useViewStore.getState().lastDashboardId[tenantKey()];
      if (last != null && dashboards.some((d) => d.id === last)) return last;
      return (dashboards.find((d) => d.is_default) ?? dashboards[0]).id;
    },

    reset: () => {
      generation += 1;
      listInFlight = null;
      clearReloadTimer();
      pendingDetail = false;
      skippedWhileEditing = false;
      set(initialData());
    },
  };
});
