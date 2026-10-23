/**
 * Helpers shared by the Bank holidays and Company events panels.
 */

import { useAppStore } from '@/stores/appStore';
import {
  getBankHolidays,
  getCompanyEvents,
  buildHolidayDateSet,
  buildEventDateSet,
} from '@/api';
import type { Site } from '@/types';

/** The site a calendar panel starts on: the current site when manageable. */
export function pickDefaultSiteId(
  manageable: Site[],
  currentSiteId: number | undefined,
  preferred?: number
): number | null {
  if (preferred && manageable.some((s) => s.id === preferred)) return preferred;
  if (currentSiteId && manageable.some((s) => s.id === currentSiteId)) return currentSiteId;
  return manageable[0]?.id ?? null;
}

/** Reload the store's holidays when one of `siteIds` is the current site. */
export async function refreshCurrentSiteHolidays(siteIds: number[]): Promise<void> {
  const { currentSite, setBankHolidays } = useAppStore.getState();
  if (!currentSite || !siteIds.includes(currentSite.id)) return;
  try {
    const holidays = await getBankHolidays(currentSite.id);
    setBankHolidays(holidays, buildHolidayDateSet(holidays));
  } catch (err) {
    console.error('Failed to refresh bank holidays:', err);
  }
}

/** Reload the store's company events when one of `siteIds` is the current site. */
export async function refreshCurrentSiteEvents(siteIds: number[]): Promise<void> {
  const { currentSite, setCompanyEvents } = useAppStore.getState();
  if (!currentSite || !siteIds.includes(currentSite.id)) return;
  try {
    const events = await getCompanyEvents(currentSite.id);
    setCompanyEvents(events, buildEventDateSet(events));
  } catch (err) {
    console.error('Failed to refresh company events:', err);
  }
}

/** `YYYY-MM-DD` (or a longer ISO string) → "Mon, 1 Jan 2026" in the browser locale */
export function formatCalendarDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Year of a `YYYY-MM-DD` date string */
export function yearOf(dateStr: string): number {
  return Number(dateStr.slice(0, 4));
}

/** Whether a [start, end] range touches the given year */
export function overlapsYear(start: string, end: string | null | undefined, year: number): boolean {
  const last = (end || start).slice(0, 10);
  return yearOf(start) <= year && yearOf(last) >= year;
}

/** Normalized key for duplicate checks */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A sortable/searchable list of distinct years across the given ranges, plus this year */
export function collectYears(ranges: { date: string; end_date?: string | null }[]): number[] {
  const years = new Set<number>([new Date().getFullYear()]);
  for (const { date, end_date } of ranges) {
    const from = yearOf(date);
    const to = yearOf((end_date || date).slice(0, 10));
    for (let y = from; y <= to; y++) years.add(y);
  }
  return Array.from(years).sort((a, b) => a - b);
}
