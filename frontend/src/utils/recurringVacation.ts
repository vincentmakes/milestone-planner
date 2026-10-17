/**
 * Recurring Vacation Utilities
 * 
 * Handles parsing and expanding recurring absence patterns stored in vacation descriptions.
 * 
 * Pattern format in description field:
 *   [R:0,2,4] Rest of description
 *   
 * Where 0-6 represent days of week (0=Sunday, 1=Monday, ..., 6=Saturday)
 * 
 * Examples:
 *   "[R:3] Part-time - Childcare" = Every Wednesday
 *   "[R:1,3] Home office days" = Every Monday and Wednesday
 *   "[R:0,6] Weekend unavailable" = Every Saturday and Sunday
 */

import type { CSSProperties } from 'react';
import type { AbsenceType, Vacation } from '@/types';
import { parseLocalDate, formatLocalDate } from './date';

// Pattern regex: [R:X] or [R:X,Y,Z] at start of description
const RECURRING_PATTERN = /^\[R:([0-6](?:,[0-6])*)\]\s*/;

// Day names for display
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface RecurringPattern {
  /** Days of week (0-6, Sunday=0) */
  daysOfWeek: number[];
  /** Clean description without pattern prefix */
  cleanDescription: string;
}

export interface ExpandedVacation extends Vacation {
  /** Whether this is a recurring vacation */
  isRecurring: boolean;
  /** Original vacation ID if this is an expanded occurrence */
  originalId?: number;
  /** Days of week if recurring */
  recurringDays?: number[];
}

/**
 * Parse recurring pattern from vacation description
 * Returns null if not a recurring vacation
 */
export function parseRecurringPattern(description: string | undefined): RecurringPattern | null {
  if (!description) return null;
  
  const match = description.match(RECURRING_PATTERN);
  if (!match) return null;
  
  const daysStr = match[1];
  const daysOfWeek = daysStr.split(',').map(Number).sort((a, b) => a - b);
  const cleanDescription = description.replace(RECURRING_PATTERN, '').trim() || 'Recurring absence';
  
  return { daysOfWeek, cleanDescription };
}

/**
 * Check if a vacation is recurring
 */
export function isRecurringVacation(vacation: Vacation): boolean {
  return RECURRING_PATTERN.test(vacation.description || '');
}

/**
 * Create recurring pattern string for description
 */
export function createRecurringPattern(daysOfWeek: number[], description: string): string {
  if (daysOfWeek.length === 0) return description;
  const sortedDays = [...daysOfWeek].sort((a, b) => a - b);
  return `[R:${sortedDays.join(',')}] ${description}`.trim();
}

/**
 * Get display text for recurring days
 */
export function getRecurringDaysDisplay(daysOfWeek: number[]): string {
  if (daysOfWeek.length === 0) return '';
  if (daysOfWeek.length === 1) return `Every ${DAY_NAMES_FULL[daysOfWeek[0]]}`;
  if (daysOfWeek.length === 2) {
    return `Every ${DAY_NAMES_FULL[daysOfWeek[0]]} & ${DAY_NAMES_FULL[daysOfWeek[1]]}`;
  }
  return `Every ${daysOfWeek.map(d => DAY_NAMES[d]).join(', ')}`;
}

/**
 * Check if a specific date falls on a recurring vacation day
 */
export function isDateOnRecurringVacation(
  dateStr: string,
  vacation: Vacation,
  pattern: RecurringPattern
): boolean {
  // Local calendar day: `new Date('YYYY-MM-DD')` is UTC midnight and gives
  // the previous weekday west of UTC.
  const dayOfWeek = parseLocalDate(dateStr).getDay();
  
  // Check if date is within vacation range
  const vacStart = vacation.start_date.split('T')[0];
  const vacEnd = vacation.end_date.split('T')[0];
  const checkDate = dateStr.split('T')[0];
  
  if (checkDate < vacStart || checkDate > vacEnd) return false;
  
  // Check if day of week matches
  return pattern.daysOfWeek.includes(dayOfWeek);
}

/**
 * Expand recurring vacations into individual day markers for a given date range
 * This is used for workload calculation and visualization
 */
export function expandRecurringVacations(
  vacations: Vacation[],
  _startDate: string,
  _endDate: string
): ExpandedVacation[] {
  const result: ExpandedVacation[] = [];
  
  for (const vacation of vacations) {
    const pattern = parseRecurringPattern(vacation.description);
    
    if (!pattern) {
      // Regular vacation - pass through
      result.push({
        ...vacation,
        isRecurring: false,
      });
    } else {
      // Recurring vacation - expand within visible range
      // Also add the original with recurring flag for display purposes
      result.push({
        ...vacation,
        description: pattern.cleanDescription,
        isRecurring: true,
        recurringDays: pattern.daysOfWeek,
      });
      
      // Note: We don't need to expand into individual days here
      // The workload calculation will check each cell against the pattern
    }
  }
  
  return result;
}

/**
 * Get all dates within a range that match a recurring pattern
 */
export function getRecurringDates(
  vacation: Vacation,
  pattern: RecurringPattern,
  visibleStart: string,
  visibleEnd: string
): string[] {
  const dates: string[] = [];
  
  // Determine the effective range (intersection of vacation and visible range)
  const vacStart = vacation.start_date.split('T')[0];
  const vacEnd = vacation.end_date.split('T')[0];
  const rangeStart = visibleStart > vacStart ? visibleStart : vacStart;
  const rangeEnd = visibleEnd < vacEnd ? visibleEnd : vacEnd;
  
  // Iterate through dates
  const current = parseLocalDate(rangeStart);
  const end = parseLocalDate(rangeEnd);
  
  while (current <= end) {
    if (pattern.daysOfWeek.includes(current.getDay())) {
      dates.push(formatLocalDate(current));
    }
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}

// =============================================================================
// ABSENCE TYPES
// =============================================================================

/** Label for an absence without a (known) type */
export const UNTYPED_ABSENCE_LABEL = 'Vacation';

/** Absence types keyed by id, for the lookups below */
export type AbsenceTypesById = ReadonlyMap<number, AbsenceType>;

/** The absence active on one day, as returned by getAbsenceOn */
export interface AbsenceOnDay {
  vacation: Vacation;
  /** Null when the vacation is untyped or its type no longer exists */
  type: AbsenceType | null;
  /** Whether the person is unavailable (capacity drops to 0) */
  unavailable: boolean;
  /** Whether the match comes from an [R:...] weekly pattern */
  recurring: boolean;
}

/** Index absence types by id */
export function indexAbsenceTypes(types: readonly AbsenceType[]): Map<number, AbsenceType> {
  return new Map(types.map((t) => [t.id, t]));
}

/** The vacation's absence type, or null when untyped / unknown */
export function absenceTypeFor(
  vacation: Pick<Vacation, 'absence_type_id'>,
  typesById: AbsenceTypesById | undefined
): AbsenceType | null {
  if (vacation.absence_type_id == null || !typesById) return null;
  return typesById.get(vacation.absence_type_id) ?? null;
}

/** Untyped absences keep their historical meaning: the person is unavailable. */
export function isUnavailableType(type: AbsenceType | null | undefined): boolean {
  return type ? type.counts_as_unavailable : true;
}

/** Display name of an absence type ("Vacation" when untyped) */
export function absenceTypeName(type: AbsenceType | null | undefined): string {
  return type?.name ?? UNTYPED_ABSENCE_LABEL;
}

/**
 * Colour of an absence type, or undefined when untyped -- callers fall back
 * to the CSS default (the historical purple) via `var(--absence-color, ...)`.
 */
export function absenceColor(type: AbsenceType | null | undefined): string | undefined {
  return type?.color || undefined;
}

/** Inline style exposing the type colour as `--absence-color` to CSS modules */
export function absenceColorStyle(type: AbsenceType | null | undefined): CSSProperties {
  const color = absenceColor(type);
  return color ? ({ ['--absence-color' as string]: color } as CSSProperties) : {};
}

/** Day of week (0 = Sunday) of a `YYYY-MM-DD` date, in local time */
function dayOfWeek(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/**
 * The absence a staff member has on one day, or null.
 *
 * Honours [R:d,d] recurring patterns (only those weekdays inside the range).
 * When several absences cover the day, an unavailable one wins over an
 * available one (e.g. Illness over Home Office). Pass `staffId: null` when
 * `vacations` already belong to one person.
 */
export function getAbsenceOn(
  staffId: number | null,
  dateStr: string,
  vacations: readonly Vacation[],
  typesById: AbsenceTypesById | undefined
): AbsenceOnDay | null {
  const day = dateStr.split('T')[0];
  let found: AbsenceOnDay | null = null;

  for (const vacation of vacations) {
    if (staffId !== null && vacation.staff_id !== staffId) continue;
    const start = vacation.start_date.split('T')[0];
    const end = vacation.end_date.split('T')[0];
    if (day < start || day > end) continue;

    const pattern = parseRecurringPattern(vacation.description);
    if (pattern && !pattern.daysOfWeek.includes(dayOfWeek(day))) continue;

    const type = absenceTypeFor(vacation, typesById);
    const unavailable = isUnavailableType(type);
    if (unavailable) {
      return { vacation, type, unavailable, recurring: !!pattern };
    }
    if (!found) {
      found = { vacation, type, unavailable, recurring: !!pattern };
    }
  }

  return found;
}

/** Whether the staff member is unavailable (an unavailable absence) on that day */
export function isUnavailableOn(
  staffId: number,
  dateStr: string,
  vacations: readonly Vacation[],
  typesById: AbsenceTypesById | undefined
): boolean {
  return getAbsenceOn(staffId, dateStr, vacations, typesById)?.unavailable === true;
}

/** Description without the [R:...] prefix ("" when empty) */
export function cleanVacationDescription(description: string | undefined): string {
  if (!description) return '';
  const pattern = parseRecurringPattern(description);
  return pattern ? pattern.cleanDescription : description;
}

/** Active absence types in display order */
export function activeAbsenceTypes(types: readonly AbsenceType[]): AbsenceType[] {
  return types.filter((t) => t.is_active).sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * Default type for a new absence: the first active type that counts as
 * unavailable, else the first active type, else null (no types configured).
 */
export function defaultAbsenceTypeId(types: readonly AbsenceType[]): number | null {
  const active = activeAbsenceTypes(types);
  return (active.find((t) => t.counts_as_unavailable) ?? active[0])?.id ?? null;
}

/**
 * Best-guess absence type for an imported calendar entry, or null when nothing
 * matches (the caller then applies its default):
 * 1. Outlook BUSYSTATUS WORKINGELSEWHERE -> the "Home Office"-like type
 * 2. a CATEGORIES value, then the SUMMARY, matching an active type name
 *    (case-insensitive; the summary only has to contain the name)
 */
export function guessAbsenceTypeId(
  event: { busyStatus?: string; categories?: readonly string[]; summary?: string },
  types: readonly AbsenceType[]
): number | null {
  const active = activeAbsenceTypes(types);
  if (active.length === 0) return null;

  if (event.busyStatus?.toUpperCase() === 'WORKINGELSEWHERE') {
    const home = active.find((t) => t.name.toLowerCase().includes('home'));
    if (home) return home.id;
  }

  for (const category of event.categories ?? []) {
    const key = category.trim().toLowerCase();
    const match = key && active.find((t) => t.name.toLowerCase() === key);
    if (match) return match.id;
  }

  const summary = event.summary?.toLowerCase() ?? '';
  if (summary) {
    const match = active.find((t) => summary.includes(t.name.toLowerCase()));
    if (match) return match.id;
  }

  return null;
}
