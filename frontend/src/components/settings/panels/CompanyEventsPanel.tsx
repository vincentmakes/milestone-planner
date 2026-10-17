/**
 * CompanyEventsPanel (Settings hub > Company events)
 *
 * Audits, shutdowns, meetings... shown as colored markers on the timeline of
 * one or more sites. Plain events don't affect working days; an event flagged
 * as a site closure makes the staff of its sites unavailable for its dates
 * (like an absence, shown under the event's name and colour). Events can be
 * added, edited (including their sites), deleted, exported and imported from
 * .ics. Superusers only see and target their own sites; an event also linked
 * to sites they don't manage can't be edited or deleted by them (the backend
 * answers 403), only removed from their own sites.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
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
  getCompanyEvents,
  createCompanyEventMultiSite,
  updateCompanyEvent,
  deleteCompanyEventById,
  deleteCompanyEvent,
  importCompanyEvents,
} from '@/api';
import { buildICS, downloadICS, clampText } from '@/utils/ics';
import type { ParsedICSEvent } from '@/utils/ics';
import { DEFAULT_EVENT_COLOR } from '@/utils/colorSwatches';
import type { CalendarImportResult, CompanyEvent, Site } from '@/types';
import {
  useManageableSites,
  pickDefaultSiteId,
  refreshCurrentSiteEvents,
  formatCalendarDate,
  overlapsYear,
  collectYears,
  nameKey,
} from './calendarUtils';
import { SiteChecklist } from './SiteChecklist';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import {
  EditIcon,
  TrashIcon,
  PlusIcon,
  DownloadIcon,
  UploadIcon,
  BackIcon,
  UnlinkIcon,
} from './PanelIcons';
import type { SettingsPanelProps } from '../types';
import { useReportDirty } from '../useReportDirty';
import styles from './CalendarPanel.module.css';

/** Sites an event is linked to (older servers only send site_id) */
function eventSiteIds(event: CompanyEvent): number[] {
  return event.site_ids && event.site_ids.length > 0 ? event.site_ids : [event.site_id];
}

function sameDay(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a || '').slice(0, 10) === (b || '').slice(0, 10);
}

const SHARED_EVENT_TITLE = "Shared with sites you don't manage";

type FormState =
  | { mode: 'add' }
  | { mode: 'edit'; event: CompanyEvent };

export function CompanyEventsPanel({ onDirtyChange }: Partial<SettingsPanelProps>) {
  const settingsIntent = useUIStore((s) => s.settingsIntent);
  const clearSettingsIntent = useUIStore((s) => s.clearSettingsIntent);
  const currentSite = useAppStore((s) => s.currentSite);
  const sites = useAppStore((s) => s.sites);
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);
  const manageableSites = useManageableSites();

  const [siteFilter, setSiteFilter] = useState<number | 'all'>(
    () => pickDefaultSiteId(manageableSites, currentSite?.id, settingsIntent?.siteId) ?? 'all'
  );
  const [year, setYear] = useState<number | 'all'>('all');
  const [events, setEvents] = useState<CompanyEvent[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<'list' | 'import'>('list');
  const [form, setForm] = useState<FormState | null>(null);
  const [pendingEditId, setPendingEditId] = useState<number | null>(null);
  const [importSiteIds, setImportSiteIds] = useState<number[]>([]);
  const [importColor, setImportColor] = useState(DEFAULT_EVENT_COLOR);
  const [importAsClosure, setImportAsClosure] = useState(false);
  // One delete / unlink at a time: a second click while the first runs would 404
  const deleteGuard = useSubmitGuard();

  const siteNames = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);
  const manageableIds = useMemo(() => manageableSites.map((s) => s.id), [manageableSites]);
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin');

  /** Linked sites the user can't manage (always none for admins) */
  const foreignSiteIds = useCallback(
    (event: CompanyEvent) =>
      isAdmin ? [] : eventSiteIds(event).filter((id) => !manageableIds.includes(id)),
    [isAdmin, manageableIds]
  );

  // Events of every site the user manages, merged (an event spans sites)
  const loadEvents = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const perSite = await Promise.all(
        manageableIds.map(async (siteId) => ({ siteId, events: await getCompanyEvents(siteId) }))
      );
      const merged = new Map<number, CompanyEvent>();
      for (const { siteId, events: siteEvents } of perSite) {
        for (const event of siteEvents) {
          const existing = merged.get(event.id);
          const ids = new Set([...(existing ? eventSiteIds(existing) : []), ...eventSiteIds(event), siteId]);
          merged.set(event.id, { ...event, site_ids: Array.from(ids) });
        }
      }
      setEvents(Array.from(merged.values()));
      setHasLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load company events');
    } finally {
      setIsLoading(false);
    }
  }, [manageableIds]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Opened from elsewhere (Staff view): add, or edit a given event
  useEffect(() => {
    if (!settingsIntent) return;
    if (settingsIntent.siteId && manageableIds.includes(settingsIntent.siteId)) {
      setSiteFilter(settingsIntent.siteId);
    }
    if (settingsIntent.type === 'add') {
      setView('list');
      setForm({ mode: 'add' });
    } else if (settingsIntent.type === 'edit') {
      setView('list');
      setPendingEditId(settingsIntent.id);
    }
    clearSettingsIntent();
  }, [settingsIntent, clearSettingsIntent, manageableIds]);

  useEffect(() => {
    if (pendingEditId === null || !hasLoaded || isLoading) return;
    const event = events.find((e) => e.id === pendingEditId);
    if (event && foreignSiteIds(event).length === 0) setForm({ mode: 'edit', event });
    setPendingEditId(null);
  }, [pendingEditId, events, hasLoaded, isLoading, foreignSiteIds]);

  const years = useMemo(() => collectYears(events), [events]);

  const visibleEvents = useMemo(
    () =>
      events
        .filter((e) => siteFilter === 'all' || eventSiteIds(e).includes(siteFilter))
        .filter((e) => year === 'all' || overlapsYear(e.date, e.end_date, year))
        .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)),
    [events, siteFilter, year]
  );

  const defaultSiteIds = (): number[] => {
    if (siteFilter !== 'all') return [siteFilter];
    const fallback = pickDefaultSiteId(manageableSites, currentSite?.id);
    return fallback !== null ? [fallback] : [];
  };

  const afterChange = async (siteIds: number[]) => {
    await loadEvents();
    await refreshCurrentSiteEvents(siteIds);
  };

  const handleDelete = async (event: CompanyEvent) => {
    const names = eventSiteIds(event).map((id) => siteNames.get(id) ?? `#${id}`);
    const message =
      names.length > 1
        ? `Delete the event "${event.name}"?\n\nIt is removed from all of its sites: ${names.join(', ')}.`
        : `Delete the event "${event.name}"?`;
    if (!deleteGuard.begin()) return;
    try {
      if (!window.confirm(message)) return;
      setError(null);
      await deleteCompanyEventById(event.id);
      if (form?.mode === 'edit' && form.event.id === event.id) setForm(null);
      await afterChange(eventSiteIds(event));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete event');
    } finally {
      deleteGuard.end();
    }
  };

  // Superuser on an event shared with foreign sites: unlink it from their own
  // sites only (legacy per-site route); the event stays on the other sites.
  const handleRemoveFromMySites = async (event: CompanyEvent) => {
    const mine = eventSiteIds(event).filter((id) => manageableIds.includes(id));
    if (mine.length === 0) return;
    const names = mine.map((id) => siteNames.get(id) ?? `#${id}`);
    if (!deleteGuard.begin()) return;
    try {
      if (
        !window.confirm(
          `Remove the event "${event.name}" from ${names.join(', ')}?\n\n` +
            'It stays on the other sites it is linked to.'
        )
      ) {
        return;
      }
      setError(null);
      await unlinkFromSites(event, mine);
    } finally {
      deleteGuard.end();
    }
  };

  const unlinkFromSites = async (event: CompanyEvent, mine: number[]) => {
    try {
      for (const siteId of mine) {
        await deleteCompanyEvent(siteId, event.id);
      }
      if (form?.mode === 'edit' && form.event.id === event.id) setForm(null);
      await afterChange(mine);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove the event from your sites');
      await afterChange(mine);
    }
  };

  const handleExport = () => {
    if (visibleEvents.length === 0) return;
    const label = siteFilter === 'all' ? 'all sites' : siteNames.get(siteFilter) ?? 'site';
    // A site closure blocks time (out of office); a plain event is transparent
    const content = buildICS(
      visibleEvents.map((e) => ({
        uid: `companyevent-${e.id}@milestone`,
        summary: e.name,
        start_date: e.date,
        end_date: e.end_date,
        transparency: e.counts_as_unavailable ? ('OPAQUE' as const) : ('TRANSPARENT' as const),
        ...(e.counts_as_unavailable ? { busyStatus: 'OOF' } : {}),
      })),
      `Company Events - ${label}`
    );
    downloadICS(content, `company-events-${label}${year === 'all' ? '' : `-${year}`}.ics`);
  };

  const openImport = () => {
    setForm(null);
    setError(null);
    setImportSiteIds(defaultSiteIds());
    setView('import');
  };

  // Duplicate = an event with the same dates and name is already on EVERY
  // selected site. The import links an existing event to the sites it is
  // missing, so a row on only some of the targets still has work to do (same
  // rule as the bank-holiday import).
  const isDuplicate = useCallback(
    (parsed: ParsedICSEvent) => {
      if (importSiteIds.length === 0) return false;
      const name = nameKey(clampText(parsed.summary) || 'Event');
      const linked = new Set<number>();
      for (const e of events) {
        if (
          sameDay(e.date, parsed.start_date) &&
          sameDay(e.end_date || e.date, parsed.end_date) &&
          nameKey(e.name) === name
        ) {
          for (const id of eventSiteIds(e)) linked.add(id);
        }
      }
      return importSiteIds.every((id) => linked.has(id));
    },
    [events, importSiteIds]
  );

  const handleImport = async (rows: ICSImportRow[]): Promise<CalendarImportResult> => {
    const result = await importCompanyEvents({
      site_ids: importSiteIds,
      color: importColor,
      counts_as_unavailable: importAsClosure,
      items: rows.map((row) => ({
        date: row.start_date,
        end_date: row.end_date !== row.start_date ? row.end_date : null,
        name: clampText(row.summary) || 'Event',
      })),
    });
    await afterChange(importSiteIds);
    return result;
  };

  if (manageableSites.length === 0) {
    return <div className={styles.empty}>You are not assigned to any site.</div>;
  }

  if (view === 'import') {
    return (
      <div className={styles.container}>
        <div className={styles.importHeader}>
          <Button variant="ghost" icon={<BackIcon />} onClick={() => setView('list')}>
            Back to events
          </Button>
        </div>
        <div className={styles.importTargets}>
          <span className={styles.label}>Add the events to</span>
          <SiteChecklist
            sites={manageableSites}
            selected={importSiteIds}
            onChange={setImportSiteIds}
            label="Import into sites"
          />
          <span className={styles.label}>Color</span>
          <ColorSwatchPicker value={importColor} onChange={setImportColor} label="Color of imported events" />
          <label className={styles.siteCheck}>
            <input
              type="checkbox"
              checked={importAsClosure}
              onChange={(e) => setImportAsClosure(e.target.checked)}
            />
            <span>Site closure — staff on these sites are unavailable</span>
          </label>
          <p className={styles.help}>
            An event that already exists with the same dates and name is not duplicated; it is
            linked to the selected sites it is missing (and keeps its own closure setting). Rows
            marked as existing are already on every selected site.
          </p>
        </div>
        <ICSImportPanel
          title="Import company events"
          itemLabel="event"
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
              <label className={styles.label} htmlFor="event-site">Site</label>
              <select
                id="event-site"
                className={styles.select}
                value={siteFilter}
                onChange={(e) => {
                  setSiteFilter(e.target.value === 'all' ? 'all' : Number(e.target.value));
                  setForm(null);
                }}
              >
                <option value="all">All my sites</option>
                {manageableSites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="event-year">Year</label>
              <select
                id="event-year"
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
              icon={<DownloadIcon />}
              onClick={handleExport}
              disabled={visibleEvents.length === 0}
            >
              Export .ics
            </Button>
            <Button variant="secondary" icon={<UploadIcon />} onClick={openImport}>
              Import .ics
            </Button>
            <Button icon={<PlusIcon />} onClick={() => setForm({ mode: 'add' })}>
              Add event
            </Button>
          </>
        }
      />

      {whatIfMode && (
        <div className={styles.notice}>
          What-If mode is active: event changes are queued and only reach the server when you
          apply What-If.
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      {form && (
        <EventForm
          key={form.mode === 'edit' ? form.event.id : 'add'}
          event={form.mode === 'edit' ? form.event : null}
          manageableSites={manageableSites}
          defaultSiteIds={defaultSiteIds()}
          onDirtyChange={onDirtyChange}
          onCancel={() => setForm(null)}
          onSaved={async (siteIds) => {
            setForm(null);
            await afterChange(siteIds);
          }}
        />
      )}

      <div className={styles.tableWrapper}>
        {isLoading && !hasLoaded ? (
          <div className={styles.empty}>Loading events...</div>
        ) : visibleEvents.length === 0 ? (
          <div className={styles.empty}>
            {events.length === 0 ? 'No company events yet.' : 'No events match the filters.'}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>End date</th>
                <th>Name</th>
                <th>Color</th>
                <th>Sites</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visibleEvents.map((event) => {
                const isEditing = form?.mode === 'edit' && form.event.id === event.id;
                const isShared = foreignSiteIds(event).length > 0;
                const hasEnd = event.end_date && !sameDay(event.end_date, event.date);
                return (
                  <tr key={event.id} className={isEditing ? styles.highlight : undefined}>
                    <td className={styles.dateCell}>{formatCalendarDate(event.date)}</td>
                    <td className={styles.dateCell}>{hasEnd ? formatCalendarDate(event.end_date) : '—'}</td>
                    <td className={styles.nameCell}>
                      {event.name}
                      {event.counts_as_unavailable && (
                        <span
                          className={`${styles.badge} ${styles.badgeClosure}`}
                          title="Staff on the event's sites are unavailable"
                        >
                          Closure
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        className={styles.colorDot}
                        style={{ background: event.color || DEFAULT_EVENT_COLOR }}
                        title={event.color || DEFAULT_EVENT_COLOR}
                      />
                    </td>
                    <td>
                      <div className={styles.chips}>
                        {eventSiteIds(event).map((id) => (
                          <span key={id} className={styles.chip}>{siteNames.get(id) ?? `#${id}`}</span>
                        ))}
                      </div>
                    </td>
                    <td className={styles.actionsCell}>
                      {/* Disabled buttons swallow hover, so the tooltip sits on a wrapper */}
                      <span title={isShared ? SHARED_EVENT_TITLE : 'Edit event'}>
                        <button
                          type="button"
                          className={styles.iconBtn}
                          onClick={() => setForm({ mode: 'edit', event })}
                          disabled={isShared}
                          aria-label={`Edit ${event.name}`}
                        >
                          <EditIcon />
                        </button>
                      </span>
                      {isShared && (
                        <button
                          type="button"
                          className={`${styles.iconBtn} ${styles.danger}`}
                          onClick={() => handleRemoveFromMySites(event)}
                          disabled={deleteGuard.isSubmitting}
                          title="Remove from my sites"
                          aria-label={`Remove ${event.name} from my sites`}
                        >
                          <UnlinkIcon />
                        </button>
                      )}
                      <span title={isShared ? SHARED_EVENT_TITLE : 'Delete event'}>
                        <button
                          type="button"
                          className={`${styles.iconBtn} ${styles.danger}`}
                          onClick={() => handleDelete(event)}
                          disabled={isShared || deleteGuard.isSubmitting}
                          aria-label={`Delete ${event.name}`}
                        >
                          <TrashIcon />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className={styles.help}>
        Company events are shown as colored markers on the timeline. A plain event does not affect
        availability; an event marked as a site closure makes the staff of its sites unavailable
        for its dates, like an absence.
      </p>
    </div>
  );
}

// =============================================================================
// ADD / EDIT FORM
// =============================================================================

interface EventFormProps {
  event: CompanyEvent | null;
  manageableSites: Site[];
  defaultSiteIds: number[];
  onCancel: () => void;
  /** Receives every site touched (before and after), to refresh the timeline */
  onSaved: (siteIds: number[]) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Order-insensitive equality of two id lists */
function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function EventForm({ event, manageableSites, defaultSiteIds, onCancel, onSaved, onDirtyChange }: EventFormProps) {
  const manageable = useMemo(() => new Set(manageableSites.map((s) => s.id)), [manageableSites]);
  // Only events whose sites are all manageable reach this form (the panel
  // disables Edit for events shared with sites the user doesn't manage).
  const originalSiteIds = event ? eventSiteIds(event) : [];

  // The values the form opened with, to tell the hub about unsaved input
  const [initial] = useState(() => ({
    name: event?.name ?? '',
    date: event?.date.slice(0, 10) ?? '',
    endDate: event?.end_date && !sameDay(event.end_date, event.date) ? event.end_date.slice(0, 10) : '',
    color: event?.color || DEFAULT_EVENT_COLOR,
    countsAsUnavailable: event?.counts_as_unavailable ?? false,
    siteIds: event ? originalSiteIds.filter((id) => manageable.has(id)) : defaultSiteIds,
  }));
  const [name, setName] = useState(initial.name);
  const [date, setDate] = useState(initial.date);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [color, setColor] = useState(initial.color);
  const [countsAsUnavailable, setCountsAsUnavailable] = useState(initial.countsAsUnavailable);
  const [siteIds, setSiteIds] = useState<number[]>(initial.siteIds);
  const { isSubmitting: isSaving, begin: beginSave, end: endSave } = useSubmitGuard();
  const [error, setError] = useState<string | null>(null);

  useReportDirty(
    onDirtyChange,
    name !== initial.name ||
      date !== initial.date ||
      endDate !== initial.endDate ||
      color !== initial.color ||
      countsAsUnavailable !== initial.countsAsUnavailable ||
      !sameIds(siteIds, initial.siteIds)
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please enter an event name');
      return;
    }
    if (!date) {
      setError('Please select a start date');
      return;
    }
    if (endDate && endDate < date) {
      setError('End date must be on or after the start date');
      return;
    }
    const allSiteIds = siteIds;
    if (allSiteIds.length === 0) {
      setError('Select at least one site');
      return;
    }
    if (!beginSave()) return;
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        date,
        end_date: endDate || null,
        color,
        site_ids: allSiteIds,
        counts_as_unavailable: countsAsUnavailable,
      };
      if (event) {
        await updateCompanyEvent(event.id, payload);
      } else {
        await createCompanyEventMultiSite(payload);
      }
      await onSaved(Array.from(new Set([...originalSiteIds, ...allSiteIds])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save event');
    } finally {
      endSave();
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <h4 className={styles.formTitle}>{event ? 'Edit event' : 'Add a company event'}</h4>
      {error && <Notice tone="error">{error}</Notice>}
      <div className={styles.formRow}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="event-name">Name</label>
          <input
            id="event-name"
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., ISO Audit, All-Hands Meeting"
            autoFocus
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="event-date">Start date</label>
          <input
            id="event-date"
            type="date"
            className={styles.input}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="event-end-date">End date (optional)</label>
          <input
            id="event-end-date"
            type="date"
            className={styles.input}
            value={endDate}
            min={date || undefined}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
      </div>
      <div className={styles.field}>
        <span className={styles.label}>Sites</span>
        <SiteChecklist
          sites={manageableSites}
          selected={siteIds}
          onChange={setSiteIds}
          label="Event sites"
        />
      </div>
      <div className={styles.field}>
        <span className={styles.label}>Color</span>
        <ColorSwatchPicker value={color} onChange={setColor} label="Event color" />
      </div>
      <div className={styles.field}>
        <label className={styles.siteCheck}>
          <input
            type="checkbox"
            checked={countsAsUnavailable}
            onChange={(e) => setCountsAsUnavailable(e.target.checked)}
          />
          <span>Site closure — staff on these sites are unavailable</span>
        </label>
        <p className={styles.help}>
          Their capacity is 0% for the event's dates and their assignments are flagged as
          conflicts, like an absence.
        </p>
      </div>
      <div className={styles.formActions}>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSaving}>
          {isSaving ? 'Saving...' : event ? 'Save changes' : 'Add event'}
        </Button>
      </div>
    </form>
  );
}
