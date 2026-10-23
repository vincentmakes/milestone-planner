/**
 * Day -> pixel on the timeline cells the drag and resize hooks read from the
 * DOM (`[data-date]` header cells): the forward counterpart of their
 * `calculateDateFromPosition`, so a bar kept inside bounds in pixels resolves
 * back to a day inside them. Week / month cells are one day each (weekends
 * may be hidden: the first cell on or after the day counts); quarter / year
 * cells are proportional, as in the hooks.
 */
import { parseLocalDate, toDateOnly } from '@/utils/date';
import type { ViewMode } from '@/types';

export interface DomTimelineCell {
  date: string;
  dateEnd?: string;
}

/** The left pixel of `day`'s cell (or of its position inside a wider cell). */
export function pixelOfDate(day: string, cells: readonly DomTimelineCell[], cellWidth: number, viewMode: ViewMode): number {
  if (cells.length === 0) return 0;
  const iso = toDateOnly(day);
  if (viewMode === 'week' || viewMode === 'month') {
    const index = cells.findIndex((cell) => cell.date >= iso);
    return (index === -1 ? cells.length : index) * cellWidth;
  }
  const first = parseLocalDate(cells[0].date);
  first.setHours(0, 0, 0, 0);
  const lastCell = cells[cells.length - 1];
  let last: Date;
  if (viewMode === 'quarter' && lastCell.dateEnd) {
    last = parseLocalDate(lastCell.dateEnd);
    last.setHours(23, 59, 59, 999);
  } else if (viewMode === 'year') {
    const d = parseLocalDate(lastCell.date);
    last = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  } else {
    last = parseLocalDate(lastCell.date);
    last.setHours(23, 59, 59, 999);
  }
  const totalMs = last.getTime() - first.getTime();
  const offset = parseLocalDate(iso).getTime() - first.getTime();
  // A hair past midnight so the inverse (which floors to a day) lands on `day`.
  return ((offset + 60_000) / totalMs) * cells.length * cellWidth;
}
