/**
 * BankHolidaysPanel (Settings hub > Bank holidays)
 *
 * Holidays of one site at a time: add, edit and delete them, refresh them from
 * the Nager holiday API, export them as .ics, or import an .ics file into one or
 * more sites. Editing a Nager holiday turns it into a custom one, which then
 * takes precedence over Nager for that date. Superusers only see their sites.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Notice } from '@/components/common/Notice';
import { Button } from '@/components/common/Button';
import { PanelToolbar } from '../PanelToolbar';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { ICSImportPanel, ICS_IMPORT_WHAT_IF_MESSAGE } from '@/components/common/ICSImportPanel';
import type { ICSImportRow } from '@/components/common/ICSImportPanel';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import {
  getBankHolidays,
  createBankHoliday,
  updateBankHoliday,
  deleteBankHoliday,
  importBankHolidays,
  refreshBankHolidays,
} from '@/api';
import { buildICS, downloadICS, clampText } from '@/utils/ics';
import type { ParsedICSEvent } from '@/utils/ics';
import type { BankHoliday, CalendarImportResult } from '@/types';
import {
  useManageableSites,
  pickDefaultSiteId,
  refreshCurrentSiteHolidays,
  formatCalendarDate,
  overlapsYear,
  collectYears,
  nameKey,
} from './calendarUtils';
import { SiteChecklist } from './SiteChecklist';
import {
  EditIcon,
  TrashIcon,
  PlusIcon,
  DownloadIcon,
  UploadIcon,
  RefreshIcon,
  BackIcon,
} from './PanelIcons';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import styles from './CalendarPanel.module.css';

/** Key of a holiday for duplicate checks: same first day and name */
function holidayKey(date: string, name: string): string {
  return `${date.slice(0, 10)}|${nameKey(name)}`;
}

type FormState =
  | { mode: 'add' }
  | { mode: 'edit'; holiday: BankHoliday };

export function BankHolidaysPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const settingsIntent = useUIStore((s) => s.settingsIntent);
  const clearSettingsIntent = useUIStore((s) => s.clearSettingsIntent);
  const currentSite = useAppStore((s) => s.currentSite);
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  const manageableSites = useManageableSites();

  const [siteId, setSiteId] = useState<number | null>(() =>
    pickDefaultSiteId(manageableSites, currentSite?.id, settingsIntent?.siteId)
  );
  const [year, setYear] = useState<number | 'all'>(() => new Date().getFullYear());
  const [holidays, setHolidays] = useState<BankHoliday[]>([]);
  const [loadedSiteId, setLoadedSiteId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [view, setView] = useState<'list' | 'import'>('list');
  const [form, setForm] = useState<FormState | null>(null);
  const [pendingEditId, setPendingEditId] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // One delete at a time
  const deleteGuard = useSubmitGuard();
  const [importSiteIds, setImportSiteIds] = useState<number[]>([]);
  // Holidays of the import target sites (cached per site), for duplicate flags
  const [targetHolidays, setTargetHolidays] = useState<Record<number, BankHoliday[]>>({});
  // In-flight target fetches: site id -> request token (only the latest one is kept)
  const fetchingTargets = useRef(new Map<number, number>());
  const nextFetchToken = useRef(0);

  const invalidateTargetHolidays = useCallback((siteIds: number[]) => {
    for (const id of siteIds) fetchingTargets.current.delete(id);
    setTargetHolidays((prev) => {
      const next = { ...prev };
      for (const id of siteIds) delete next[id];
      return next;
    });
  }, []);

  const site = manageableSites.find((s) => s.id === siteId) ?? null;

  // Fall back to a valid site if the list changes under us
  useEffect(() => {
    if (siteId === null || !manageableSites.some((s) => s.id === siteId)) {
      setSiteId(pickDefaultSiteId(manageableSites, currentSite?.id));
    }
  }, [manageableSites, siteId, currentSite?.id]);

  const loadHolidays = useCallback(async (targetSiteId: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getBankHolidays(targetSiteId);
      setHolidays(data);
      setLoadedSiteId(targetSiteId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bank holidays');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (siteId !== null) loadHolidays(siteId);
  }, [siteId, loadHolidays]);

  // Opened from elsewhere (Staff view, Sites): pick the site, then add or edit
  useEffect(() => {
    if (!settingsIntent) return;
    if (settingsIntent.siteId && manageableSites.some((s) => s.id === settingsIntent.siteId)) {
      setSiteId(settingsIntent.siteId);
    }
    if (settingsIntent.type === 'add') {
      setView('list');
      setForm({ mode: 'add' });
    } else if (settingsIntent.type === 'edit') {
      setView('list');
      setPendingEditId(settingsIntent.id);
    }
    clearSettingsIntent();
  }, [settingsIntent, clearSettingsIntent, manageableSites]);

  // Resolve a pending edit once the right site's holidays are loaded
  useEffect(() => {
    if (pendingEditId === null || loadedSiteId !== siteId || isLoading) return;
    const holiday = holidays.find((h) => h.id === pendingEditId);
    if (holiday) {
      setForm({ mode: 'edit', holiday });
      setYear(Number(holiday.date.slice(0, 4)));
    }
    setPendingEditId(null);
  }, [pendingEditId, holidays, loadedSiteId, siteId, isLoading]);

  const years = useMemo(() => collectYears(holidays), [holidays]);

  const visibleHolidays = useMemo(
    () =>
      holidays
        .filter((h) => year === 'all' || overlapsYear(h.date, h.end_date, year))
        .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)),
    [holidays, year]
  );

  const changeSite = (id: number) => {
    setSiteId(id);
    setForm(null);
    setNotice(null);
    setError(null);
  };

  const afterChange = async (siteIds: number[]) => {
    // Cached import-target holidays of these sites are stale now
    invalidateTargetHolidays(siteIds);
    if (siteId !== null && siteIds.includes(siteId)) await loadHolidays(siteId);
    await refreshCurrentSiteHolidays(siteIds);
  };

  const handleDelete = async (holiday: BankHoliday) => {
    if (siteId === null) return;
    const message = holiday.is_custom
      ? `Delete the holiday "${holiday.name}"?`
      : `Delete the holiday "${holiday.name}"?\n\nIt comes from Nager, so it will return on the next refresh from Nager.`;
    // A second click while the first DELETE runs would 404 and show an error
    if (!deleteGuard.begin()) return;
    try {
      if (!window.confirm(message)) return;
      setError(null);
      await deleteBankHoliday(siteId, holiday.id);
      if (form?.mode === 'edit' && form.holiday.id === holiday.id) setForm(null);
      await afterChange([siteId]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete holiday');
    } finally {
      deleteGuard.end();
    }
  };

  const handleRefresh = async () => {
    if (!site) return;
    if (!window.confirm(`Refresh the bank holidays of ${site.name} from the Nager holiday API?`)) return;
    setIsRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      const refreshed = await refreshBankHolidays(site.id);
      setHolidays(refreshed);
      setLoadedSiteId(site.id);
      invalidateTargetHolidays([site.id]);
      setNotice(`Holidays refreshed from Nager (${refreshed.length} in total).`);
      await refreshCurrentSiteHolidays([site.id]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh holidays');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleExport = () => {
    if (!site || visibleHolidays.length === 0) return;
    const content = buildICS(
      visibleHolidays.map((h) => ({
        uid: `bankholiday-${h.id}@milestone`,
        summary: h.name,
        start_date: h.date,
        end_date: h.end_date,
        transparency: 'TRANSPARENT' as const,
      })),
      `Bank Holidays - ${site.name}`
    );
    const suffix = year === 'all' ? '' : `-${year}`;
    downloadICS(content, `bank-holidays-${site.name}${suffix}.ics`);
  };

  const openImport = () => {
    setForm(null);
    setNotice(null);
    setError(null);
    setImportSiteIds(siteId !== null ? [siteId] : []);
    setView('import');
  };

  // Load the holidays of each selected import target not cached yet (the site
  // shown in the list is already loaded).
  useEffect(() => {
    if (view !== 'import') return;
    for (const targetId of importSiteIds) {
      if (targetId === loadedSiteId || targetHolidays[targetId] || fetchingTargets.current.has(targetId)) {
        continue;
      }
      const token = ++nextFetchToken.current;
      fetchingTargets.current.set(targetId, token);
      const isLatest = () => fetchingTargets.current.get(targetId) === token;
      getBankHolidays(targetId)
        .then((data) => {
          // A newer request (after an invalidation) supersedes this one
          if (isLatest()) setTargetHolidays((prev) => ({ ...prev, [targetId]: data }));
        })
        .catch((err) => console.error('Failed to load holidays for duplicate check:', err))
        .finally(() => {
          if (isLatest()) fetchingTargets.current.delete(targetId);
        });
    }
  }, [view, importSiteIds, loadedSiteId, targetHolidays]);

  // Holiday keys per selected target; null while one of them is still loading
  const targetKeySets = useMemo(() => {
    const sets: Set<string>[] = [];
    for (const targetId of importSiteIds) {
      const list = targetId === loadedSiteId ? holidays : targetHolidays[targetId];
      if (!list) return null;
      sets.push(new Set(list.map((h) => holidayKey(h.date, h.name))));
    }
    return sets;
  }, [importSiteIds, loadedSiteId, holidays, targetHolidays]);

  // Duplicate = same date and name already on EVERY selected target site, so
  // the import would skip it everywhere. Memoized: the import panel re-flags
  // its rows whenever this function changes.
  const isDuplicate = useCallback(
    (event: ParsedICSEvent) => {
      if (!targetKeySets || targetKeySets.length === 0) return false;
      const key = holidayKey(event.start_date, clampText(event.summary) || 'Holiday');
      return targetKeySets.every((set) => set.has(key));
    },
    [targetKeySets]
  );

  const handleImport = async (rows: ICSImportRow[]): Promise<CalendarImportResult> => {
    const items = rows.map((row) => ({
      date: row.start_date,
      end_date: row.end_date !== row.start_date ? row.end_date : null,
      // The backend caps names at 200 chars; one long SUMMARY must not fail the import
      name: clampText(row.summary) || 'Holiday',
    }));
    const total: CalendarImportResult = { created: 0, skipped: 0 };
    for (const targetId of importSiteIds) {
      const result = await importBankHolidays(targetId, items);
      total.created += result.created;
      total.skipped += result.skipped;
    }
    await afterChange(importSiteIds);
    return total;
  };

  if (manageableSites.length === 0) {
    return <div className={styles.empty}>You are not assigned to any site.</div>;
  }

  if (view === 'import') {
    const targetNames = manageableSites
      .filter((s) => importSiteIds.includes(s.id))
      .map((s) => s.name)
      .join(', ');
    return (
      <div className={styles.container}>
        <div className={styles.importHeader}>
          <Button variant="ghost" icon={<BackIcon />} onClick={() => setView('list')}>
            Back to holidays
          </Button>
        </div>
        <div className={styles.importTargets}>
          <span className={styles.label}>Import into</span>
          <SiteChecklist
            sites={manageableSites}
            selected={importSiteIds}
            onChange={setImportSiteIds}
            label="Import into sites"
          />
          <p className={styles.help}>
            Imported holidays are stored as custom holidays. Entries with the same date and name
            as an existing holiday of a site are skipped for that site; rows marked as existing
            are already on every selected site.
          </p>
        </div>
        <ICSImportPanel
          title={targetNames ? `Import holidays into ${targetNames}` : 'Import holidays'}
          itemLabel="holiday"
          isDuplicate={isDuplicate}
          onImport={handleImport}
          disabledReason={
            whatIfMode
              ? ICS_IMPORT_WHAT_IF_MESSAGE
              : importSiteIds.length === 0
                ? 'Select at least one site to import into.'
                : null
          }
        />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <PanelToolbar
        align="end"
        left={
          <div className={styles.filters}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="holiday-site">Site</label>
              <select
                id="holiday-site"
                className={styles.select}
                value={siteId ?? ''}
                onChange={(e) => changeSite(Number(e.target.value))}
              >
                {manageableSites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="holiday-year">Year</label>
              <select
                id="holiday-year"
                className={styles.select}
                value={year}
                onChange={(e) => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              >
                <option value="all">All years</option>
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          </div>
        }
        right={
          <>
            <Button
              variant="secondary"
              icon={<RefreshIcon />}
              onClick={handleRefresh}
              disabled={isRefreshing || !site?.country_code}
              title={site?.country_code ? 'Fetch public holidays from the Nager API' : "Set the site's country in Sites first"}
            >
              {isRefreshing ? 'Refreshing...' : 'Refresh from Nager'}
            </Button>
            <Button
              variant="secondary"
              icon={<DownloadIcon />}
              onClick={handleExport}
              disabled={visibleHolidays.length === 0}
            >
              Export .ics
            </Button>
            <Button variant="secondary" icon={<UploadIcon />} onClick={openImport}>
              Import .ics
            </Button>
            <Button icon={<PlusIcon />} onClick={() => setForm({ mode: 'add' })}>
              Add holiday
            </Button>
          </>
        }
      />

      {whatIfMode && (
        <div className={styles.notice}>
          What-If mode is active: holiday changes are queued and only reach the server when you
          apply What-If.
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <div className={styles.notice}>{notice}</div>}

      {form && siteId !== null && (
        <HolidayForm
          key={form.mode === 'edit' ? form.holiday.id : 'add'}
          siteId={siteId}
          siteName={site?.name ?? ''}
          holiday={form.mode === 'edit' ? form.holiday : null}
          onDirtyChange={onDirtyChange}
          onCancel={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            await afterChange([siteId]);
          }}
        />
      )}

      <div className={styles.tableWrapper}>
        {isLoading && holidays.length === 0 ? (
          <div className={styles.empty}>Loading holidays...</div>
        ) : visibleHolidays.length === 0 ? (
          <div className={styles.empty}>
            {holidays.length === 0
              ? 'No holidays for this site yet. Add one, import an .ics file or refresh from Nager.'
              : 'No holidays in this year.'}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>End date</th>
                <th>Name</th>
                <th>Source</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visibleHolidays.map((holiday) => {
                const isEditing = form?.mode === 'edit' && form.holiday.id === holiday.id;
                const hasEnd = holiday.end_date && holiday.end_date.slice(0, 10) !== holiday.date.slice(0, 10);
                return (
                  <tr key={holiday.id} className={isEditing ? styles.highlight : undefined}>
                    <td className={styles.dateCell}>{formatCalendarDate(holiday.date)}</td>
                    <td className={styles.dateCell}>{hasEnd ? formatCalendarDate(holiday.end_date) : '—'}</td>
                    <td className={styles.nameCell}>{holiday.name}</td>
                    <td>
                      {holiday.is_custom ? (
                        <span className={`${styles.badge} ${styles.badgeCustom}`}>Custom</span>
                      ) : (
                        <span className={`${styles.badge} ${styles.badgeNager}`}>Nager</span>
                      )}
                    </td>
                    <td className={styles.actionsCell}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => setForm({ mode: 'edit', holiday })}
                        title="Edit holiday"
                        aria-label={`Edit ${holiday.name}`}
                      >
                        <EditIcon />
                      </button>
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.danger}`}
                        onClick={() => handleDelete(holiday)}
                        disabled={deleteGuard.isSubmitting}
                        title="Delete holiday"
                        aria-label={`Delete ${holiday.name}`}
                      >
                        <TrashIcon />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className={styles.help}>
        Holidays are non-working days in every plan of the site. Nager holidays are fetched from
        the public holiday API; editing one turns it into a custom holiday, which then wins over
        Nager for that date on later refreshes.
      </p>
    </div>
  );
}

// =============================================================================
// ADD / EDIT FORM
// =============================================================================

interface HolidayFormProps {
  siteId: number;
  siteName: string;
  holiday: BankHoliday | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

function HolidayForm({ siteId, siteName, holiday, onCancel, onSaved, onDirtyChange }: HolidayFormProps) {
  const initialName = holiday?.name ?? '';
  const initialDate = holiday?.date.slice(0, 10) ?? '';
  const initialEndDate =
    holiday?.end_date && holiday.end_date.slice(0, 10) !== holiday.date.slice(0, 10)
      ? holiday.end_date.slice(0, 10)
      : '';
  const [name, setName] = useState(initialName);
  const [date, setDate] = useState(initialDate);
  const [endDate, setEndDate] = useState(initialEndDate);
  const { isSubmitting: isSaving, begin: beginSave, end: endSave } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);

  useReportDirty(
    onDirtyChange,
    name !== initialName || date !== initialDate || endDate !== initialEndDate
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please enter a name');
      return;
    }
    if (!date) {
      setError('Please select a date');
      return;
    }
    if (endDate && endDate < date) {
      setError('End date must be on or after the start date');
      return;
    }
    if (!beginSave()) return;
    setError(null);
    try {
      if (holiday) {
        await updateBankHoliday(siteId, holiday.id, {
          name: name.trim(),
          date,
          end_date: endDate || null,
        });
      } else {
        await createBankHoliday(siteId, {
          name: name.trim(),
          date,
          end_date: endDate || undefined,
        });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save holiday');
    } finally {
      endSave();
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <h4 className={styles.formTitle}>
        {holiday ? `Edit holiday` : `Add a holiday to ${siteName}`}
      </h4>
      {error && <Notice tone="error">{error}</Notice>}
      <div className={styles.formRow}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="holiday-name">Name</label>
          <input
            id="holiday-name"
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Company Day"
            autoFocus
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="holiday-date">Date</label>
          <input
            id="holiday-date"
            type="date"
            className={styles.input}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="holiday-end-date">End date (optional)</label>
          <input
            id="holiday-end-date"
            type="date"
            className={styles.input}
            value={endDate}
            min={date || undefined}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
      </div>
      {holiday && !holiday.is_custom && (
        <p className={styles.help}>
          This holiday comes from Nager. Saving turns it into a custom holiday, which then takes
          precedence over Nager for its date.
        </p>
      )}
      <div className={styles.formActions}>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSaving}>
          {isSaving ? 'Saving...' : holiday ? 'Save changes' : 'Add holiday'}
        </Button>
      </div>
    </form>
  );
}
