/**
 * My Work — the signed-in user's own work outside the boards: the approval
 * requests they may decide, their bookings, and their own requests.
 *
 * Three tabs (`role="tablist"`, arrow keys move between them) with their
 * counts: My Approvals (requests to decide), My Assignments (my approved
 * bookings, derived from the loaded projects — current and upcoming by
 * default, All adds the past ones; Open shows the booking in its dialog) and
 * My Requests (an Open/Done filter). The request lists live in workStore:
 * loaded on mount and window focus, and kept live by the `approval:changed`
 * push and the `approvals` WebSocket slice. A decision or a cancel also
 * reloads the projects, whose booking rows carry the pending state.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Notice } from '@/components/common/Notice';
import { useWorkStore } from '@/stores/workStore';
import type { WorkTab } from '@/stores/workStore';
import { useAppStore } from '@/stores/appStore';
import { useDataLoader } from '@/hooks/useDataLoader';
import { approvalsApi } from '@/api/endpoints/approvals';
import { collectMyAssignments } from '@/utils/myAssignments';
import { formatDateISO } from '@/utils/date';
import { ApprovalRequestRow, MyRequestRow } from './ApprovalRequestRow';
import { MyAssignmentRow } from './MyAssignmentRow';
import type { ApprovalRequest } from '@/types';
import styles from './WorkView.module.css';

const TABS: ReadonlyArray<{ id: WorkTab; label: string }> = [
  { id: 'approvals', label: 'My Approvals' },
  { id: 'assignments', label: 'My Assignments' },
  { id: 'requests', label: 'My Requests' },
];

const EMPTY_SITES: ReadonlyMap<number, string> = new Map();

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

interface ChipOption<T extends string> {
  value: T;
  label: string;
}

function FilterChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<ChipOption<T>>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.filter} role="group" aria-label="Show">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${styles.filterChip} ${value === option.value ? styles.activeChip : ''}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const REQUEST_FILTERS: ReadonlyArray<ChipOption<'open' | 'done'>> = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
];

const ASSIGNMENT_FILTERS: ReadonlyArray<ChipOption<'upcoming' | 'all'>> = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'all', label: 'All' },
];

export function WorkView() {
  const mine = useWorkStore((s) => s.mine);
  const toDecide = useWorkStore((s) => s.toDecide);
  const loaded = useWorkStore((s) => s.loaded);
  const loadError = useWorkStore((s) => s.loadError);
  const activeTab = useWorkStore((s) => s.activeTab);
  const requestsFilter = useWorkStore((s) => s.requestsFilter);
  const assignmentsFilter = useWorkStore((s) => s.assignmentsFilter);
  const setActiveTab = useWorkStore((s) => s.setActiveTab);
  const setRequestsFilter = useWorkStore((s) => s.setRequestsFilter);
  const setAssignmentsFilter = useWorkStore((s) => s.setAssignmentsFilter);
  const refresh = useWorkStore((s) => s.refresh);
  const currentUserId = useAppStore((s) => s.currentUser?.id ?? null);
  const projects = useAppStore((s) => s.projects);
  const sites = useAppStore((s) => s.sites);
  const { refreshProjects } = useDataLoader();

  const [error, setError] = useState<string | null>(null);
  const tabRefs = useRef<Partial<Record<WorkTab, HTMLButtonElement | null>>>({});
  const baseId = useId();

  // Load on mount and on focus; the pushes are hints (per-process manager).
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const today = formatDateISO(new Date());
  const assignments = useMemo(
    () => (currentUserId === null ? [] : collectMyAssignments(projects, currentUserId, today)),
    [projects, currentUserId, today]
  );
  const upcomingAssignments = useMemo(() => assignments.filter((a) => a.upcoming), [assignments]);
  const siteNames = useMemo(
    () => (sites.length === 0 ? EMPTY_SITES : new Map(sites.map((s) => [s.id, s.name]))),
    [sites]
  );
  const pendingMine = useMemo(() => mine.filter((r) => r.status === 'pending'), [mine]);
  const closedMine = useMemo(() => mine.filter((r) => r.status !== 'pending'), [mine]);

  const counts: Record<WorkTab, number> = {
    approvals: toDecide.length,
    assignments: upcomingAssignments.length,
    requests: pendingMine.length,
  };

  const selectTab = (tab: WorkTab) => {
    setActiveTab(tab);
    setError(null);
    tabRefs.current[tab]?.focus();
  };

  const handleTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex((t) => t.id === activeTab);
    const next: Record<string, number> = {
      ArrowRight: (index + 1) % TABS.length,
      ArrowLeft: (index - 1 + TABS.length) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    selectTab(TABS[next[e.key]].id);
  };

  const handleDecided = useCallback(
    async (request: ApprovalRequest) => {
      // No setError(null): after a 409 ApprovalActions reports the error first,
      // then calls this to show the request's real fate.
      useWorkStore.getState().applyDecisionLocal(request.id);
      await refreshProjects();
      void refresh();
    },
    [refresh, refreshProjects]
  );

  const handleCancel = useCallback(
    async (request: ApprovalRequest) => {
      setError(null);
      try {
        await approvalsApi.cancel(request.id);
        useWorkStore.getState().applyDecisionLocal(request.id, 'cancelled');
        await refreshProjects();
      } catch (err) {
        setError(message(err, 'Could not cancel the request'));
        void refresh();
      }
    },
    [refresh, refreshProjects]
  );

  const panelId = `${baseId}-panel`;
  const tabId = (tab: WorkTab) => `${baseId}-tab-${tab}`;
  // The request lists come from the server; My Assignments from the projects.
  const showsRequests = activeTab !== 'assignments';

  // An empty request list is "nothing to do" only when it loaded; after a
  // failed load the error Notice speaks instead (lists that loaded still show).
  const emptyState = (text: string) => (loadError ? null : <p className={styles.empty}>{text}</p>);

  const renderPanel = () => {
    if (activeTab === 'assignments') {
      const shown = assignmentsFilter === 'all' ? assignments : upcomingAssignments;
      if (shown.length === 0) {
        return (
          <p className={styles.empty}>{assignmentsFilter === 'all' ? 'No bookings' : 'No upcoming bookings'}</p>
        );
      }
      return (
        <ul className={styles.list}>
          {shown.map((row) => (
            <MyAssignmentRow key={row.key} row={row} siteName={siteNames.get(row.project.site_id) ?? null} />
          ))}
        </ul>
      );
    }
    if (!loaded) return <p className={styles.empty}>Loading…</p>;
    if (activeTab === 'approvals') {
      if (toDecide.length === 0) return emptyState('No requests to decide');
      return (
        <ul className={styles.list}>
          {toDecide.map((request) => (
            <ApprovalRequestRow key={request.id} request={request} onDecided={handleDecided} onError={setError} />
          ))}
        </ul>
      );
    }
    const shown = requestsFilter === 'done' ? closedMine : pendingMine;
    if (shown.length === 0) {
      return emptyState(requestsFilter === 'done' ? 'No decided requests' : 'No pending requests');
    }
    return (
      <ul className={styles.list}>
        {shown.map((request) => (
          <MyRequestRow key={request.id} request={request} onCancel={handleCancel} />
        ))}
      </ul>
    );
  };

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist" aria-label="My Work">
          {TABS.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[tab.id] = el;
                }}
                id={tabId(tab.id)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                aria-label={`${tab.label}, ${counts[tab.id]} item${counts[tab.id] === 1 ? '' : 's'}`}
                className={`${styles.tab} ${selected ? styles.activeTab : ''}`}
                onClick={() => selectTab(tab.id)}
                onKeyDown={handleTabKey}
              >
                {tab.label}
                <span className={styles.tabCount} aria-hidden="true">
                  {counts[tab.id]}
                </span>
              </button>
            );
          })}
        </div>

        <div className={styles.toolbarRight}>
          {activeTab === 'requests' && (
            <FilterChips options={REQUEST_FILTERS} value={requestsFilter} onChange={setRequestsFilter} />
          )}
          {activeTab === 'assignments' && (
            <FilterChips options={ASSIGNMENT_FILTERS} value={assignmentsFilter} onChange={setAssignmentsFilter} />
          )}
        </div>
      </div>

      <div className={styles.body}>
        <div id={panelId} role="tabpanel" aria-labelledby={tabId(activeTab)} className={styles.panel}>
          {showsRequests && loadError && <Notice tone="error">{loadError}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
          {renderPanel()}
        </div>
      </div>
    </div>
  );
}
