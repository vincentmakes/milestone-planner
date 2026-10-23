/**
 * Date Utilities
 * Common date manipulation functions used throughout the application
 */

import { 
  format, 
  parse, 
  addDays, 
  addWeeks, 
  addMonths, 
  startOfWeek, 
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
  endOfYear,
  differenceInDays,
  differenceInWeeks,
  differenceInMonths,
  isWeekend,
  isSameDay,
  isWithinInterval,
  getWeek,
  getISOWeek,
  getISOWeekYear,
  getYear,
} from 'date-fns';

// =============================================================================
// DATE FORMATTING
// =============================================================================

/**
 * Format a date as YYYY-MM-DD (ISO date string without time)
 */
export function formatDateISO(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/**
 * Convert any date string to YYYY-MM-DD format for HTML date inputs
 * Handles ISO datetime strings (2024-02-27T00:00:00.000Z) and date strings (2024-02-27)
 */
export function toInputDateFormat(dateString: string | null | undefined): string {
  if (!dateString) return '';
  // If it contains 'T', it's an ISO datetime - extract the date part
  if (dateString.includes('T')) {
    return dateString.split('T')[0];
  }
  // Already in YYYY-MM-DD format
  return dateString;
}

/**
 * Format a date for display using browser locale (e.g., "Jan 15, 2025" or "15 Jan 2025")
 */
export function formatDateDisplay(date: Date): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return formatter.format(date);
}

/**
 * A model date (`YYYY-MM-DD`, or the midnight ISO form) in the browser locale
 * with a short month — `22 Oct 2026` / `Oct 22, 2026`; `''` for no date.
 * The text of the date picker fields.
 */
export function formatMediumDate(iso: string): string {
  return iso ? formatDateDisplay(parseLocalDate(iso)) : '';
}

/**
 * Format a date for short display (e.g., "Jan 15" or "15 Jan")
 */
export function formatDateShort(date: Date): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
  });
  return formatter.format(date);
}

/**
 * Get the browser's locale
 */
function getBrowserLocale(): string {
  return navigator.language || 'en-US';
}

/**
 * Format a date for short display using the browser's locale
 * Uses Intl.DateTimeFormat to respect the user's system preferences
 * @param date - The date to format
 * @returns Formatted date string like "15 Jan" (EU) or "Jan 15" (US) depending on locale
 */
export function formatDateShortLocale(date: Date): string {
  const locale = getBrowserLocale();
  
  // Use Intl.DateTimeFormat to format according to user's locale
  const formatter = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
  });
  
  return formatter.format(date);
}

/**
 * Format a date range for display in project panel
 * Uses browser locale for formatting
 * @param startDate - Start date string (ISO format)
 * @param endDate - End date string (ISO format)
 * @returns Formatted date range like "15 Jan - 28 Feb" (EU) or "Jan 15 - Feb 28" (US)
 */
export function formatShortDateRange(startDate: string, endDate: string): string {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  
  const startFormatted = formatDateShortLocale(start);
  const endFormatted = formatDateShortLocale(end);
  
  return `${startFormatted} - ${endFormatted}`;
}

/**
 * Format a single date for display in project panel
 * Uses browser locale for formatting
 * @param dateString - Date string (ISO format)
 * @returns Formatted date string
 */
export function formatSingleDate(dateString: string): string {
  const date = parseLocalDate(dateString);
  return formatDateShortLocale(date);
}

/**
 * Format a date for timeline header (e.g., "January 2025")
 */
export function formatMonthYear(date: Date): string {
  return format(date, 'MMMM yyyy');
}

/**
 * Format a date for week display (e.g., "W3")
 */
export function formatWeekNumber(date: Date): string {
  return `W${getISOWeek(date)}`;
}

/**
 * Format quarter display (e.g., "Q1 2025")
 */
export function formatQuarter(date: Date): string {
  const quarter = Math.floor(date.getMonth() / 3) + 1;
  return `Q${quarter} ${getYear(date)}`;
}

// =============================================================================
// DATE PARSING
// =============================================================================

/**
 * Parse an ISO date string to a Date object
 */
export function parseDateISO(dateString: string): Date {
  return parse(dateString, 'yyyy-MM-dd', new Date());
}

/**
 * A calendar date: `YYYY-MM-DD`, optionally followed by a midnight time —
 * the backend serializes DATE columns as `YYYY-MM-DDT00:00:00.000Z`
 * (`serialize_date_as_datetime_js`), which names a calendar day, not an instant.
 */
const CALENDAR_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/;

/**
 * Parse a model date string as LOCAL midnight of that calendar day.
 *
 * `new Date('2026-03-02')` (and `new Date('2026-03-02T00:00:00.000Z')`) is UTC
 * midnight, which every browser west of UTC reads back — via getDate(),
 * format(), setHours() — as March 1st. Every date-only string coming from the
 * model, the API or a `data-date` attribute must go through this helper.
 *
 * Strings carrying a real time of day are instants and are parsed as such.
 */
export function parseLocalDate(value: string): Date {
  const m = CALENDAR_DATE_RE.exec(value.trim());
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date(value);
}

/**
 * Format a Date as `YYYY-MM-DD` from its LOCAL calendar components
 * (never `toISOString()`, which is UTC).
 */
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The `YYYY-MM-DD` part of a model date string (date-only or midnight ISO). */
export function toDateOnly(value: string): string {
  return formatLocalDate(parseLocalDate(value));
}

/** Add `days` calendar days to a model date string; returns `YYYY-MM-DD`. */
export function addDaysToDateString(value: string, days: number): string {
  const d = parseLocalDate(value);
  d.setDate(d.getDate() + days);
  return formatLocalDate(d);
}

/**
 * Whole calendar days from `from` to `to` (both model date strings).
 * Rounded, so a DST switch in between (23h/25h day) does not lose a day.
 */
export function daysBetweenDateStrings(from: string, to: string): number {
  return Math.round((parseLocalDate(to).getTime() - parseLocalDate(from).getTime()) / 86400000);
}

/**
 * Parse a date string, handling both ISO and other common formats
 */
export function parseDate(dateString: string): Date {
  return parseLocalDate(dateString);
}

// =============================================================================
// DATE CALCULATIONS
// =============================================================================

/**
 * Get the Monday of the week containing the given date
 */
export function getWeekStart(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 1 });
}

/**
 * Get the Sunday of the week containing the given date
 */
export function getWeekEnd(date: Date): Date {
  return endOfWeek(date, { weekStartsOn: 1 });
}

/**
 * Calculate the number of business days between two dates
 */
export function getBusinessDaysBetween(start: Date, end: Date): number {
  let count = 0;
  const current = new Date(start);
  
  while (current <= end) {
    if (!isWeekend(current)) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  
  return count;
}

/**
 * Add business days to a date
 */
export function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let remaining = days;
  
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    if (!isWeekend(result)) {
      remaining--;
    }
  }
  
  return result;
}

/**
 * Get the ISO week number (1-52/53). Week 1 is the week with the year's
 * first Thursday, so Jan 1 can be in week 52/53 of the previous year.
 * (`getWeek(…, { weekStartsOn: 1 })` is NOT ISO: it numbers the week that
 * contains Jan 1 as week 1.)
 */
export function getISOWeekNumber(date: Date): number {
  return getISOWeek(date);
}

// =============================================================================
// DATE RANGE HELPERS
// =============================================================================

/**
 * Check if a date falls within a range
 */
export function isDateInRange(date: Date, start: Date, end: Date): boolean {
  return isWithinInterval(date, { start, end });
}

/**
 * Check if two date ranges overlap
 */
export function doRangesOverlap(
  start1: Date, 
  end1: Date, 
  start2: Date, 
  end2: Date
): boolean {
  return start1 <= end2 && end1 >= start2;
}

/**
 * Get the overlap between two date ranges (or null if no overlap)
 */
export function getRangeOverlap(
  start1: Date,
  end1: Date,
  start2: Date,
  end2: Date
): { start: Date; end: Date } | null {
  if (!doRangesOverlap(start1, end1, start2, end2)) {
    return null;
  }
  
  return {
    start: new Date(Math.max(start1.getTime(), start2.getTime())),
    end: new Date(Math.min(end1.getTime(), end2.getTime())),
  };
}

// =============================================================================
// PERIOD NAVIGATION
// =============================================================================

/**
 * Navigate to the next/previous period based on view mode
 */
export function navigateDate(
  date: Date, 
  direction: 1 | -1, 
  viewMode: 'week' | 'month' | 'quarter' | 'year'
): Date {
  switch (viewMode) {
    case 'week':
      return addWeeks(date, direction);
    case 'month':
      return addMonths(date, direction);
    case 'quarter':
      return addMonths(date, direction * 3);
    case 'year':
      return addMonths(date, direction * 12);
    default:
      return addMonths(date, direction);
  }
}

/**
 * Get the display label for the current period
 */
export function getPeriodLabel(date: Date, viewMode: 'week' | 'month' | 'quarter' | 'year'): string {
  switch (viewMode) {
    case 'week':
      // The ISO week-numbering year: Jan 1 2027 is "Week 53, 2026".
      return `Week ${getISOWeekNumber(date)}, ${getISOWeekYear(date)}`;
    case 'month':
      return formatMonthYear(date);
    case 'quarter':
      return formatQuarter(date);
    case 'year':
      return getYear(date).toString();
    default:
      return formatMonthYear(date);
  }
}

// =============================================================================
// TIMELINE RANGE CALCULATION
// =============================================================================

/**
 * Get the start and end dates for the visible timeline range
 */
export function getTimelineRange(
  centerDate: Date,
  viewMode: 'week' | 'month' | 'quarter' | 'year',
  periodsBefore: number = 4,
  periodsAfter: number = 4
): { start: Date; end: Date } {
  let start: Date;
  let end: Date;
  
  switch (viewMode) {
    case 'week':
      start = addWeeks(getWeekStart(centerDate), -periodsBefore);
      end = addWeeks(getWeekEnd(centerDate), periodsAfter);
      break;
    case 'month':
      start = startOfMonth(addMonths(centerDate, -periodsBefore));
      end = endOfMonth(addMonths(centerDate, periodsAfter));
      break;
    case 'quarter':
      start = startOfQuarter(addMonths(centerDate, -periodsBefore * 3));
      end = endOfQuarter(addMonths(centerDate, periodsAfter * 3));
      break;
    case 'year':
      start = startOfYear(addMonths(centerDate, -periodsBefore * 12));
      end = endOfYear(addMonths(centerDate, periodsAfter * 12));
      break;
    default:
      start = startOfMonth(addMonths(centerDate, -periodsBefore));
      end = endOfMonth(addMonths(centerDate, periodsAfter));
  }
  
  return { start, end };
}

// =============================================================================
// RE-EXPORTS FROM DATE-FNS
// =============================================================================

export {
  format,
  addDays,
  addWeeks,
  addMonths,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
  endOfYear,
  differenceInDays,
  differenceInWeeks,
  differenceInMonths,
  isWeekend,
  isSameDay,
  isWithinInterval,
  getWeek,
  getYear,
};
