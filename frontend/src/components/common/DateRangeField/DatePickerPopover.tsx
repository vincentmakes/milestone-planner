import 'react-day-picker/style.css';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { DayButton, DayPicker, labelDayButton } from 'react-day-picker';
import type { DayButtonProps, Labels } from 'react-day-picker';
import { isWeekend } from 'date-fns';
import { Button } from '../Button';
import { useAppStore } from '@/stores/appStore';
import { formatDateISO, formatLocalDate, parseLocalDate, toDateOnly } from '@/utils/date';
import { initialMonth, previewRange } from './dateRangeLogic';
import type { IsoDate, RangeState } from './dateRangeLogic';
import { computePopoverPosition, isAnchorInView, unionRect } from './computePopoverPosition';
import type { Placement, PopoverPosition } from './computePopoverPosition';
import styles from './DateRangeField.module.css';

/**
 * DatePickerPopover — the calendar panel of `DateRangeField` / `DateField`
 * (internal; those two own the fields, the open state and the dismissal).
 *
 * It renders inside the fields' wrapper, not in a portal, as `position:
 * fixed`: that escapes the Modal body's `overflow-y: auto` (the modal overlay
 * is the containing block and sits at `inset: 0`), while staying in the DOM
 * subtree keeps the Modal's Tab trap, `aria-controls` and the dismiss hook's
 * `wrapperRef.contains` working unchanged. The position is computed before
 * paint and again on resize and on any scroll (capture phase, so the modal
 * body and the Settings pane count); the panel closes once the fields have
 * scrolled out of view.
 *
 * DayPicker only paints: `selected` is controlled with a no-op `onSelect`
 * (without one it would keep its own selection) and the click rules run in
 * `onDayClick`. Hover previews use their own `preview` modifier so the days'
 * `aria-selected` never flickers.
 */

const PHONE_QUERY = '(max-width: 640px)';
const NAV_YEARS = 10;
const STATUS_AWAITING_END = 'Now pick the end date';

/** DayPicker's onSelect: the selection is controlled, the click rules run in onDayClick. */
const noop = () => {};

function readPhone(): boolean {
  // jsdom has no matchMedia: fall back to the desktop layout (two months).
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

/** One month on a phone (≤ 640 px), two otherwise. */
function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(readPhone);
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

interface DayNotes {
  holidays: string[];
  closures: string[];
}

const NO_NOTES: DayNotes = { holidays: [], closures: [] };

/** The holiday and closure names of a day, for the day buttons' title, dot and accessible name. */
const DayNotesContext = createContext<(iso: IsoDate) => DayNotes>(() => NO_NOTES);

function noteLines({ holidays, closures }: DayNotes): string[] {
  return [...holidays.map((name) => `Bank holiday: ${name}`), ...closures.map((name) => `Site closed: ${name}`)];
}

/** DayPicker's day button plus a tooltip and a dot on the site's holidays and closures. */
function CalendarDayButton(props: DayButtonProps) {
  const notesOf = useContext(DayNotesContext);
  const notes = notesOf(props.day.isoDate);
  const lines = noteLines(notes);
  return (
    <DayButton
      {...props}
      className={[props.className, styles.dayButton].filter(Boolean).join(' ')}
      title={lines.length > 0 ? lines.join('\n') : undefined}
    >
      {props.children}
      {lines.length > 0 && (
        <span className={styles.dots} aria-hidden="true">
          {notes.holidays.length > 0 && <span className={`${styles.dot} ${styles.holidayDot}`} />}
          {notes.closures.length > 0 && <span className={`${styles.dot} ${styles.closureDot}`} />}
        </span>
      )}
    </DayButton>
  );
}

const COMPONENTS = { DayButton: CalendarDayButton };

const MODIFIER_CLASSES = {
  weekend: styles.weekend,
  holiday: styles.holiday,
  closure: styles.closure,
  preview: styles.preview,
  recurring: styles.recurring,
};

export interface DatePickerPopoverProps {
  /** The panel id, for the fields' `aria-controls`. */
  id: string;
  mode: 'range' | 'single';
  /** The current value and the field whose turn it is (single mode: the value is `start`). */
  state: RangeState;
  /** An empty end means "the same day as the start" (optional-end ranges). */
  emptyEndIsSameDay: boolean;
  /** The fields the panel hangs from; their union is the anchor. */
  anchors: readonly RefObject<HTMLElement | null>[];
  /**
   * Bumped on every keyboard activation of a field (0 = opened with the
   * mouse): focus moves to the active field's day, on open and again when
   * the other field is activated from the keyboard while open.
   */
  focusRequest: number;
  onDayClick: (day: IsoDate) => void;
  /** The fields scrolled out of view: close. */
  onAnchorHidden: () => void;
  /** Footer action (DateRangeField's "Clear end date"); no footer without it. */
  clear?: { label: string; disabled: boolean; onClick: () => void };
  highlightWeekdays?: readonly number[];
  markSiteCalendar: boolean;
  /** Days before / after these (`YYYY-MM-DD`) are disabled. */
  minDate?: IsoDate;
  maxDate?: IsoDate;
}

export function DatePickerPopover({
  id,
  mode,
  state,
  emptyEndIsSameDay,
  anchors,
  focusRequest,
  onDayClick,
  onAnchorHidden,
  clear,
  highlightWeekdays,
  markSiteCalendar,
  minDate,
  maxDate,
}: DatePickerPopoverProps) {
  const phone = usePhoneLayout();
  const numberOfMonths = phone ? 1 : 2;
  const { start, end, active } = state;

  // Set once on open: the month is never moved programmatically while open.
  const [month, setMonth] = useState(() => parseLocalDate(initialMonth(state, numberOfMonths, formatDateISO(new Date()))));
  const [hovered, setHovered] = useState<IsoDate | null>(null);

  // Navigation: today ± 10 years, widened to reach the current values.
  const { startMonth, endMonth } = useMemo(() => {
    const thisYear = new Date().getFullYear();
    const years = [start, end].filter(Boolean).map((iso) => Number(iso.slice(0, 4)));
    return {
      startMonth: new Date(Math.min(thisYear - NAV_YEARS, ...years), 0, 1),
      endMonth: new Date(Math.max(thisYear + NAV_YEARS, ...years), 11, 1),
    };
  }, [start, end]);

  // ---- site calendar ----
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const closureIndex = useAppStore((s) => s.closureIndex);

  const notesOf = useCallback(
    (iso: IsoDate): DayNotes => {
      if (!markSiteCalendar) return NO_NOTES;
      const holidays = bankHolidayDates.has(iso)
        ? bankHolidays
            .filter((h) => toDateOnly(h.date) <= iso && iso <= toDateOnly(h.end_date || h.date))
            .map((h) => h.name)
        : [];
      const closures = (closureIndex.get(iso) ?? []).map((event) => event.name);
      return holidays.length === 0 && closures.length === 0 ? NO_NOTES : { holidays, closures };
    },
    [markSiteCalendar, bankHolidays, bankHolidayDates, closureIndex]
  );

  const labels = useMemo<Partial<Labels>>(
    () => ({
      labelDayButton: (date, modifiers, options, dateLib) =>
        [labelDayButton(date, modifiers, options, dateLib), ...noteLines(notesOf(formatLocalDate(date)))].join(', '),
    }),
    [notesOf]
  );

  // ---- modifiers ----
  const preview = mode === 'range' && hovered ? previewRange(state, hovered) : null;
  const previewFrom = preview?.from ?? '';
  const previewTo = preview?.to ?? '';
  const modifiers = useMemo(
    () => ({
      weekend: (date: Date) => isWeekend(date),
      holiday: markSiteCalendar ? (date: Date) => bankHolidayDates.has(formatLocalDate(date)) : false,
      closure: markSiteCalendar ? (date: Date) => closureIndex.has(formatLocalDate(date)) : false,
      preview: previewFrom
        ? (date: Date) => {
            const iso = formatLocalDate(date);
            return iso >= previewFrom && iso <= previewTo;
          }
        : false,
      recurring: highlightWeekdays && highlightWeekdays.length > 0 ? { dayOfWeek: [...highlightWeekdays] } : false,
    }),
    [markSiteCalendar, bankHolidayDates, closureIndex, previewFrom, previewTo, highlightWeekdays]
  );

  // Days outside the bounds cannot be picked (DayPicker renders them disabled).
  const disabledDays = useMemo(
    () => [
      ...(minDate ? [{ before: parseLocalDate(minDate) }] : []),
      ...(maxDate ? [{ after: parseLocalDate(maxDate) }] : []),
    ],
    [minDate, maxDate]
  );

  // ---- placement ----
  const panelRef = useRef<HTMLDivElement>(null);
  const placementRef = useRef<Placement | undefined>(undefined);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  const onAnchorHiddenRef = useRef(onAnchorHidden);
  onAnchorHiddenRef.current = onAnchorHidden;
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const measure = useCallback(() => {
    const panel = panelRef.current;
    const rects = anchorsRef.current.flatMap((ref) => (ref.current ? [ref.current.getBoundingClientRect()] : []));
    if (!panel || rects.length === 0) return;
    const anchor = unionRect(rects);
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (!isAnchorInView(anchor, viewport)) {
      onAnchorHiddenRef.current();
      return;
    }
    // Natural size, even while capped by a previous maxHeight
    const size = { width: panel.offsetWidth, height: panel.scrollHeight + (panel.offsetHeight - panel.clientHeight) };
    const next = computePopoverPosition(anchor, size, viewport, { gap: 4, gutter: 8, keep: placementRef.current });
    placementRef.current = next.placement;
    setPosition((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.maxHeight === next.maxHeight &&
      prev.placement === next.placement
        ? prev
        : next
    );
  }, []);

  // Before paint, and again whenever the calendar's size may change: another
  // month (5 or 6 weeks), one or two months, or the status row DayPicker adds
  // while the end is awaited (`active`).
  useLayoutEffect(() => {
    measure();
  }, [measure, month, numberOfMonths, active]);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, { capture: true });
    };
  }, [measure]);

  // A keyboard activation lands on the active field's day (DayPicker's own
  // autoFocus would pick the first day of the range, and also on mouse opens).
  // Only on a new request: clicks keep focus where DayPicker puts it.
  const focusDayRef = useRef<IsoDate>('');
  focusDayRef.current = active === 'end' ? end || start : start;
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || focusRequest === 0) return;
    const day = focusDayRef.current;
    const target =
      (day && panel.querySelector<HTMLButtonElement>(`td[data-day="${day}"]:not([data-outside]) button`)) ||
      panel.querySelector<HTMLButtonElement>('td button[tabindex="0"]');
    target?.focus();
  }, [focusRequest]);

  const style: CSSProperties = position
    ? { top: position.top, left: position.left, maxHeight: position.maxHeight }
    : { top: 0, left: 0 };

  const handleDayClick = (date: Date) => {
    // A touch tap fires mouseenter but never mouseleave: drop the preview
    setHovered(null);
    onDayClick(formatLocalDate(date));
  };
  const handleMouseEnter = (date: Date) => setHovered(formatLocalDate(date));
  const handleMouseLeave = () => setHovered(null);

  const shared = {
    className: styles.calendar,
    month,
    onMonthChange: setMonth,
    startMonth,
    endMonth,
    numberOfMonths,
    weekStartsOn: 1 as const,
    captionLayout: 'dropdown' as const,
    modifiers,
    modifiersClassNames: MODIFIER_CLASSES,
    disabled: disabledDays.length > 0 ? disabledDays : undefined,
    components: COMPONENTS,
    labels,
    onDayClick: handleDayClick,
    onDayMouseEnter: handleMouseEnter,
    onDayMouseLeave: handleMouseLeave,
  };

  return (
    <div
      ref={panelRef}
      id={id}
      role="dialog"
      aria-label={mode === 'range' ? 'Choose dates' : 'Choose a date'}
      className={styles.panel}
      style={style}
    >
      <DayNotesContext.Provider value={notesOf}>
        {mode === 'range' ? (
          <DayPicker
            {...shared}
            mode="range"
            selected={{
              from: start ? parseLocalDate(start) : undefined,
              to: end ? parseLocalDate(end) : start && emptyEndIsSameDay ? parseLocalDate(start) : undefined,
            }}
            onSelect={noop}
            footer={active === 'end' ? STATUS_AWAITING_END : undefined}
          />
        ) : (
          <DayPicker {...shared} mode="single" selected={start ? parseLocalDate(start) : undefined} onSelect={noop} />
        )}
      </DayNotesContext.Provider>
      {clear && (
        <div className={styles.footer}>
          <Button type="button" variant="ghost" onClick={clear.onClick} disabled={clear.disabled}>
            {clear.label}
          </Button>
        </div>
      )}
    </div>
  );
}
