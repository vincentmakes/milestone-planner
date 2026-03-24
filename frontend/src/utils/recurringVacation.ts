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

import type { Vacation } from '@/types';

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
  const date = new Date(dateStr);
  const dayOfWeek = date.getDay();
  
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
  const current = new Date(rangeStart);
  const end = new Date(rangeEnd);
  
  while (current <= end) {
    if (pattern.daysOfWeek.includes(current.getDay())) {
      dates.push(current.toISOString().split('T')[0]);
    }
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}
