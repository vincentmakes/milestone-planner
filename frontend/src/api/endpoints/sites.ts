/**
 * Sites API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete, downloadFile } from '../client';
import type { Site, BankHoliday, CompanyEvent, CalendarImportResult } from '@/types';
import { postInChunks } from './importChunks';

// =============================================================================
// SITES
// =============================================================================

/**
 * Get all sites
 */
export async function getSites(): Promise<Site[]> {
  return apiGet<Site[]>('/api/sites');
}

/**
 * Get a single site
 */
export async function getSite(id: number): Promise<Site> {
  return apiGet<Site>(`/api/sites/${id}`);
}

/**
 * Create a new site
 */
export async function createSite(data: Omit<Site, 'id' | 'created_at'>): Promise<Site> {
  return apiPost<Site>('/api/sites', data);
}

/**
 * Update a site
 */
export async function updateSite(id: number, data: Partial<Omit<Site, 'id'>>): Promise<Site> {
  return apiPut<Site>(`/api/sites/${id}`, data);
}

/**
 * Delete a site
 */
export async function deleteSite(id: number): Promise<void> {
  await apiDelete(`/api/sites/${id}`);
}

/**
 * Export all data for a site as an Excel (.xlsx) file.
 * Triggers a browser download. Restricted to admin / superuser on the backend.
 */
export async function exportSiteToExcel(siteId: number, siteName?: string): Promise<void> {
  const safeName = (siteName || `site-${siteId}`).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const fallback = `${safeName}-export.xlsx`;
  await downloadFile(`/api/export/site/${siteId}/excel`, fallback);
}

// =============================================================================
// BANK HOLIDAYS
// =============================================================================

/**
 * Get bank holidays for a site
 * @param siteId - Site ID
 * @param year - Optional year filter
 */
export async function getBankHolidays(siteId: number, year?: number): Promise<BankHoliday[]> {
  const url = year 
    ? `/api/sites/${siteId}/holidays?year=${year}`
    : `/api/sites/${siteId}/holidays`;
  return apiGet<BankHoliday[]>(url);
}

/**
 * Add a custom bank holiday
 */
export async function addCustomHoliday(
  siteId: number, 
  data: { date: string; end_date?: string; name: string }
): Promise<BankHoliday> {
  return apiPost<BankHoliday>(`/api/sites/${siteId}/holidays`, data);
}

// Alias for consistent naming
export const createBankHoliday = addCustomHoliday;

/**
 * Delete a custom bank holiday
 */
export async function deleteCustomHoliday(siteId: number, holidayId: number): Promise<void> {
  await apiDelete(`/api/sites/${siteId}/holidays/${holidayId}`);
}

// Alias for consistent naming
export const deleteBankHoliday = deleteCustomHoliday;

/**
 * Update a bank holiday. Editing a holiday fetched from the Nager API turns it
 * into a custom one, which then takes precedence over Nager for that date.
 */
export async function updateBankHoliday(
  siteId: number,
  holidayId: number,
  data: { date?: string; end_date?: string | null; name?: string }
): Promise<BankHoliday> {
  return apiPut<BankHoliday>(`/api/sites/${siteId}/holidays/${holidayId}`, data);
}

export interface HolidayImportItem {
  date: string;
  end_date?: string | null;
  name: string;
}

/**
 * Bulk-import custom holidays into a site (e.g. from an .ics file).
 * Existing (date, name) pairs are skipped server-side. Large lists are sent
 * in chunks (see `postInChunks`).
 */
export async function importBankHolidays(
  siteId: number,
  items: HolidayImportItem[]
): Promise<CalendarImportResult> {
  return postInChunks(items, (chunk) =>
    apiPost<CalendarImportResult>(`/api/sites/${siteId}/holidays/import`, { items: chunk })
  );
}

/**
 * Refresh bank holidays from external source (Nager holiday API)
 */
export async function refreshBankHolidays(siteId: number): Promise<BankHoliday[]> {
  return apiPost<BankHoliday[]>(`/api/sites/${siteId}/holidays/refresh`);
}

// =============================================================================
// COMPANY EVENTS
// =============================================================================

/**
 * Get company events for a site
 */
export async function getCompanyEvents(siteId: number): Promise<CompanyEvent[]> {
  return apiGet<CompanyEvent[]>(`/api/sites/${siteId}/events`);
}

/**
 * Create a company event
 */
export async function createCompanyEvent(
  siteId: number,
  data: { date: string; end_date?: string; name: string; color?: string }
): Promise<CompanyEvent> {
  return apiPost<CompanyEvent>(`/api/sites/${siteId}/events`, data);
}

/**
 * Remove a company event from a site. The event itself is deleted only when
 * no other site is linked to it.
 */
export async function deleteCompanyEvent(siteId: number, eventId: number): Promise<void> {
  await apiDelete(`/api/sites/${siteId}/events/${eventId}`);
}

export interface CompanyEventInput {
  date: string;
  end_date?: string | null;
  name: string;
  color?: string | null;
  site_ids: number[];
  /** Site closure: staff on the event's sites are unavailable for its dates */
  counts_as_unavailable?: boolean;
}

/**
 * Create a company event on one or more sites
 */
export async function createCompanyEventMultiSite(data: CompanyEventInput): Promise<CompanyEvent> {
  return apiPost<CompanyEvent>('/api/events', data);
}

/**
 * Update a company event (any field, including the set of linked sites)
 */
export async function updateCompanyEvent(
  eventId: number,
  data: Partial<CompanyEventInput>
): Promise<CompanyEvent> {
  return apiPut<CompanyEvent>(`/api/events/${eventId}`, data);
}

/**
 * Delete a company event from every site it is linked to
 */
export async function deleteCompanyEventById(eventId: number): Promise<void> {
  await apiDelete(`/api/events/${eventId}`);
}

/**
 * Bulk-import company events onto one or more sites (e.g. from an .ics file).
 * An existing (date, end_date, name) event only gains the missing site links.
 * `counts_as_unavailable` applies to the newly created events only. Large
 * lists are sent in chunks (see `postInChunks`).
 */
export async function importCompanyEvents(data: {
  site_ids: number[];
  color?: string | null;
  counts_as_unavailable?: boolean;
  items: HolidayImportItem[];
}): Promise<CalendarImportResult> {
  const { items, ...rest } = data;
  return postInChunks(items, (chunk) =>
    apiPost<CalendarImportResult>('/api/events/import', { ...rest, items: chunk })
  );
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Build a Set of holiday date strings for quick lookup
 * Expands date ranges into individual dates
 */
export function buildHolidayDateSet(holidays: BankHoliday[]): Set<string> {
  const dates = new Set<string>();
  
  holidays.forEach(holiday => {
    // Normalize date strings to YYYY-MM-DD (handles ISO strings with time)
    const startStr = holiday.date.substring(0, 10);
    const endStr = (holiday.end_date || holiday.date).substring(0, 10);
    
    // Parse as local dates to avoid timezone issues
    const [startYear, startMonth, startDay] = startStr.split('-').map(Number);
    const [endYear, endMonth, endDay] = endStr.split('-').map(Number);
    
    const startDate = new Date(startYear, startMonth - 1, startDay);
    const endDate = new Date(endYear, endMonth - 1, endDay);
    
    // Add all dates in the range
    const current = new Date(startDate);
    while (current <= endDate) {
      const dateStr = formatDateForLookup(current);
      dates.add(dateStr);
      current.setDate(current.getDate() + 1);
    }
  });
  
  return dates;
}

/**
 * Build a Set of company event date strings for quick lookup
 */
export function buildEventDateSet(events: CompanyEvent[]): Set<string> {
  const dates = new Set<string>();
  
  events.forEach(event => {
    // Normalize date strings to YYYY-MM-DD (handles ISO strings with time)
    const startStr = event.date.substring(0, 10);
    const endStr = (event.end_date || event.date).substring(0, 10);
    
    // Parse as local dates to avoid timezone issues
    const [startYear, startMonth, startDay] = startStr.split('-').map(Number);
    const [endYear, endMonth, endDay] = endStr.split('-').map(Number);
    
    const startDate = new Date(startYear, startMonth - 1, startDay);
    const endDate = new Date(endYear, endMonth - 1, endDay);
    
    // Add all dates in the range
    const current = new Date(startDate);
    while (current <= endDate) {
      const dateStr = formatDateForLookup(current);
      dates.add(dateStr);
      current.setDate(current.getDate() + 1);
    }
  });
  
  return dates;
}

/**
 * Format a date as YYYY-MM-DD for holiday lookup
 */
function formatDateForLookup(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
