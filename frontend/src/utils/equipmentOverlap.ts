/**
 * Equipment overlap detection.
 *
 * An equipment is "in conflict" when, on the same day, it is reserved by more
 * than one of: a project booking (project / phase / subphase level) or a
 * maintenance / defect block. This module provides:
 *
 *  - `findOverlapSegments`: returns the merged date ranges where ≥2 items
 *    overlap, given a flat list of items.
 *  - `buildEquipmentOverlapMap`: walks the `Project` graph + `EquipmentBlock`
 *    list and returns `Map<equipmentId, OverlapInfo>`.
 *
 * Date strings are expected as ISO `YYYY-MM-DD` (or longer ISO strings — only
 * the date portion is used). Comparisons use lexicographic string order, which
 * is correct for ISO dates without time zones.
 */

import type { Project, EquipmentBlock } from '@/types';

export interface OverlapSegment {
  start: string; // ISO YYYY-MM-DD
  end: string;
}

export interface OverlapInfo {
  hasOverlap: boolean;
  segments: OverlapSegment[];
}

interface DateRange {
  start: string;
  end: string;
}

/**
 * Normalize a date string to YYYY-MM-DD (handles ISO strings with time).
 */
function normalizeDate(d: string): string {
  return d.substring(0, 10);
}

/**
 * Add one day to a YYYY-MM-DD string.
 */
function addOneDay(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, day));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().substring(0, 10);
}

/**
 * Find the intersection of two inclusive date ranges, or null.
 */
function intersect(a: DateRange, b: DateRange): DateRange | null {
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  return start <= end ? { start, end } : null;
}

/**
 * Merge contiguous / overlapping segments into a minimal list.
 * Two segments touch when one's end + 1 day == the other's start.
 */
function mergeSegments(segments: OverlapSegment[]): OverlapSegment[] {
  if (segments.length === 0) return segments;
  const sorted = [...segments].sort((a, b) => a.start.localeCompare(b.start));
  const merged: OverlapSegment[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    // Touching or overlapping?
    if (cur.start <= addOneDay(last.end)) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Find all date ranges where two or more items in `ranges` overlap.
 * Pairwise intersections are computed (O(n²); n is small per equipment) and
 * the resulting segments are merged.
 */
export function findOverlapSegments(ranges: DateRange[]): OverlapSegment[] {
  const normalized = ranges.map((r) => ({
    start: normalizeDate(r.start),
    end: normalizeDate(r.end),
  }));
  const overlaps: OverlapSegment[] = [];
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const inter = intersect(normalized[i], normalized[j]);
      if (inter) overlaps.push(inter);
    }
  }
  return mergeSegments(overlaps);
}

/**
 * Walk projects + blocks and produce a per-equipment overlap map.
 * Considers project-level, phase-level and subphase-level bookings, plus
 * equipment blocks.
 */
export function buildEquipmentOverlapMap(
  projects: Project[],
  blocks: EquipmentBlock[],
): Map<number, OverlapInfo> {
  const perEquipment = new Map<number, DateRange[]>();

  const push = (equipmentId: number, range: DateRange) => {
    if (!perEquipment.has(equipmentId)) perEquipment.set(equipmentId, []);
    perEquipment.get(equipmentId)!.push(range);
  };

  for (const project of projects) {
    if (project.archived) continue;

    for (const a of project.equipmentAssignments || []) {
      push(a.equipment_id, { start: a.start_date, end: a.end_date });
    }
    for (const phase of project.phases || []) {
      for (const a of phase.equipmentAssignments || []) {
        push(a.equipment_id, {
          start: a.start_date || phase.start_date,
          end: a.end_date || phase.end_date,
        });
      }
      const walkSubs = (subs: typeof phase.children | undefined) => {
        if (!subs) return;
        for (const sub of subs) {
          for (const a of sub.equipmentAssignments || []) {
            push(a.equipment_id, {
              start: a.start_date || sub.start_date,
              end: a.end_date || sub.end_date,
            });
          }
          walkSubs(sub.children);
        }
      };
      walkSubs(phase.children);
    }
  }

  for (const b of blocks) {
    push(b.equipment_id, { start: b.start_date, end: b.end_date });
  }

  const result = new Map<number, OverlapInfo>();
  for (const [equipmentId, ranges] of perEquipment) {
    const segments = findOverlapSegments(ranges);
    result.set(equipmentId, { hasOverlap: segments.length > 0, segments });
  }
  return result;
}
