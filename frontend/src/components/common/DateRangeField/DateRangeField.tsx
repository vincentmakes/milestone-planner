import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Input } from '../Input';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { formatMediumDate } from '@/utils/date';
import { DatePickerPopover } from './DatePickerPopover';
import { applyRangeClick, collapseOptionalEnd, DATE_PLACEHOLDER, OPEN_KEYS } from './dateRangeLogic';
import type { ActiveField, IsoDate } from './dateRangeLogic';
import styles from './DateRangeField.module.css';

/**
 * DateRangeField — a start and an end date picked on one two-month calendar
 * (booking.com style). UI_GUIDELINES §3.4.
 *
 * Two read-only `Input`s (`role="combobox"`) show the dates in the browser
 * locale; their ISO value is in `data-value`. A click, or Enter / Space /
 * ArrowDown on a focused field, opens the calendar under the pair; plain focus
 * never does, so Tab passes through a form. The first click sets the start,
 * the next the end; a start picked after the end moves the end and keeps the
 * duration, an end picked before the start becomes the new start — the end
 * can never precede the start. Each click commits at once through one
 * `onChange` call (a shift is atomic); when the range is complete the End
 * field gets focus and the panel closes.
 *
 * The wrapper is `display: contents`, so the two fields (and the optional
 * `separator`) stay grid items of the consumer's `minmax(0, 1fr)` row; give
 * each field the row's item class through `fieldClassName`.
 */

export interface CommonDateFieldProps {
  disabled?: boolean;
  /** className for each Input (the consumer's grid item). */
  fieldClassName?: string;
  /** Weekdays to highlight (0 = Sunday), e.g. a recurring absence's days. */
  highlightWeekdays?: readonly number[];
  /** Mark the current site's bank holidays and closures (default true). */
  markSiteCalendar?: boolean;
}

export interface DateRangeFieldProps extends CommonDateFieldProps {
  start: IsoDate;
  end: IsoDate;
  /** One call per click, so a shifted range arrives in one piece. */
  onChange: (next: { start: IsoDate; end: IsoDate }) => void;
  startLabel: string;
  endLabel: string;
  startId?: string;
  endId?: string;
  /** The end may be empty: "Clear end date" + Backspace, and an end equal to the start is emitted as ''. */
  endOptional?: boolean;
  /** What an empty end shows (e.g. 'Same day'). */
  endPlaceholder?: string;
  /** Rendered between the two fields. */
  separator?: ReactNode;
}

export function DateRangeField({
  start,
  end,
  onChange,
  startLabel,
  endLabel,
  startId,
  endId,
  endOptional = false,
  endPlaceholder,
  separator,
  disabled = false,
  fieldClassName,
  highlightWeekdays,
  markSiteCalendar = true,
}: DateRangeFieldProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ActiveField>('start');
  /** Bumped on each keyboard activation, 0 after a mouse open (see DatePickerPopover). */
  const [focusRequest, setFocusRequest] = useState(0);
  const panelId = useId();

  const wrapperRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);
  /** The active field: Escape returns focus there. */
  const triggerRef = useRef<HTMLInputElement | null>(null);
  const anchors = useMemo(() => [startRef, endRef], []);

  const close = useCallback(() => setOpen(false), []);
  const { onBlur } = useDismissableOverlay({ open, onClose: close, wrapperRef, triggerRef });

  const refOf = (field: ActiveField) => (field === 'start' ? startRef : endRef);

  const activate = (field: ActiveField) => {
    setActive(field);
    triggerRef.current = refOf(field).current;
  };

  const openFrom = (field: ActiveField, byKeyboard: boolean) => {
    if (disabled) return;
    activate(field);
    if (byKeyboard) setFocusRequest((n) => n + 1);
    else if (!open) setFocusRequest(0);
    setOpen(true);
  };

  /** Close with focus on the End field — moved before the panel unmounts, so it never drops to <body>. */
  const finish = () => {
    endRef.current?.focus();
    setOpen(false);
  };

  const clearEnd = () => onChange({ start, end: '' });

  const handleKeyDown = (field: ActiveField) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (OPEN_KEYS.has(e.key)) {
      // Never submit the enclosing form, never scroll the page
      e.preventDefault();
      openFrom(field, true);
    } else if (e.key === 'Backspace' && field === 'end' && endOptional && end) {
      e.preventDefault();
      clearEnd();
    }
  };

  const handleDayClick = (day: IsoDate) => {
    const next = applyRangeClick({ start, end, active }, day);
    onChange(collapseOptionalEnd({ start: next.start, end: next.end }, endOptional));
    if (next.done) finish();
    else activate(next.active);
  };

  const fieldProps = (field: ActiveField, value: IsoDate) => ({
    readOnly: true,
    role: 'combobox',
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': open,
    'aria-controls': open ? panelId : undefined,
    'data-value': value,
    'data-active': open && active === field ? 'true' : undefined,
    autoComplete: 'off',
    value: formatMediumDate(value),
    disabled,
    className: [styles.field, fieldClassName].filter(Boolean).join(' '),
    onClick: () => openFrom(field, false),
    onKeyDown: handleKeyDown(field),
  });

  return (
    <div ref={wrapperRef} className={styles.wrapper} onBlur={onBlur}>
      <Input ref={startRef} id={startId} label={startLabel} placeholder={DATE_PLACEHOLDER} {...fieldProps('start', start)} />
      {separator}
      <Input
        ref={endRef}
        id={endId}
        label={endLabel}
        placeholder={endPlaceholder ?? DATE_PLACEHOLDER}
        {...fieldProps('end', end)}
      />
      {open && (
        <DatePickerPopover
          id={panelId}
          mode="range"
          state={{ start, end, active }}
          emptyEndIsSameDay={endOptional}
          anchors={anchors}
          focusRequest={focusRequest}
          onDayClick={handleDayClick}
          onAnchorHidden={close}
          clear={
            endOptional
              ? {
                  label: 'Clear end date',
                  disabled: !end,
                  onClick: () => {
                    clearEnd();
                    finish();
                  },
                }
              : undefined
          }
          highlightWeekdays={highlightWeekdays}
          markSiteCalendar={markSiteCalendar}
        />
      )}
    </div>
  );
}
