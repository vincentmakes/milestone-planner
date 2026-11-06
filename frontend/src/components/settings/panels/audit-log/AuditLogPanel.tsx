/**
 * AuditLogPanel (Settings hub > General > Audit log, `system.audit_log`)
 *
 * The instance-wide audit log, newest first: sign-ins, admin changes with
 * their diffs, exports and the plan changes. Read-only — entries cannot be
 * edited or deleted; the retention purge (Settings → General) removes them.
 *
 * - Toolbar: the "{start}–{end} of {total}" count, the retention chip (the
 *   live `audit_log_retention_days` of appStore.instanceSettings), Refresh
 *   and Export CSV (the current filters, through `downloadFile`).
 * - Filters: search and IP address (debounced 300 ms), category and outcome
 *   chips, action and actor pickers, From / To days, Clear filters. Any
 *   change goes back to page 1.
 * - Numbered paging (`Pagination`) with a Per page select; a row click (or
 *   Enter / Space on the When cell's button) opens the Entry detail dialog.
 *   The table fits the hub without a sideways scroll: fixed columns, the
 *   free-text ones cut with an ellipsis (full text in `title`), and the
 *   origin left to the dialog.
 *
 * Local state only: nothing else reads the log. Every call is a GET, so
 * What-If never queues one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/common/Button';
import { DateField } from '@/components/common/DateRangeField';
import { FilterChips } from '@/components/common/FilterChips';
import type { FilterChipOption } from '@/components/common/FilterChips';
import { Icon, ClockIcon, DownloadIcon, RefreshIcon } from '@/components/common/Icon';
import { Input } from '@/components/common/Input';
import { Notice } from '@/components/common/Notice';
import { Pagination } from '@/components/common/Pagination';
import { SearchableSelect } from '@/components/common/SearchableSelect';
import type { SearchableOption } from '@/components/common/SearchableSelect';
import { Select } from '@/components/common/Select';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { auditLogApi } from '@/api/endpoints/auditLog';
import { getUsers } from '@/api/endpoints/users';
import { useHasPermission } from '@/hooks/useCan';
import { useAppStore } from '@/stores/appStore';
import { actionLabel, categoryLabel, outcomeLabel } from '@/utils/auditLabels';
import type { AuditLogEntry, AuditLogPage, User } from '@/types';
import { PanelToolbar } from '../../PanelToolbar';
import { AuditChip } from './AuditChip';
import { AuditLogEntryModal } from './AuditLogEntryModal';
import { categoryTone, EMPTY_VALUE, formatWhen, outcomeTone, targetText } from './auditDetails';
import {
  auditLogQuery,
  DEFAULT_PAGE_SIZE,
  EMPTY_AUDIT_FILTERS,
  hasActiveFilters,
  PAGE_SIZES,
} from './auditFilters';
import type { AuditFilters, CategoryFilter, OutcomeFilter } from './auditFilters';
import styles from './AuditLogPanel.module.css';

const AUDIT_LOG_DESCRIPTION =
  'Sign-ins and sign-outs, failed and locked-out attempts, user and settings changes, project and booking changes and exports, with the account, IP address and origin of each. Entries cannot be edited or deleted; only the retention purge removes them.';

const RETENTION_TITLE =
  'Entries older than the retention window are deleted. Change the window in General → Data management.';

/** How long the search and IP fields wait for the typing to stop. */
const FILTER_DEBOUNCE_MS = 300;

/** The server's caps on `q` and `ip` (longer is a 422). */
const SEARCH_MAX_LENGTH = 200;
const IP_MAX_LENGTH = 45;

const CATEGORY_OPTIONS: ReadonlyArray<FilterChipOption<CategoryFilter>> = [
  { value: 'all', label: 'All' },
  { value: 'auth', label: categoryLabel('auth') },
  { value: 'admin', label: categoryLabel('admin') },
  { value: 'access', label: categoryLabel('access') },
  { value: 'change', label: categoryLabel('change') },
];

const OUTCOME_OPTIONS: ReadonlyArray<FilterChipOption<OutcomeFilter>> = [
  { value: 'all', label: 'All' },
  { value: 'success', label: outcomeLabel('success') },
  { value: 'failure', label: outcomeLabel('failure') },
];

const PAGE_SIZE_OPTIONS = PAGE_SIZES.map((size) => ({ value: size, label: String(size) }));

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Could not load the audit log.';
}

function userName(user: User): string {
  return user.name || `${user.first_name} ${user.last_name}`.trim() || user.email;
}

/** "Kept 365 days", or "Kept indefinitely" for 0 (a missing or malformed value reads as the default 365). */
function retentionDays(value: string | undefined): number {
  const days = Number.parseInt(value ?? '', 10);
  return Number.isFinite(days) && days >= 0 ? days : 365;
}

export function AuditLogPanel() {
  const retentionSetting = useAppStore((s) => s.instanceSettings?.audit_log_retention_days);
  const storeUsers = useAppStore((s) => s.users);
  const canListUsers = useHasPermission('users.view');

  const [filters, setFilters] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS);
  const [searchDraft, setSearchDraft] = useState('');
  const [ipDraft, setIpDraft] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [result, setResult] = useState<AuditLogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [fetchedUsers, setFetchedUsers] = useState<User[]>([]);
  const [exportFailed, setExportFailed] = useState(false);
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const exportGuard = useSubmitGuard();
  const requestRef = useRef(0);
  const seenActors = useRef(new Map<number, string>());

  /** Apply a filter change and go back to page 1. */
  const updateFilters = useCallback((patch: Partial<AuditFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }, []);

  // The typed search and IP address apply once the typing stops.
  useEffect(() => {
    // The query trims both: a change of surrounding spaces only is no change (no page reset).
    if (searchDraft.trim() === filters.q.trim() && ipDraft.trim() === filters.ip.trim()) return;
    const timer = window.setTimeout(() => updateFilters({ q: searchDraft, ip: ipDraft }), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchDraft, ipDraft, filters.q, filters.ip, updateFilters]);

  // The string is the effect's key: a new query object with the same params refetches nothing.
  const queryKey = JSON.stringify(auditLogQuery(filters, { page, pageSize }));

  // One page per query; an overtaken answer is dropped.
  useEffect(() => {
    const id = ++requestRef.current;
    setLoading(true);
    auditLogApi
      .list(JSON.parse(queryKey))
      .then((answer) => {
        if (id !== requestRef.current) return;
        setResult(answer);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (id !== requestRef.current) return;
        setLoadError(errorMessage(err));
      })
      .finally(() => {
        if (id === requestRef.current) setLoading(false);
      });
  }, [queryKey, reloadKey]);

  // The Action filter's options: the keys recorded so far.
  useEffect(() => {
    let cancelled = false;
    auditLogApi
      .actions()
      .then((keys) => {
        if (!cancelled) setActions(keys);
      })
      .catch(() => {
        // The picker then reads "Nothing recorded yet"; the list shows its own error.
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // The Actor picker lists the accounts (appStore.users is only filled by Settings → Users).
  useEffect(() => {
    if (!canListUsers || storeUsers.length > 0) return;
    let cancelled = false;
    getUsers(true)
      .then((users) => {
        if (!cancelled) setFetchedUsers(users);
      })
      .catch(() => {
        // The picker keeps the actors of the rows held.
      });
    return () => {
      cancelled = true;
    };
  }, [canListUsers, storeUsers.length]);

  const total = result?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rows = useMemo(() => result?.items ?? [], [result]);

  // Past the last page (rows purged, a smaller total): show the last one.
  useEffect(() => {
    // `pageCount` is at least 1: an emptied log goes back to "Page 1 of 1".
    if (result && page > pageCount) setPage(pageCount);
  }, [result, page, pageCount]);

  const actionOptions = useMemo<SearchableOption[]>(() => {
    const keys = filters.action && !actions.includes(filters.action) ? [...actions, filters.action] : actions;
    return keys.map((key, index) => ({ id: index, label: actionLabel(key), hint: key }));
  }, [actions, filters.action]);
  const actionValue = useMemo(() => {
    if (!filters.action) return null;
    const index = actionOptions.findIndex((option) => option.hint === filters.action);
    return index === -1 ? null : index;
  }, [actionOptions, filters.action]);

  const actorOptions = useMemo<SearchableOption[]>(() => {
    const seen = seenActors.current;
    for (const user of storeUsers.length > 0 ? storeUsers : fetchedUsers) seen.set(user.id, userName(user));
    for (const row of rows) {
      const name = row.actor_name || row.actor_email;
      if (row.actor_user_id !== null && name && !seen.has(row.actor_user_id)) seen.set(row.actor_user_id, name);
    }
    return Array.from(seen, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [storeUsers, fetchedUsers, rows]);

  const filtered = hasActiveFilters(filters) || searchDraft.trim() !== '' || ipDraft.trim() !== '';

  const clearFilters = () => {
    setSearchDraft('');
    setIpDraft('');
    setFilters(EMPTY_AUDIT_FILTERS);
    setPage(1);
  };

  const refresh = () => setReloadKey((key) => key + 1);

  const handleExport = async () => {
    if (!exportGuard.begin()) return;
    setExportFailed(false);
    try {
      await auditLogApi.exportCsv(auditLogQuery(filters));
      // The export is itself recorded: show its row.
      refresh();
    } catch {
      setExportFailed(true);
    } finally {
      exportGuard.end();
    }
  };

  const days = retentionDays(retentionSetting);
  const start = total === 0 ? 0 : (Math.min(page, pageCount) - 1) * pageSize + 1;
  const end = Math.min(start + rows.length - 1, total);
  const countText = total === 0 || rows.length === 0 ? 'No entries' : `${start}–${end} of ${total}`;

  let body;
  if (result === null) {
    body = loading ? <div className={styles.loading}>Loading…</div> : null;
  } else if (rows.length === 0) {
    body = (
      <div className={styles.empty}>
        {filtered ? 'No entries match the current filters.' : 'Nothing recorded yet.'}
      </div>
    );
  } else {
    body = (
      <table className={`${styles.table} ${loading ? styles.busy : ''}`} aria-busy={loading || undefined}>
        {/* Fixed columns; Actor, Account and Target share the rest and cut with an ellipsis.
            The origin is in the entry detail only (web / system). */}
        <colgroup>
          <col className={styles.colWhen} />
          <col className={styles.colCategory} />
          <col className={styles.colAction} />
          <col className={styles.colOutcome} />
          <col />
          <col />
          <col />
          <col className={styles.colIp} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Category</th>
            <th scope="col">Action</th>
            <th scope="col">Outcome</th>
            <th scope="col">Actor</th>
            <th scope="col">Account</th>
            <th scope="col">Target</th>
            <th scope="col">IP address</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => {
            const when = formatWhen(entry.created_at);
            const action = actionLabel(entry.action);
            const actor = entry.actor_name || entry.actor_email || EMPTY_VALUE;
            const account = entry.subject_email || EMPTY_VALUE;
            const target = targetText(entry);
            return (
              // The whole row opens the entry on a click; the keyboard reaches it through the
              // When cell's button (Enter / Space), which keeps the row a table row for readers.
              <tr key={entry.id} className={styles.row} onClick={() => setSelected(entry)}>
                <td className={styles.nowrap}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.rowButton}
                    aria-haspopup="dialog"
                    aria-label={`Open entry detail: ${action}, ${when}`}
                  >
                    {when}
                  </Button>
                </td>
                <td>
                  <AuditChip tone={categoryTone(entry.category)} variant="outlined">
                    {categoryLabel(entry.category)}
                  </AuditChip>
                </td>
                <td className={styles.truncate} title={entry.action}>
                  {action}
                </td>
                <td>
                  <AuditChip tone={outcomeTone(entry.outcome)} variant="filled">
                    {outcomeLabel(entry.outcome)}
                  </AuditChip>
                </td>
                <td className={styles.truncate} title={actor}>
                  {actor}
                </td>
                <td className={styles.truncate} title={account}>
                  {account}
                </td>
                <td className={styles.truncate} title={target}>
                  {target}
                </td>
                <td className={styles.truncate} title={entry.ip ?? undefined}>
                  {entry.ip ? <code className={styles.code}>{entry.ip}</code> : EMPTY_VALUE}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <div className={styles.panel}>
      <p className={styles.intro}>{AUDIT_LOG_DESCRIPTION}</p>

      <PanelToolbar
        left={
          <div className={styles.toolbarChips}>
            {result !== null && (
              <AuditChip tone="neutral" variant="outlined">
                {countText}
              </AuditChip>
            )}
            <AuditChip tone={days === 0 ? 'warning' : 'neutral'} variant="outlined" title={RETENTION_TITLE}>
              <Icon icon={ClockIcon} size={13} />
              {days === 0 ? 'Kept indefinitely' : `Kept ${days} days`}
            </AuditChip>
          </div>
        }
        right={
          <>
            <Button
              variant="ghost"
              icon={<Icon icon={RefreshIcon} />}
              aria-label="Refresh"
              title="Refresh"
              onClick={refresh}
            />
            <Button
              variant="secondary"
              icon={<Icon icon={DownloadIcon} />}
              disabled={exportGuard.isSubmitting}
              aria-busy={exportGuard.isSubmitting || undefined}
              onClick={() => void handleExport()}
            >
              {exportGuard.isSubmitting ? 'Exporting…' : 'Export CSV'}
            </Button>
          </>
        }
      />

      {exportFailed && (
        <Notice tone="error" className={styles.notice} onDismiss={() => setExportFailed(false)}>
          Export failed.
        </Notice>
      )}

      <div className={styles.filters}>
        <Input
          className={styles.searchField}
          label="Search"
          fullWidth
          placeholder="Email, name or target…"
          maxLength={SEARCH_MAX_LENGTH}
          value={searchDraft}
          autoComplete="off"
          onChange={(e) => setSearchDraft(e.target.value)}
        />
        <div className={styles.filterField}>
          <span className={styles.filterLabel} aria-hidden="true">
            Category
          </span>
          <FilterChips
            label="Category"
            options={CATEGORY_OPTIONS}
            value={filters.category}
            onChange={(category) => updateFilters({ category })}
          />
        </div>
        <div className={styles.filterField}>
          <span className={styles.filterLabel} aria-hidden="true">
            Outcome
          </span>
          <FilterChips
            label="Outcome"
            options={OUTCOME_OPTIONS}
            value={filters.outcome}
            onChange={(outcome) => updateFilters({ outcome })}
          />
        </div>
        <SearchableSelect
          className={styles.pickerField}
          label="Action"
          options={actionOptions}
          value={actionValue}
          emptyLabel="Any action"
          emptyText="Nothing recorded yet"
          noMatchText="No action matches"
          searchLabel="Search actions"
          onChange={(id) => updateFilters({ action: id === null ? null : (actionOptions[id]?.hint ?? null) })}
        />
        <SearchableSelect
          className={styles.pickerField}
          label="Actor"
          options={actorOptions}
          value={filters.actorUserId}
          emptyLabel="Anyone"
          searchLabel="Search people"
          onChange={(actorUserId) => updateFilters({ actorUserId })}
        />
        <Input
          className={styles.ipField}
          label="IP address"
          fullWidth
          placeholder="e.g. 203.0.113.7"
          maxLength={IP_MAX_LENGTH}
          value={ipDraft}
          autoComplete="off"
          onChange={(e) => setIpDraft(e.target.value)}
        />
        <div className={styles.dateField}>
          <DateField
            label="From"
            value={filters.since}
            maxDate={filters.until || undefined}
            markSiteCalendar={false}
            fullWidth
            onChange={(since) => updateFilters({ since })}
          />
        </div>
        <div className={styles.dateField}>
          <DateField
            label="To"
            value={filters.until}
            minDate={filters.since || undefined}
            markSiteCalendar={false}
            fullWidth
            onChange={(until) => updateFilters({ until })}
          />
        </div>
        <Button variant="ghost" disabled={!filtered} onClick={clearFilters}>
          Clear filters
        </Button>
      </div>

      {loadError && (
        <Notice tone="error" className={styles.notice}>
          {loadError}
        </Notice>
      )}

      <div className={styles.tableWrapper}>{body}</div>

      {result !== null && (
        <div className={styles.footer}>
          <div className={styles.perPage}>
            <Select
              label="Per page"
              options={PAGE_SIZE_OPTIONS}
              value={pageSize}
              fullWidth
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
            />
          </div>
          <Pagination page={page} pageCount={pageCount} onPageChange={setPage} />
        </div>
      )}

      <AuditLogEntryModal entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
