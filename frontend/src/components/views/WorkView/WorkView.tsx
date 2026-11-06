/**
 * My Work — the signed-in user's own work outside the boards: the approval
 * requests they may decide, their bookings, and their own requests.
 *
 * Four tabs (`role="tablist"`, arrow keys move between them) with their
 * counts: My Approvals (requests to decide), My Assignments (my approved
 * bookings, derived from the loaded projects — current and upcoming by
 * default, All adds the past ones; Open shows the booking in its dialog),
 * My Requests (an Open/Done filter) and History (closed requests I decided,
 * or every closed one at my sites with `approvals.view_all`; filters, paged
 * by Load more, loaded when the tab opens). The request lists live in workStore:
 * loaded on mount and window focus, and kept live by the `approval:changed`
 * push and the `approvals` WebSocket slice. A decision or a cancel also
 * reloads the projects, whose booking rows carry the pending state.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Notice } from '@/components/common/Notice';
import { Button } from '@/components/common/Button';
import { FilterChips } from '@/components/common/FilterChips';
import type { FilterChipOption as ChipOption } from '@/components/common/FilterChips';
import { SearchableSelect } from '@/components/common/SearchableSelect';
import type { SearchableOption } from '@/components/common/SearchableSelect';
import { useWorkStore } from '@/stores/workStore';
import type { HistoryOutcome, HistoryScope, WorkTab } from '@/stores/workStore';
import { useAppStore } from '@/stores/appStore';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useHasPermission } from '@/hooks/useCan';
import { approvalsApi } from '@/api/endpoints/approvals';
import { collectMyAssignments } from '@/utils/myAssignments';
import { formatDateISO } from '@/utils/date';
import { ApprovalRequestRow, HistoryRow, MyRequestRow } from './ApprovalRequestRow';
import { historyPeople, historyProjects } from './historyOptions';
import { MyAssignmentRow } from './MyAssignmentRow';
import type { ApprovalRequest } from '@/types';
import styles from './WorkView.module.css';

const TABS: ReadonlyArray<{ id: WorkTab; label: string }> = [
  { id: 'approvals', label: 'My Approvals' },
  { id: 'assignments', label: 'My Assignments' },
  { id: 'requests', label: 'My Requests' },
  { id: 'history', label: 'History' },
];

const EMPTY_SITES: ReadonlyMap<number, string> = new Map();

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

const REQUEST_FILTERS: ReadonlyArray<ChipOption<'open' | 'done'>> = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
];

const ASSIGNMENT_FILTERS: ReadonlyArray<ChipOption<'upcoming' | 'all'>> = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'all', label: 'All' },
];

const DECIDED_SCOPE: ChipOption<HistoryScope> = { value: 'decided', label: 'Decided by me' };
const ALL_SCOPE: ChipOption<HistoryScope> = { value: 'all', label: 'All requests' };

const DECIDED_OUTCOMES: ReadonlyArray<ChipOption<HistoryOutcome>> = [
  { value: 'all', label: 'All' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
];
const ALL_OUTCOMES: ReadonlyArray<ChipOption<HistoryOutcome>> = [
  ...DECIDED_OUTCOMES,
  { value: 'expired', label: 'Expired' },
  { value: 'superseded', label: 'Superseded' },
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
  const history = useWorkStore((s) => s.history);
  const loadHistory = useWorkStore((s) => s.loadHistory);
  const loadMoreHistory = useWorkStore((s) => s.loadMoreHistory);
  const setHistoryFilters = useWorkStore((s) => s.setHistoryFilters);
  const currentUserId = useAppStore((s) => s.currentUser?.id ?? null);
  const projects = useAppStore((s) => s.projects);
  const sites = useAppStore((s) => s.sites);
  const users = useAppStore((s) => s.users);
  const staff = useAppStore((s) => s.staff);
  const canViewAll = useHasPermission('approvals.view_all');
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

  // The History loads its page 1 whenever the tab opens.
  const historyOpen = activeTab === 'history';
  useEffect(() => {
    if (historyOpen) void loadHistory();
  }, [historyOpen, loadHistory]);

  // Options seen once stay, so a chosen person or project keeps its name
  // while the filtered list no longer shows them.
  const seenPeople = useRef(new Map<number, string>());
  const seenProjects = useRef(new Map<number, string>());
  const peopleOptions: SearchableOption[] = useMemo(
    () => historyPeople(seenPeople.current, users, staff, history.rows),
    [users, staff, history.rows]
  );
  const projectOptions: SearchableOption[] = useMemo(
    () => historyProjects(seenProjects.current, projects, history.rows),
    [projects, history.rows]
  );

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
    history: history.rows.length,
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
  // The two request lists come from refresh(); the History has its own error.
  const showsRequests = activeTab === 'approvals' || activeTab === 'requests';

  // An empty request list is "nothing to do" only when it loaded; after a
  // failed load the error Notice speaks instead (lists that loaded still show).
  const emptyState = (text: string) => (loadError ? null : <p className={styles.empty}>{text}</p>);

  const renderHistory = () => {
    const { filters } = history;
    const allMode = filters.scope === 'all';
    let list: ReactNode = null;
    if (history.rows.length > 0) {
      list = (
        <ul className={styles.list}>
          {history.rows.map((request) => (
            <HistoryRow key={request.id} request={request} />
          ))}
        </ul>
      );
    } else if (history.loading || !history.loaded) {
      list = <p className={styles.empty}>Loading…</p>;
    } else if (!history.error) {
      list = <p className={styles.empty}>No decided requests yet.</p>;
    }
    return (
      <>
        {/* Row 1: the two chip groups; row 2: the labelled pickers, aligned on their boxes. */}
        <div className={styles.historyControls}>
          <div className={styles.historyChips}>
            <FilterChips
              label="Requests"
              options={canViewAll ? [DECIDED_SCOPE, ALL_SCOPE] : [DECIDED_SCOPE]}
              value={canViewAll ? filters.scope : 'decided'}
              onChange={(scope) => void setHistoryFilters({ scope })}
            />
            <FilterChips
              label="Outcome"
              options={allMode ? ALL_OUTCOMES : DECIDED_OUTCOMES}
              value={filters.outcome}
              onChange={(outcome) => void setHistoryFilters({ outcome })}
            />
          </div>
          <div className={styles.historyPickers}>
            <SearchableSelect
              className={styles.historySelect}
              label="Project"
              options={projectOptions}
              value={filters.projectId}
              emptyLabel="Any project"
              searchLabel="Search projects"
              onChange={(projectId) => void setHistoryFilters({ projectId })}
            />
            <SearchableSelect
              className={styles.historySelect}
              label="Requested by"
              options={peopleOptions}
              value={filters.requesterId}
              emptyLabel="Anyone"
              searchLabel="Search people"
              onChange={(requesterId) => void setHistoryFilters({ requesterId })}
            />
            {allMode && (
              <SearchableSelect
                className={styles.historySelect}
                label="Decided by"
                options={peopleOptions}
                value={filters.decidedBy}
                emptyLabel="Anyone"
                searchLabel="Search people"
                onChange={(decidedBy) => void setHistoryFilters({ decidedBy })}
              />
            )}
          </div>
        </div>
        {history.error && <Notice tone="error">{history.error}</Notice>}
        {list}
        {history.hasMore && history.rows.length > 0 && (
          <div className={styles.loadMore}>
            <Button
              variant="ghost"
              size="md"
              onClick={() => void loadMoreHistory()}
              loading={history.loading}
              disabled={history.loading}
            >
              Load more
            </Button>
          </div>
        )}
      </>
    );
  };

  const renderPanel = () => {
    if (activeTab === 'history') return renderHistory();
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
            <FilterChips label="Show" options={REQUEST_FILTERS} value={requestsFilter} onChange={setRequestsFilter} />
          )}
          {activeTab === 'assignments' && (
            <FilterChips
              label="Show"
              options={ASSIGNMENT_FILTERS}
              value={assignmentsFilter}
              onChange={setAssignmentsFilter}
            />
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
