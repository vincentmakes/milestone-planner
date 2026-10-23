/**
 * DashboardsView — the dashboards shared with the user (2.1.0), read mode.
 *
 * The toolbar picks a dashboard (`SearchableSelect`; the hint says where it
 * comes from: *Default*, *Mine*, *Everyone* or *Shared by <owner>*, and the
 * list is ordered in those groups) and refreshes its data; the builder's
 * actions (Task 4) go in the `builder-actions` slot, shown only to holders
 * of `dashboards.manage` on screens wider than a phone. Below: the
 * dashboard's description, an error `Notice` (e.g. a dashboard no longer
 * shared), the empty state, and the widget grid.
 *
 * On mount the list loads and the initial dashboard opens (the last one
 * opened in this tenant, else the default, else the first); window focus
 * reloads the data, and leaving the view drops a pending live reload. Below
 * 640 px the grid is view-only. Lazy-loaded by MainLayout (ECharts and the
 * grid stay in this chunk) inside an error boundary.
 */

import { useEffect, useMemo, useState } from 'react';
import { useDashboardStore } from '@/stores/dashboardStore';
import { useAppStore } from '@/stores/appStore';
import { useHasPermission } from '@/hooks/useCan';
import { Button } from '@/components/common/Button';
import { Notice } from '@/components/common/Notice';
import { SearchableSelect } from '@/components/common/SearchableSelect';
import type { SearchableOption } from '@/components/common/SearchableSelect';
import { Icon, RefreshIcon } from '@/components/common/Icon';
import type { DashboardSummary } from '@/types';
import { DashboardGrid } from './DashboardGrid';
import styles from './DashboardsView.module.css';

export const EMPTY_TEXT = 'No dashboard is shared with you yet.';

/** The phone breakpoint of UI_GUIDELINES §2.12. */
export const PHONE_QUERY = '(max-width: 640px)';

function readIsPhone(): boolean {
  // jsdom has no matchMedia: the wide layout, like useHeaderDensity.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

/** Whether the screen is phone-sized (≤ 640 px), following resizes. */
function useIsPhone(): boolean {
  const [phone, setPhone] = useState(readIsPhone);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return phone;
}

/** Where a dashboard comes from, and its group rank in the picker. */
function origin(dashboard: DashboardSummary, userId: number | null): { hint: string; rank: number } {
  if (dashboard.is_default) return { hint: 'Default', rank: 0 };
  if (userId !== null && dashboard.owner_id === userId) return { hint: 'Mine', rank: 1 };
  if (dashboard.visibility === 'everyone') return { hint: 'Everyone', rank: 3 };
  return { hint: dashboard.owner_name ? `Shared by ${dashboard.owner_name}` : 'Shared with me', rank: 2 };
}

export function DashboardsView() {
  const dashboards = useDashboardStore((s) => s.dashboards);
  const current = useDashboardStore((s) => s.current);
  const data = useDashboardStore((s) => s.data);
  const loading = useDashboardStore((s) => s.loading);
  const dataLoading = useDashboardStore((s) => s.dataLoading);
  const loadError = useDashboardStore((s) => s.loadError);
  const listLoaded = useDashboardStore((s) => s.listLoaded);
  const userId = useAppStore((s) => s.currentUser?.id ?? null);
  const canManage = useHasPermission('dashboards.manage');
  const phone = useIsPhone();

  // The list, then the initial dashboard (or the open one's fresh data).
  useEffect(() => {
    let cancelled = false;
    const store = useDashboardStore.getState();
    void store.refreshList().then(() => {
      if (cancelled) return;
      const state = useDashboardStore.getState();
      const open = state.current;
      if (open && state.dashboards.some((d) => d.id === open.id)) {
        void state.reloadData(true);
        return;
      }
      const initial = state.pickInitial();
      if (initial !== null) void state.open(initial);
    });
    return () => {
      cancelled = true;
      useDashboardStore.getState().cancelPendingReload();
    };
  }, []);

  // Back to the tab: fresh numbers (live pushes may have been missed).
  useEffect(() => {
    const onFocus = () => {
      const store = useDashboardStore.getState();
      void store.refreshList();
      void store.reloadData(true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const options = useMemo<SearchableOption[]>(() => {
    return dashboards
      .map((dashboard) => ({ dashboard, ...origin(dashboard, userId) }))
      .sort((a, b) => a.rank - b.rank || a.dashboard.name.localeCompare(b.dashboard.name))
      .map(({ dashboard, hint }) => ({ id: dashboard.id, label: dashboard.name, hint }));
  }, [dashboards, userId]);

  const empty = listLoaded && dashboards.length === 0;

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.left}>
          <SearchableSelect
            aria-label="Dashboard"
            className={styles.picker}
            options={options}
            value={current?.id ?? null}
            onChange={(id) => {
              if (id !== null) void useDashboardStore.getState().open(id);
            }}
            placeholder={empty ? 'No dashboard' : 'Choose a dashboard'}
            disabled={options.length === 0}
            searchLabel="Find a dashboard"
            searchPlaceholder="Type to find a dashboard…"
            noMatchText="No dashboard matches"
            emptyText="No dashboard"
          />
        </div>
        <div className={styles.right}>
          <Button
            variant="ghost"
            icon={<Icon icon={RefreshIcon} />}
            onClick={() => void useDashboardStore.getState().reloadData(true)}
            loading={dataLoading}
            disabled={!current}
          >
            Refresh
          </Button>
          {canManage && !phone && <div data-slot="builder-actions" className={styles.builderActions} />}
        </div>
      </div>

      <div className={styles.content}>
        {current?.description && <p className={styles.description}>{current.description}</p>}
        {loadError && <Notice tone="error">{loadError}</Notice>}
        {empty && <p className={styles.empty}>{EMPTY_TEXT}</p>}
        {!current && loading && (
          <p className={styles.empty} role="status">
            Loading…
          </p>
        )}
        {current && current.widgets.length === 0 && (
          <p className={styles.empty}>This dashboard has no widgets yet.</p>
        )}
        {current && current.widgets.length > 0 && (
          <DashboardGrid widgets={current.widgets} data={data} dataLoading={dataLoading} editing={false} />
        )}
      </div>
    </div>
  );
}
