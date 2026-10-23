import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Input } from '../Input';
import { useDismissableOverlay } from '@/hooks/useDismissableOverlay';
import { formatMediumDate } from '@/utils/date';
import { DatePickerPopover } from './DatePickerPopover';
import { clampDay, DATE_PLACEHOLDER, OPEN_KEYS } from './dateRangeLogic';
import type { IsoDate } from './dateRangeLogic';
import type { CommonDateFieldProps } from './DateRangeField';
import styles from './DateRangeField.module.css';

/**
 * DateField — one date on the same calendar as `DateRangeField` (a
 * milestone's date): a read-only `Input` (`role="combobox"`, ISO value in
 * `data-value`) that opens the calendar on a click or Enter / Space /
 * ArrowDown; one click on a day selects it, closes the panel and returns focus
 * to the field.
 */

export interface DateFieldProps extends CommonDateFieldProps {
  value: IsoDate;
  onChange: (next: IsoDate) => void;
  label: string;
  id?: string;
  placeholder?: string;
  fullWidth?: boolean;
}

export function DateField({
  value,
  onChange,
  label,
  id,
  placeholder = DATE_PLACEHOLDER,
  fullWidth = false,
  disabled = false,
  fieldClassName,
  highlightWeekdays,
  markSiteCalendar = true,
  minDate,
  maxDate,
}: DateFieldProps) {
  const [open, setOpen] = useState(false);
  /** Bumped on each keyboard activation, 0 after a mouse open (see DatePickerPopover). */
  const [focusRequest, setFocusRequest] = useState(0);
  const panelId = useId();

  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchors = useMemo(() => [inputRef], []);

  const close = useCallback(() => setOpen(false), []);
  const { onBlur } = useDismissableOverlay({ open, onClose: close, wrapperRef, triggerRef: inputRef });

  /** A keyboard activation while open (after a mouse open) moves focus into the calendar, as in DateRangeField. */
  const openPanel = (byKeyboard: boolean) => {
    if (disabled) return;
    if (byKeyboard) setFocusRequest((n) => n + 1);
    else if (!open) setFocusRequest(0);
    setOpen(true);
  };

  /** Close with focus on the field — moved before the panel unmounts, so it never drops to <body>. */
  const finish = () => {
    inputRef.current?.focus();
    setOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (OPEN_KEYS.has(e.key)) {
      // Never submit the enclosing form, never scroll the page
      e.preventDefault();
      openPanel(true);
    }
  };

  const handleDayClick = (day: IsoDate) => {
    onChange(clampDay(day, minDate, maxDate));
    finish();
  };

  return (
    <div ref={wrapperRef} className={styles.wrapper} onBlur={onBlur}>
      <Input
        ref={inputRef}
        id={id}
        label={label}
        placeholder={placeholder}
        fullWidth={fullWidth}
        readOnly
        role="combobox"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-value={value}
        autoComplete="off"
        value={formatMediumDate(value)}
        disabled={disabled}
        className={[styles.field, fieldClassName].filter(Boolean).join(' ')}
        onClick={() => openPanel(false)}
        onKeyDown={handleKeyDown}
      />
      {open && (
        <DatePickerPopover
          id={panelId}
          mode="single"
          state={{ start: value, end: '', active: 'start' }}
          emptyEndIsSameDay={false}
          anchors={anchors}
          focusRequest={focusRequest}
          onDayClick={handleDayClick}
          onAnchorHidden={close}
          highlightWeekdays={highlightWeekdays}
          markSiteCalendar={markSiteCalendar}
          minDate={minDate}
          maxDate={maxDate}
        />
      )}
    </div>
  );
}
