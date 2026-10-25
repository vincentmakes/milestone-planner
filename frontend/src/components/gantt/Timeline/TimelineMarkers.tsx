/**
 * TimelineMarkers — the strip in the timeline header's events row (below the
 * day labels, above the first row's bars): bank-holiday lines, company-event
 * bands and the panel listing a cell's events. Mounted once by
 * `TimelineHeader`, so every timeline with a header (Gantt, Staff, Equipment,
 * Cross-site, Archived) shows it, at every zoom.
 *
 * Day cells (week / month zoom):
 *   - a 3 px orange line on lane 0 of every bank-holiday cell
 *     (`showHolidayLine`, default on);
 *   - one 3 px band per event run from `assignEventLanes` (lane × 4 px from
 *     the top, the event's colour; a closure gets a thin inset outline);
 *   - a "+N" pip at the right edge of a cell whose events did not all find a
 *     lane (a 4 px dot instead when the cell is narrower than 18 px).
 * Span cells (quarter weeks, year months): one band on lane 0 in the first
 * event's colour and a badge with the number of events. No lanes and no
 * holiday line there (a quarter week's holiday flag covers only its Monday,
 * a year month has none), so a span cell's panel lists events only.
 *
 * Every cell with something to show gets a transparent 12 px hit button,
 * the height of the events row (it never reaches the bars below the header).
 * Hover (after 150 ms), keyboard focus or a click opens the panel — an
 * `AnchoredPanel` (`role="dialog"`, no focus trap: it is a popover, not a
 * modal) listing the cell's events with their dates, their teams at this site
 * and whether they close it; a manager's click on a name opens the event in
 * Settings → Company events (not during What-If). One panel at a time:
 *   - `hover`: closes 150 ms after the pointer leaves the cell and the panel,
 *     and at once when the timeline scrolls;
 *   - `focus`: closes when focus leaves the strip and the panel;
 *   - `pin` (a click): stays until a second click, Escape, an outside
 *     mousedown or Tab out (`useDismissableOverlay`).
 * Escape on a focused or pinned panel returns focus to the cell without
 * reopening the panel; on a hover panel it closes the panel and leaves focus
 * and the key alone (dependency linking and phantom mode still see it).
 * The panel closes when its cells change (a zoom, a new range, new events
 * without its cell): a hidden panel never comes back. No hover or focus
 * panel opens while a bar is dragged or resized.
 *
 * Class names and data attributes avoid "row", "rows", "bar" and
 * `data-date`: the drag/resize hooks read every `[data-date]` in the document
 * and find rows by `[class*="row"]`, `DependencyLayer` takes the first
 * `[class*="rows"]`. Cells are addressed by `data-cell-index`. The hit
 * button's class contains "Badge", which keeps it out of the 44 px phone
 * touch-target rule (`global.css`).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { AnchoredPanel } from '@/components/common/AnchoredPanel';
import { Button } from '@/components/common/Button';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { formatLocalDate, formatMediumDate } from '@/utils/date';
import { can } from '@/utils/permissions';
import { teamIdsOnSite, teamsForSite } from '@/utils/teams';
import type { Team, ViewMode } from '@/types';
import { assignEventLanes } from '../utils';
import type { CellEvent, TimelineCell } from '../utils';
import styles from './TimelineMarkers.module.css';

export interface TimelineMarkersProps {
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
  /** The current site: names the teams of an event at this site */
  siteId: number | undefined;
  /** Draw and list bank holidays on day cells (default true) */
  showHolidayLine?: boolean;
}

type OpenMode = 'hover' | 'focus' | 'pin';

interface OpenState {
  index: number;
  mode: OpenMode;
  /** The cell's date when opened: a panel whose cell moved (zoom, scroll) is dropped */
  dateStr: string;
}

/** Hover intent, both ways */
const HOVER_DELAY = 150;
/** Lane pitch and the cell width below which a "+N" becomes a dot */
const LANE_PITCH = 4;
const PIP_MIN_CELL_WIDTH = 18;

/** A drag, a resize or a resource drag is under way (no hover / focus panel then) */
function dragInProgress(): boolean {
  const ui = useUIStore.getState();
  if (ui.isDragging || ui.isResizing || ui.resourceDrag.active) return true;
  const body = document.body.classList;
  return body.contains('resource-dragging') || body.contains('kanban-dragging');
}

function eventColorStyle(color: string | null | undefined): CSSProperties {
  return color ? ({ ['--event-color' as string]: color } as CSSProperties) : {};
}

function eventCount(n: number): string {
  return `${n} event${n === 1 ? '' : 's'}`;
}

function eventDates(event: CellEvent): string {
  return event.end !== event.start
    ? `${formatMediumDate(event.start)} – ${formatMediumDate(event.end)}`
    : formatMediumDate(event.start);
}

/** The tag of an event at this site (see `utils/siteClosure.ts`) */
function eventTag(event: CellEvent, siteTeams: Team[]): string | null {
  const names = teamIdsOnSite(event.teamIds, siteTeams).flatMap(
    (id) => siteTeams.find((t) => t.id === id)?.name ?? []
  );
  if (event.isClosure) return names.length > 0 ? `Closure for ${names.join(', ')}` : 'Site closure';
  return names.length > 0 ? `Teams: ${names.join(', ')}` : null;
}

export function TimelineMarkers({
  cells,
  cellWidth,
  viewMode,
  siteId,
  showHolidayLine = true,
}: TimelineMarkersProps) {
  const spanCells = viewMode === 'quarter' || viewMode === 'year';
  const holidays = !spanCells && showHolidayLine;

  const currentUser = useAppStore((s) => s.currentUser);
  const teams = useAppStore((s) => s.teams);
  const openSettings = useUIStore((s) => s.openSettings);
  const whatIf = useWhatIfBlocked();
  const canManage = can(currentUser, 'company_events.manage');
  const siteTeams = useMemo(() => teamsForSite(teams, siteId), [teams, siteId]);

  // Lanes for day cells. Without the holiday line, lane 0 is not reserved.
  const lanes = useMemo(() => {
    if (spanCells) return null;
    const laneCells = showHolidayLine
      ? cells
      : cells.map((cell) => (cell.isBankHoliday ? { ...cell, isBankHoliday: false } : cell));
    return assignEventLanes(laneCells);
  }, [cells, spanCells, showHolidayLine]);

  const hasHit = useCallback(
    (cell: TimelineCell | undefined) => !!cell && (cell.companyEvents.length > 0 || (holidays && cell.isBankHoliday)),
    [holidays]
  );

  // --- open state -----------------------------------------------------------
  const [openState, setOpenState] = useState<OpenState | null>(null);
  const open =
    openState && cells[openState.index]?.dateStr === openState.dateStr && hasHit(cells[openState.index])
      ? openState
      : null;
  const openRef = useRef(open);
  openRef.current = open;
  // The raw state, for the timers: a panel hidden by a cell change still counts
  const stateRef = useRef(openState);
  stateRef.current = openState;

  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openCellRef = useRef<HTMLButtonElement | null>(null);
  const cellRefs = useRef(new Map<number, HTMLButtonElement>());
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextFocus = useRef(false);
  const panelId = useId();

  const cancelOpen = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);
  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const close = useCallback(() => {
    cancelOpen();
    cancelClose();
    setOpenState(null);
  }, [cancelOpen, cancelClose]);

  const show = useCallback(
    (index: number, mode: OpenMode) => {
      cancelOpen();
      cancelClose();
      const cell = cells[index];
      if (!cell) return;
      openCellRef.current = cellRefs.current.get(index) ?? null;
      setOpenState({ index, mode, dateStr: cell.dateStr });
    },
    [cells, cancelOpen, cancelClose]
  );

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (stateRef.current?.mode === 'hover') setOpenState(null);
    }, HOVER_DELAY);
  }, [cancelClose]);

  // A panel of other cells (zoom, range, events changed) closes for good
  // instead of hiding until its cell comes back; a hover intent towards a
  // cell of the old cells is dropped.
  const stale = openState !== null && open === null;
  useEffect(() => {
    if (stale) close();
  }, [stale, close]);
  const shownCells = useRef(cells);
  const shownMode = useRef(viewMode);
  useEffect(() => {
    if (shownCells.current === cells && shownMode.current === viewMode) return;
    const zoomed = shownMode.current !== viewMode;
    shownCells.current = cells;
    shownMode.current = viewMode;
    if (zoomed) close();
    else cancelOpen();
  }, [cells, viewMode, close, cancelOpen]);

  // A drag or a resize starting closes a hover or focus panel
  const dragging = useUIStore((s) => s.isDragging || s.isResizing || s.resourceDrag.active);
  useEffect(() => {
    if (!dragging) return;
    cancelOpen();
    if (stateRef.current && stateRef.current.mode !== 'pin') close();
  }, [dragging, cancelOpen, close]);

  // Escape returns focus to the cell; that focus must not reopen the panel.
  // The hook focuses synchronously right after onClose, so the flag is cleared
  // once the current event is done (an outside mousedown leaves it unused).
  const onDismiss = useCallback(() => {
    skipNextFocus.current = true;
    void Promise.resolve().then(() => {
      skipNextFocus.current = false;
    });
    close();
  }, [close]);

  // A focused or pinned panel: Escape (focus back on the cell), outside
  // mousedown, Tab out. A hover panel is the pointer's: it closes on leave,
  // on scroll and on an Escape it neither stops nor answers with a focus move.
  const hoverOpen = open?.mode === 'hover';
  const { onBlur } = useDismissableOverlay({
    open: open !== null && !hoverOpen,
    onClose: onDismiss,
    wrapperRef: layerRef,
    triggerRef: openCellRef,
    panelRef,
  });
  useEffect(() => {
    if (!hoverOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [hoverOpen, close]);

  // A hover panel closes as soon as the timeline (any scrolling ancestor of
  // the strip) scrolls; a focused or pinned one follows its cell.
  useEffect(() => {
    if (!hoverOpen) return;
    const onScroll = (e: Event) => {
      const layer = layerRef.current;
      const target = e.target;
      if (!layer || !(target instanceof Node) || target === layer) return;
      if (target.contains(layer)) close();
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [hoverOpen, close]);

  useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
    },
    [cancelOpen, cancelClose]
  );

  // --- hit-cell handlers ----------------------------------------------------
  const onCellEnter = (index: number, e: ReactMouseEvent) => {
    cancelClose();
    const current = openRef.current;
    if (current?.mode === 'pin' || current?.index === index) return;
    cancelOpen();
    // A bar dragged or resized through the strip (a button held) opens nothing
    if (e.buttons !== 0 || dragInProgress()) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      const latest = openRef.current;
      if (latest?.mode === 'pin' || latest?.index === index || dragInProgress()) return;
      show(index, 'hover');
    }, HOVER_DELAY);
  };

  const onCellLeave = () => {
    cancelOpen();
    if (openRef.current?.mode === 'hover') scheduleClose();
  };

  const onCellFocus = (index: number) => {
    if (skipNextFocus.current) {
      skipNextFocus.current = false;
      return;
    }
    const current = openRef.current;
    if (current?.index === index && current.mode === 'pin') return;
    if (dragInProgress()) return;
    show(index, 'focus');
  };

  const onCellClick = (index: number) => {
    const current = openRef.current;
    if (current?.index === index && current.mode === 'pin') close();
    else show(index, 'pin');
  };

  const onPanelLeave = () => {
    if (openRef.current?.mode === 'hover') scheduleClose();
  };

  const setCellRef = (index: number) => (node: HTMLButtonElement | null) => {
    if (node) cellRefs.current.set(index, node);
    else cellRefs.current.delete(index);
  };

  // --- labels -----------------------------------------------------------------
  const cellTitle = (cell: TimelineCell): string => {
    if (viewMode === 'quarter') return `Week ${cell.weekNumber}`;
    if (viewMode === 'year') return `${cell.monthLabel} ${cell.yearLabel}`;
    return formatMediumDate(cell.dateStr);
  };

  const cellLabel = (cell: TimelineCell): string => {
    const parts: string[] = [];
    if (holidays && cell.isBankHoliday) parts.push(`Bank holiday ${cell.bankHolidayName ?? ''}`.trim());
    const n = cell.companyEvents.length;
    if (n > 0) parts.push(`${eventCount(n)}: ${cell.companyEvents.map((e) => e.name).join(', ')}`);
    return `${cellTitle(cell)} — ${parts.join('; ')}`;
  };

  const panelTitle = (cell: TimelineCell): string => {
    if (viewMode === 'quarter') {
      const start = formatMediumDate(cell.dateStr);
      const end = cell.dateEnd ? formatMediumDate(formatLocalDate(cell.dateEnd)) : start;
      return `Week ${cell.weekNumber} · ${start} – ${end}`;
    }
    return cellTitle(cell);
  };

  // --- render -----------------------------------------------------------------
  const openCell = open ? cells[open.index] : null;

  const editEvent = (event: CellEvent) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    openSettings('company-events', { type: 'edit', id: event.id, siteId });
    close();
  };

  const renderName = (event: CellEvent) => {
    if (canManage && !whatIf.blocked) {
      return (
        <Button variant="ghost" size="sm" className={styles.eventName} onClick={editEvent(event)}>
          {event.name}
        </Button>
      );
    }
    return (
      <span
        className={styles.eventNameText}
        title={canManage ? whatIf.reason('Editing company events in Settings') : undefined}
      >
        {event.name}
      </span>
    );
  };

  return (
    <div ref={layerRef} className={styles.markerLayer} onBlur={onBlur}>
      {holidays &&
        cells.map((cell, index) =>
          cell.isBankHoliday ? (
            <div
              key={`holiday-${index}`}
              className={styles.holidayLine}
              style={{ left: index * cellWidth, width: cellWidth }}
            />
          ) : null
        )}

      {lanes?.runs.map((run) => (
        <div
          key={`band-${run.event.id}-${run.from}`}
          className={`${styles.band} ${run.event.isClosure ? styles.closure : ''}`}
          data-event-id={run.event.id}
          data-lane={run.lane}
          style={{
            left: run.from * cellWidth,
            width: (run.to - run.from + 1) * cellWidth,
            top: run.lane * LANE_PITCH,
            ...eventColorStyle(run.event.color),
          }}
        />
      ))}

      {lanes &&
        [...lanes.overflow].map(([index, n]) =>
          cellWidth >= PIP_MIN_CELL_WIDTH ? (
            <span
              key={`pip-${index}`}
              className={`${styles.pip} ${styles.pipCount}`}
              data-cell-index={index}
              style={{ left: (index + 1) * cellWidth }}
              aria-hidden="true"
            >
              +{n}
            </span>
          ) : (
            <span
              key={`pip-${index}`}
              className={`${styles.pip} ${styles.pipDot}`}
              data-cell-index={index}
              style={{ left: (index + 1) * cellWidth }}
              aria-hidden="true"
            />
          )
        )}

      {spanCells &&
        cells.map((cell, index) => {
          const first = cell.companyEvents[0];
          if (!first) return null;
          return [
            <div
              key={`span-band-${index}`}
              className={`${styles.band} ${first.isClosure ? styles.closure : ''}`}
              data-cell-index={index}
              style={{ left: index * cellWidth, width: cellWidth, top: 0, ...eventColorStyle(cell.companyEventColor) }}
            />,
            <span
              key={`span-count-${index}`}
              className={`${styles.pip} ${styles.pipCount}`}
              data-cell-index={index}
              style={{ left: (index + 1) * cellWidth }}
              aria-hidden="true"
            >
              {cell.companyEvents.length}
            </span>,
          ];
        })}

      {cells.map((cell, index) => {
        if (!hasHit(cell)) return null;
        const isOpen = open?.index === index;
        return (
          <button
            key={`hit-${index}`}
            ref={setCellRef(index)}
            type="button"
            className={styles.markerBadge}
            data-cell-index={index}
            style={{ left: index * cellWidth, width: cellWidth }}
            aria-label={cellLabel(cell)}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-controls={isOpen ? panelId : undefined}
            onMouseEnter={(e) => onCellEnter(index, e)}
            onMouseLeave={onCellLeave}
            onFocus={() => onCellFocus(index)}
            onClick={() => onCellClick(index)}
          />
        );
      })}

      {openCell && (
        <AnchoredPanel
          ref={panelRef}
          open
          triggerRef={openCellRef}
          align="start"
          role="dialog"
          id={panelId}
          aria-label={`Events on ${panelTitle(openCell)}`}
          className={styles.panel}
          onMouseEnter={cancelClose}
          onMouseLeave={onPanelLeave}
        >
          <div className={styles.panelTitle}>
            {panelTitle(openCell)}
            {openCell.companyEvents.length > 0 && (
              <span className={styles.panelCount}> · {eventCount(openCell.companyEvents.length)}</span>
            )}
          </div>
          {holidays && openCell.isBankHoliday && (
            <div className={styles.holidayNote}>
              <span className={styles.holidaySwatch} aria-hidden="true" />
              {`Bank holiday · ${openCell.bankHolidayName ?? ''}`.trim()}
            </div>
          )}
          {openCell.companyEvents.length > 0 && (
            <ul className={styles.eventList}>
              {openCell.companyEvents.map((event) => {
                const tag = eventTag(event, siteTeams);
                return (
                  <li key={event.id} className={styles.eventItem} data-event-id={event.id}>
                    <span
                      className={`${styles.swatch} ${event.isClosure ? styles.closure : ''}`}
                      style={eventColorStyle(event.color)}
                      aria-hidden="true"
                    />
                    <div className={styles.eventText}>
                      {renderName(event)}
                      <span className={styles.eventDates}>{eventDates(event)}</span>
                      {tag && <span className={styles.eventTag}>{tag}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </AnchoredPanel>
      )}
    </div>
  );
}
