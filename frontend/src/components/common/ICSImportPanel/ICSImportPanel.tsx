/**
 * ICSImportPanel - shared .ics import UI
 *
 * Drop zone + file picker, a preview table with per-row checkboxes, duplicate
 * flags, unsupported entries, and a created/skipped summary. Used for
 * vacations, bank holidays and company events; per-row options (absence type,
 * colour, ...) come in through `renderRowExtra`.
 *
 * Calendar data is not part of the What-If snapshot, so callers pass a
 * `disabledReason` while What-If mode is active.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ReactNode, ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import { Button } from '../Button';
import { parseICS, readICSFile } from '@/utils/ics';
import type { ParsedICSEvent, SkippedICSEvent } from '@/utils/ics';
import type { CalendarImportResult } from '@/types';
import styles from './ICSImportPanel.module.css';

/** Message for callers to pass as `disabledReason` while What-If mode is active. */
export const ICS_IMPORT_WHAT_IF_MESSAGE =
  'Importing is unavailable while What-If mode is active. Apply or discard your What-If changes first.';

/**
 * Largest .ics file the panel reads. Parsing is synchronous on the main
 * thread, so a huge file would freeze the tab; real calendar exports (even a
 * multi-year Outlook calendar) are far below this.
 */
export const MAX_ICS_FILE_BYTES = 5 * 1024 * 1024;

/** A parsed event as shown in the preview, with the caller's per-row value. */
export interface ICSImportRow<TExtra = undefined> extends ParsedICSEvent {
  /** Stable key within one parsed file */
  key: string;
  /** Flagged by `isDuplicate` (unchecked by default) */
  duplicate: boolean;
  extra: TExtra;
}

export interface ICSImportPanelProps<TExtra = undefined> {
  /** Import the selected rows; resolve with the server's counts. */
  onImport: (rows: ICSImportRow<TExtra>[]) => Promise<CalendarImportResult>;
  /** Flag entries that already exist. Memoize it: a new function re-flags the rows. */
  isDuplicate?: (event: ParsedICSEvent) => boolean;
  /** Per-row control (e.g. an absence-type select); call setExtra to change the row's value. */
  renderRowExtra?: (row: ICSImportRow<TExtra>, setExtra: (extra: TExtra) => void) => ReactNode;
  /** Header of the per-row control column */
  extraColumnLabel?: string;
  /** Initial per-row value */
  defaultExtra?: TExtra;
  /** Initial per-row value derived from the event; takes precedence over defaultExtra */
  initExtra?: (event: ParsedICSEvent) => TExtra;
  /** When set, the panel shows this message and refuses files and imports */
  disabledReason?: string | null;
  title?: string;
  hint?: string;
  /** Noun for the import button, singular (default "event") */
  itemLabel?: string;
  /** Called after a successful import */
  onImported?: (result: CalendarImportResult) => void;
}

interface PanelRow<TExtra> extends ICSImportRow<TExtra> {
  selected: boolean;
}

function formatDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatRange(start: string, end: string): string {
  return start === end ? formatDay(start) : `${formatDay(start)} – ${formatDay(end)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function formatImportResult(result: CalendarImportResult): string {
  const parts = [`${result.created} created`, `${result.skipped} skipped`];
  if (result.linked != null) parts.push(`${result.linked} linked`);
  return parts.join(', ');
}

function isICSFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.ics') || file.type === 'text/calendar';
}

export function ICSImportPanel<TExtra = undefined>({
  onImport,
  isDuplicate,
  renderRowExtra,
  extraColumnLabel,
  defaultExtra,
  initExtra,
  disabledReason,
  title,
  hint = 'Import from Outlook or any calendar app that exports .ics files',
  itemLabel = 'event',
  onImported,
}: ICSImportPanelProps<TExtra>) {
  const [rows, setRows] = useState<PanelRow<TExtra>[] | null>(null);
  const [skipped, setSkipped] = useState<SkippedICSEvent[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CalendarImportResult | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const disabled = !!disabledReason;

  // Re-flag duplicates when the caller's notion of "existing" changes (e.g. a
  // different target site). Rows whose flag flips get the default selection.
  useEffect(() => {
    setRows((prev) => {
      if (!prev) return prev;
      let changed = false;
      const next = prev.map((row) => {
        const duplicate = isDuplicate ? isDuplicate(row) : false;
        if (duplicate === row.duplicate) return row;
        changed = true;
        return { ...row, duplicate, selected: !duplicate };
      });
      return changed ? next : prev;
    });
  }, [isDuplicate]);

  const selectedCount = useMemo(() => rows?.filter((r) => r.selected).length ?? 0, [rows]);
  const allSelected = !!rows && rows.length > 0 && selectedCount === rows.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedCount > 0 && !allSelected;
    }
  }, [selectedCount, allSelected]);

  const handleFile = useCallback(
    async (file: File) => {
      if (disabled) return;
      setResult(null);
      if (!isICSFile(file)) {
        setError('Please select an .ics calendar file');
        return;
      }
      // Checked before reading: the size is known without touching the content
      if (file.size > MAX_ICS_FILE_BYTES) {
        const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
        setError(
          `This file is too large (${sizeMb} MB). Calendar files up to ` +
            `${MAX_ICS_FILE_BYTES / (1024 * 1024)} MB can be imported; export a shorter date range.`
        );
        return;
      }
      try {
        const parsed = parseICS(await readICSFile(file));
        if (parsed.events.length === 0 && parsed.skipped.length === 0) {
          setError('No events found in the file');
          return;
        }
        setRows(
          parsed.events.map((event, index) => {
            const duplicate = isDuplicate ? isDuplicate(event) : false;
            return {
              ...event,
              key: `${index}-${event.start_date}-${event.summary}`,
              duplicate,
              selected: !duplicate,
              extra: initExtra ? initExtra(event) : (defaultExtra as TExtra),
            };
          }),
        );
        setSkipped(parsed.skipped);
        setFileName(file.name);
        setError(null);
      } catch (err) {
        console.error('Failed to parse ICS:', err);
        setError('Failed to read the calendar file');
      }
    },
    [disabled, isDuplicate, initExtra, defaultExtra],
  );

  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      // Reset so the same file can be picked again
      e.target.value = '';
    },
    [handleFile],
  );

  const openPicker = useCallback(() => {
    if (!disabled) fileInputRef.current?.click();
  }, [disabled]);

  const handleDropZoneKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPicker();
      }
    },
    [openPicker],
  );

  const handleDragOver = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) setIsDragging(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const toggleRow = useCallback((key: string) => {
    setRows((prev) => prev && prev.map((r) => (r.key === key ? { ...r, selected: !r.selected } : r)));
  }, []);

  const toggleAll = useCallback(() => {
    setRows((prev) => {
      if (!prev) return prev;
      const select = !prev.every((r) => r.selected);
      return prev.map((r) => ({ ...r, selected: select }));
    });
  }, []);

  const setRowExtra = useCallback((key: string, extra: TExtra) => {
    setRows((prev) => prev && prev.map((r) => (r.key === key ? { ...r, extra } : r)));
  }, []);

  const reset = useCallback(() => {
    setRows(null);
    setSkipped([]);
    setFileName(null);
    setError(null);
  }, []);

  const handleImport = useCallback(async () => {
    if (!rows || disabled) return;
    const chosen = rows.filter((r) => r.selected);
    if (chosen.length === 0) return;

    setIsImporting(true);
    setError(null);
    try {
      const res = await onImport(chosen);
      setResult(res);
      setRows(null);
      setSkipped([]);
      setFileName(null);
      onImported?.(res);
    } catch (err) {
      console.error('ICS import failed:', err);
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsImporting(false);
    }
  }, [rows, disabled, onImport, onImported]);

  const duplicateCount = rows?.filter((r) => r.duplicate).length ?? 0;

  return (
    <div className={styles.panel}>
      {title && <div className={styles.title}>{title}</div>}

      {disabledReason && (
        <div className={styles.notice} role="note">
          {disabledReason}
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {result && (
        <div className={styles.result} role="status">
          Import complete: {formatImportResult(result)}
        </div>
      )}

      {rows === null ? (
        <div
          className={`${styles.dropZone} ${isDragging ? styles.dragging : ''} ${disabled ? styles.disabled : ''}`}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          onClick={openPicker}
          onKeyDown={handleDropZoneKey}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={disabled ? (e) => e.preventDefault() : handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".ics,text/calendar"
            onChange={handleInputChange}
            className={styles.fileInput}
            disabled={disabled}
            aria-label="Choose .ics file"
            // The programmatic click bubbles to the drop zone; don't re-open.
            onClick={(e) => e.stopPropagation()}
          />
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span className={styles.dropZoneText}>Drop an .ics file here or click to browse</span>
          {hint && <span className={styles.dropZoneHint}>{hint}</span>}
        </div>
      ) : (
        <div className={styles.preview}>
          <div className={styles.previewHeader}>
            <div className={styles.previewInfo}>
              <span className={styles.fileName}>{fileName}</span>
              <span className={styles.counts}>
                {selectedCount} of {rows.length} selected
                {duplicateCount > 0 && ` · ${duplicateCount} already exist${duplicateCount === 1 ? 's' : ''}`}
              </span>
            </div>
            <button type="button" className={styles.linkBtn} onClick={reset} disabled={isImporting}>
              Choose another file
            </button>
          </div>

          {rows.length > 0 ? (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.checkCol}>
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        className={styles.checkbox}
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label="Select all"
                      />
                    </th>
                    <th>Name</th>
                    <th>Dates</th>
                    {renderRowExtra && <th>{extraColumnLabel ?? ''}</th>}
                    <th className={styles.statusCol}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.key}
                      className={`${row.selected ? styles.selected : ''} ${row.duplicate ? styles.duplicateRow : ''}`}
                    >
                      <td className={styles.checkCol}>
                        <input
                          type="checkbox"
                          className={styles.checkbox}
                          checked={row.selected}
                          onChange={() => toggleRow(row.key)}
                          aria-label={`Select ${row.summary || 'untitled event'} (${row.start_date})`}
                        />
                      </td>
                      <td className={styles.nameCell} title={row.summary}>
                        {row.summary || <span className={styles.untitled}>Untitled</span>}
                      </td>
                      <td className={styles.datesCell}>{formatRange(row.start_date, row.end_date)}</td>
                      {renderRowExtra && (
                        <td className={styles.extraCell}>
                          {renderRowExtra(row, (extra) => setRowExtra(row.key, extra))}
                        </td>
                      )}
                      <td className={styles.statusCol}>
                        {row.duplicate && <span className={`${styles.badge} ${styles.badgeDuplicate}`}>Exists</span>}
                        {row.recurrence === 'yearly' && <span className={`${styles.badge} ${styles.badgeYearly}`}>Yearly</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.empty}>No importable events in this file.</div>
          )}

          {skipped.length > 0 && (
            <div className={styles.skipped}>
              <div className={styles.skippedTitle}>
                {skipped.length} {skipped.length === 1 ? 'entry' : 'entries'} not imported
              </div>
              <ul className={styles.skippedList}>
                {skipped.map((s, i) => (
                  <li key={i}>
                    <span className={styles.skippedName}>{s.summary || 'Untitled'}</span>
                    <span className={styles.skippedReason}>{s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={styles.actions}>
            <Button type="button" variant="secondary" onClick={reset} disabled={isImporting}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
             
              onClick={handleImport}
              disabled={disabled || isImporting || selectedCount === 0}
            >
              {isImporting ? 'Importing...' : `Import ${plural(selectedCount, itemLabel)}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
