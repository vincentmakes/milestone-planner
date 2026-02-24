/**
 * Sites API endpoints
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../client';
import type { Site, BankHoliday, CompanyEvent } from '@/types';

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
 * Refresh bank holidays from external source (Nager.Date API)
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
  data: { date: string; end_date?: string; name: string }
): Promise<CompanyEvent> {
  return apiPost<CompanyEvent>(`/api/sites/${siteId}/events`, data);
}

/**
 * Delete a company event
 */
export async function deleteCompanyEvent(siteId: number, eventId: number): Promise<void> {
  await apiDelete(`/api/sites/${siteId}/events/${eventId}`);
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
