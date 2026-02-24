/**
 * Timeline Generation Utilities
 * Generates cells for the Gantt chart timeline based on view mode
 */

import {
  format,
  addDays,
  addWeeks,
  addMonths,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  getWeek,
  isWeekend,
  isSameDay,
  startOfQuarter,
} from 'date-fns';
import type { ViewMode } from '@/types';

// =============================================================================
// TYPES
// =============================================================================

export interface TimelineCell {
  date: Date;
  dateStr: string; // ISO format for comparisons
  dateEnd?: Date; // End date for cells that span multiple days (quarter view weeks)
  label: string;
  isToday: boolean;
  isWeekend: boolean;
  isBankHoliday: boolean;
  isCustomHoliday: boolean;
  bankHolidayName?: string;
  isCompanyEvent: boolean;
  companyEventName?: string;
  dayOfWeek: number;
  isFirstOfWeek: boolean;
  isFirstOfMonth: boolean;
  weekNumber: number;
  monthLabel: string;
  yearLabel: string;
}

export interface TimelineHeader {
  label: string;
  span: number;
  isCurrentPeriod: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

// Increased buffer sizes for better zoom-out support
const PERIODS_CONFIG: Record<ViewMode, { before: number; after: number }> = {
  week: { before: 26, after: 52 },     // ~6 months before, ~1 year after (daily cells)
  month: { before: 12, after: 36 },    // 1 year before, 3 years after (daily cells)
  quarter: { before: 8, after: 16 },   // 2 years before, 4 years after (weekly cells)
  year: { before: 3, after: 7 },       // 3 years before, 7 years after (monthly cells)
};

// =============================================================================
// CELL GENERATORS
// =============================================================================

/**
 * Generate timeline cells based on view mode
 */
export function generateTimelineCells(
  currentDate: Date,
  viewMode: ViewMode,
  bankHolidayDates: Set<string>,
  bankHolidays: Array<{ date: string; end_date?: string | null; name: string; is_custom?: boolean }>,
  companyEventDates: Set<string> = new Set(),
  companyEvents: Array<{ date: string; end_date?: string | null; name: string }> = []
): TimelineCell[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Helper to normalize date strings to YYYY-MM-DD (handles ISO strings with time)
  const normalizeDate = (dateStr: string): string => dateStr.substring(0, 10);

  const getHolidayInfo = (date: Date): { name?: string; isCustom: boolean } => {
    const dateStr = format(date, 'yyyy-MM-dd');
    // Find holiday that includes this date (handles multi-day holidays)
    const holiday = bankHolidays.find((h) => {
      const startDate = normalizeDate(h.date);
      const endDate = normalizeDate(h.end_date || h.date);
      return dateStr >= startDate && dateStr <= endDate;
    });
    return {
      name: holiday?.name,
      isCustom: holiday?.is_custom ?? false,
    };
  };
  
  const getEventInfo = (date: Date): { name?: string; isEvent: boolean } => {
    const dateStr = format(date, 'yyyy-MM-dd');
    // Find event that includes this date (handles multi-day events)
    const event = companyEvents.find((e) => {
      const startDate = normalizeDate(e.date);
      const endDate = normalizeDate(e.end_date || e.date);
      return dateStr >= startDate && dateStr <= endDate;
    });
    return {
      name: event?.name,
      isEvent: companyEventDates.has(dateStr),
    };
  };

  switch (viewMode) {
    case 'week':
      return generateWeekViewCells(currentDate, today, bankHolidayDates, getHolidayInfo, getEventInfo);
    case 'month':
      return generateMonthViewCells(currentDate, today, bankHolidayDates, getHolidayInfo, getEventInfo);
    case 'quarter':
      return generateQuarterViewCells(currentDate, today, bankHolidayDates, getHolidayInfo, getEventInfo);
    case 'year':
      return generateYearViewCells(currentDate, today, bankHolidayDates, getHolidayInfo, getEventInfo);
    default:
      return [];
  }
}

/**
 * Week view: Shows individual days, spanning ~8 weeks
 */
function generateWeekViewCells(
  currentDate: Date,
  today: Date,
  bankHolidayDates: Set<string>,
  getHolidayInfo: (date: Date) => { name?: string; isCustom: boolean },
  getEventInfo: (date: Date) => { name?: string; isEvent: boolean }
): TimelineCell[] {
  const cells: TimelineCell[] = [];
  const { before, after } = PERIODS_CONFIG.week;

  // Start from beginning of current week, minus 'before' weeks
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 }); // Monday
  const startDate = addWeeks(weekStart, -before);
  const totalWeeks = before + after + 1;
  const totalDays = totalWeeks * 7;

  for (let i = 0; i < totalDays; i++) {
    const date = addDays(startDate, i);
    cells.push(createCell(date, today, bankHolidayDates, getHolidayInfo, getEventInfo));
  }

  return cells;
}

/**
 * Month view: Shows individual days, spanning ~12 months
 */
function generateMonthViewCells(
  currentDate: Date,
  today: Date,
  bankHolidayDates: Set<string>,
  getHolidayInfo: (date: Date) => { name?: string; isCustom: boolean },
  getEventInfo: (date: Date) => { name?: string; isEvent: boolean }
): TimelineCell[] {
  const cells: TimelineCell[] = [];
  const { before, after } = PERIODS_CONFIG.month;

  // Start from beginning of current month, minus 'before' months
  const monthStart = startOfMonth(currentDate);
  const startDate = addMonths(monthStart, -before);
  const endDate = endOfMonth(addMonths(monthStart, after));

  let current = startDate;
  while (current <= endDate) {
    cells.push(createCell(current, today, bankHolidayDates, getHolidayInfo, getEventInfo));
    current = addDays(current, 1);
  }

  return cells;
}

/**
 * Quarter view: Shows weeks, spanning ~4 quarters
 */
function generateQuarterViewCells(
  currentDate: Date,
  today: Date,
  bankHolidayDates: Set<string>,
  getHolidayInfo: (date: Date) => { name?: string; isCustom: boolean },
  getEventInfo: (date: Date) => { name?: string; isEvent: boolean }
): TimelineCell[] {
  const cells: TimelineCell[] = [];
  const { before, after } = PERIODS_CONFIG.quarter;

  // Start from beginning of current quarter, minus 'before' quarters
  const quarterStart = startOfQuarter(currentDate);
  const startDate = addMonths(quarterStart, -before * 3);
  const endDate = addMonths(quarterStart, (after + 1) * 3);

  // Generate weekly cells
  let current = startOfWeek(startDate, { weekStartsOn: 1 });
  while (current < endDate) {
    const weekEnd = addDays(current, 6);
    // For quarter view, isToday should be true if today falls within the week
    const isTodayInWeek = today >= current && today <= weekEnd;
    
    const cell = createCell(current, today, bankHolidayDates, getHolidayInfo, getEventInfo);
    // Add week end date (Sunday) for quarter view
    cell.dateEnd = weekEnd;
    // Override isToday to check if today is within this week
    cell.isToday = isTodayInWeek;
    cells.push(cell);
    current = addWeeks(current, 1);
  }

  return cells;
}

/**
 * Year view: Shows months, spanning ~3 years
 */
function generateYearViewCells(
  currentDate: Date,
  _today: Date,
  _bankHolidayDates: Set<string>,
  _getHolidayInfo: (date: Date) => { name?: string; isCustom: boolean },
  _getEventInfo: (date: Date) => { name?: string; isEvent: boolean }
): TimelineCell[] {
  const cells: TimelineCell[] = [];
  const { before, after } = PERIODS_CONFIG.year;

  // Start from January of current year, minus 'before' years
  const yearStart = new Date(currentDate.getFullYear(), 0, 1);
  const startDate = addMonths(yearStart, -before * 12);
  const totalMonths = (before + after + 1) * 12;

  for (let i = 0; i < totalMonths; i++) {
    const date = addMonths(startDate, i);
    // For year view, create cells with month labels
    cells.push(createYearViewCell(date));
  }

  return cells;
}

/**
 * Create a single timeline cell for year view (monthly cells)
 */
function createYearViewCell(
  date: Date
): TimelineCell {
  const dateStr = format(date, 'yyyy-MM-dd');
  const dayOfWeek = date.getDay();
  const currentMonth = new Date();
  currentMonth.setHours(0, 0, 0, 0);
  const isCurrentMonth = date.getFullYear() === currentMonth.getFullYear() &&
                         date.getMonth() === currentMonth.getMonth();

  return {
    date,
    dateStr,
    label: format(date, 'MMM'), // Month abbreviation for year view
    isToday: isCurrentMonth, // Highlight current month
    isWeekend: false, // Not applicable for month-level cells
    isBankHoliday: false, // Not applicable for month-level cells
    isCustomHoliday: false, // Not applicable for month-level cells
    bankHolidayName: undefined,
    isCompanyEvent: false, // Not applicable for month-level cells
    companyEventName: undefined,
    dayOfWeek,
    isFirstOfWeek: date.getDate() <= 7 && dayOfWeek === 1,
    isFirstOfMonth: true, // Every cell is start of month
    weekNumber: getWeek(date, { weekStartsOn: 1 }),
    monthLabel: format(date, 'MMM'),
    yearLabel: format(date, 'yyyy'),
  };
}

/**
 * Create a single timeline cell
 */
function createCell(
  date: Date,
  today: Date,
  bankHolidayDates: Set<string>,
  getHolidayInfo: (date: Date) => { name?: string; isCustom: boolean },
  getEventInfo: (date: Date) => { name?: string; isEvent: boolean }
): TimelineCell {
  const dateStr = format(date, 'yyyy-MM-dd');
  const dayOfWeek = date.getDay();
  const holidayInfo = getHolidayInfo(date);
  const eventInfo = getEventInfo(date);

  return {
    date,
    dateStr,
    label: format(date, 'd'),
    isToday: isSameDay(date, today),
    isWeekend: isWeekend(date),
    isBankHoliday: bankHolidayDates.has(dateStr),
    isCustomHoliday: holidayInfo.isCustom,
    bankHolidayName: holidayInfo.name,
    isCompanyEvent: eventInfo.isEvent,
    companyEventName: eventInfo.name,
    dayOfWeek,
    isFirstOfWeek: dayOfWeek === 1, // Monday
    isFirstOfMonth: date.getDate() === 1,
    weekNumber: getWeek(date, { weekStartsOn: 1 }),
    monthLabel: format(date, 'MMM'),
    yearLabel: format(date, 'yyyy'),
  };
}

// =============================================================================
// HEADER GENERATORS
// =============================================================================

/**
 * Generate header rows for the timeline
 */
export function generateTimelineHeaders(
  cells: TimelineCell[],
  viewMode: ViewMode
): { primary: TimelineHeader[]; secondary: TimelineHeader[] } {
  switch (viewMode) {
    case 'week':
      return {
        primary: generateMonthHeaders(cells),
        secondary: generateDayHeaders(cells),
      };
    case 'month':
      return {
        primary: generateMonthHeaders(cells),
        secondary: generateDayHeaders(cells),
      };
    case 'quarter':
      return {
        primary: generateQuarterHeaders(cells),
        secondary: generateWeekHeaders(cells),
      };
    case 'year':
      return {
        primary: generateYearHeaders(cells),
        secondary: generateMonthOnlyHeaders(cells),
      };
    default:
      return { primary: [], secondary: [] };
  }
}

function generateMonthHeaders(cells: TimelineCell[]): TimelineHeader[] {
  const headers: TimelineHeader[] = [];
  let currentMonth = '';
  let currentSpan = 0;
  const today = new Date();

  cells.forEach((cell, index) => {
    const monthKey = `${cell.yearLabel}-${cell.monthLabel}`;
    
    if (monthKey !== currentMonth) {
      if (currentSpan > 0) {
        headers.push({
          label: currentMonth.split('-')[1] + ' ' + currentMonth.split('-')[0],
          span: currentSpan,
          isCurrentPeriod: false,
        });
      }
      currentMonth = monthKey;
      currentSpan = 1;
    } else {
      currentSpan++;
    }

    // Last cell
    if (index === cells.length - 1) {
      headers.push({
        label: currentMonth.split('-')[1] + ' ' + currentMonth.split('-')[0],
        span: currentSpan,
        isCurrentPeriod: format(today, 'yyyy-MMM') === currentMonth,
      });
    }
  });

  return headers;
}

function generateDayHeaders(cells: TimelineCell[]): TimelineHeader[] {
  return cells.map((cell) => ({
    label: cell.label,
    span: 1,
    isCurrentPeriod: cell.isToday,
  }));
}

function generateQuarterHeaders(cells: TimelineCell[]): TimelineHeader[] {
  const headers: TimelineHeader[] = [];
  let currentQuarter = '';
  let currentSpan = 0;

  cells.forEach((cell, index) => {
    const quarter = Math.floor(cell.date.getMonth() / 3) + 1;
    const quarterKey = `Q${quarter} ${cell.yearLabel}`;

    if (quarterKey !== currentQuarter) {
      if (currentSpan > 0) {
        headers.push({
          label: currentQuarter,
          span: currentSpan,
          isCurrentPeriod: false,
        });
      }
      currentQuarter = quarterKey;
      currentSpan = 1;
    } else {
      currentSpan++;
    }

    if (index === cells.length - 1) {
      headers.push({
        label: currentQuarter,
        span: currentSpan,
        isCurrentPeriod: false,
      });
    }
  });

  return headers;
}

function generateWeekHeaders(cells: TimelineCell[]): TimelineHeader[] {
  return cells.map((cell) => ({
    label: `W${cell.weekNumber}`,
    span: 1,
    isCurrentPeriod: cell.isToday,
  }));
}

function generateYearHeaders(cells: TimelineCell[]): TimelineHeader[] {
  const headers: TimelineHeader[] = [];
  let currentYear = '';
  let currentSpan = 0;
  const thisYear = new Date().getFullYear().toString();

  cells.forEach((cell, index) => {
    if (cell.yearLabel !== currentYear) {
      if (currentSpan > 0) {
        headers.push({
          label: currentYear,
          span: currentSpan,
          isCurrentPeriod: currentYear === thisYear,
        });
      }
      currentYear = cell.yearLabel;
      currentSpan = 1;
    } else {
      currentSpan++;
    }

    if (index === cells.length - 1) {
      headers.push({
        label: currentYear,
        span: currentSpan,
        isCurrentPeriod: currentYear === thisYear,
      });
    }
  });

  return headers;
}

function generateMonthOnlyHeaders(cells: TimelineCell[]): TimelineHeader[] {
  const today = new Date();
  const currentMonthKey = format(today, 'yyyy-MM');

  return cells.map((cell) => ({
    label: cell.monthLabel,
    span: 1,
    isCurrentPeriod: format(cell.date, 'yyyy-MM') === currentMonthKey,
  }));
}

// =============================================================================
// POSITIONING UTILITIES
// =============================================================================

/**
 * Calculate the pixel position and width for a bar on the timeline
 * Uses proportional date-to-pixel calculation like vanilla JS
 */
export function calculateBarPosition(
  startDate: string,
  endDate: string,
  cells: TimelineCell[],
  cellWidth: number,
  viewMode?: ViewMode
): { left: number; width: number } | null {
  if (!cells.length || !startDate || !endDate) return null;

  // Parse dates - handle both "YYYY-MM-DD" and full ISO timestamps
  // Extract just the date part if it's a full timestamp
  const startDateStr = String(startDate).split('T')[0];
  const endDateStr = String(endDate).split('T')[0];
  
  const sd = new Date(startDateStr + 'T00:00:00');
  const ed = new Date(endDateStr + 'T23:59:59.999'); // End of the end day
  
  // Check for invalid dates
  if (isNaN(sd.getTime()) || isNaN(ed.getTime())) {
    return null;
  }
  
  // Get first cell date, normalize to start of day
  const fcd = new Date(cells[0].date);
  fcd.setHours(0, 0, 0, 0);
  
  // Get last cell end date based on view mode
  let lcd: Date;
  const lastCell = cells[cells.length - 1];
  
  if (viewMode === 'quarter' && lastCell.dateEnd) {
    // Quarter view uses weekly cells - use the week's end date
    lcd = new Date(lastCell.dateEnd);
    lcd.setHours(23, 59, 59, 999);
  } else if (viewMode === 'year') {
    // Year view: each cell is a month, so end at last day of month
    lcd = new Date(lastCell.date);
    lcd = new Date(lcd.getFullYear(), lcd.getMonth() + 1, 0, 23, 59, 59, 999);
  } else {
    // Week/Month view: each cell is a day
    lcd = new Date(lastCell.date);
    lcd.setHours(23, 59, 59, 999);
  }
  
  // Check if bar is completely outside visible range
  if (ed < fcd || sd > lcd) return null;
  
  // Calculate total time span in milliseconds
  const totalMs = lcd.getTime() - fcd.getTime();
  const tw = cells.length * cellWidth; // total width in pixels
  
  // Calculate bar start position - clamp to start of timeline
  const barStartMs = Math.max(fcd.getTime(), sd.getTime());
  const left = ((barStartMs - fcd.getTime()) / totalMs) * tw;
  
  // Calculate bar end position - clamp to end of timeline
  const barEndMs = Math.min(lcd.getTime(), ed.getTime());
  const right = ((barEndMs - fcd.getTime()) / totalMs) * tw;
  
  // Calculate width - ensure minimum width for visibility
  const width = Math.max(20, right - left);
  
  return { left, width };
}

/**
 * Find the cell index for a given date
 */
export function findCellIndex(date: Date, cells: TimelineCell[]): number {
  const dateStr = format(date, 'yyyy-MM-dd');
  return cells.findIndex((cell) => cell.dateStr === dateStr);
}

/**
 * Calculate today line position
 */
export function calculateTodayPosition(
  cells: TimelineCell[],
  cellWidth: number
): number | null {
  const todayIndex = cells.findIndex((cell) => cell.isToday);
  if (todayIndex === -1) return null;
  return todayIndex * cellWidth + cellWidth / 2;
}

/**
 * Generate complete timeline data (cells + headers + dimensions)
 * Convenience function that combines generateTimelineCells and generateTimelineHeaders
 */
export function generateTimelineData(
  currentDate: Date,
  viewMode: ViewMode,
  cellWidth: number,
  bankHolidayDates: Set<string>,
  bankHolidays: Array<{ date: string; name: string }>
): {
  cells: TimelineCell[];
  headers: { primary: TimelineHeader[]; secondary: TimelineHeader[] };
  totalWidth: number;
} {
  const cells = generateTimelineCells(
    currentDate,
    viewMode,
    bankHolidayDates,
    bankHolidays
  );
  
  const headers = generateTimelineHeaders(cells, viewMode);
  const totalWidth = cells.length * cellWidth;
  
  return { cells, headers, totalWidth };
}
