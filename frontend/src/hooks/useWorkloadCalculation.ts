/**
 * useWorkloadCalculation Hook
 * 
 * Calculates per-cell workload data for Staff View heatmap visualization.
 * For each timeline cell (day/week), determines:
 * - Total allocation percentage from all assignments
 * - Whether staff is on vacation (including recurring patterns)
 * - Contributing assignments for tooltip
 * - Visual state (overloaded, full, partial, vacation, conflict, nonworking)
 *
 * `workloadRuns` then merges adjacent cells that read the same into one block
 * (the Staff overview draws one block per run, not one per day).
 */

import { useMemo } from 'react';
import type { TimelineCell } from '@/components/gantt/utils';
import type { CompanyEvent, Vacation } from '@/types';
import { getAbsenceOn, absenceTypeName, absenceColor, cleanVacationDescription } from '@/utils/recurringVacation';
import type { AbsenceTypesById } from '@/utils/recurringVacation';
import { DEFAULT_EVENT_COLOR } from '@/utils/colorSwatches';
import { isPendingAssignment } from '@/utils/kanbanCards';
import { isWorkingDay } from '@/utils/workingDays';

/**
 * Site closures affecting the row's person: a day → event map, or a lookup
 * (e.g. `getClosureOn` bound to their sites and the store's closure index).
 */
export type ClosureLookup =
  | ReadonlyMap<string, CompanyEvent>
  | ((dateStr: string) => CompanyEvent | null);

// Assignment with context from Staff View
interface AssignmentWithDates {
  id: number;
  allocation: number;
  start_date: string;
  end_date: string;
  projectName?: string;
  phaseName?: string;
  /** 'pending' = a booking awaiting approval: shown elsewhere, never counted */
  approval_status?: 'approved' | 'pending';
}

export interface WorkloadCell {
  /** Total allocation percentage for this cell */
  total: number;
  /** List of assignments active during this cell */
  assignments: AssignmentWithDates[];
  /** Whether staff is unavailable (an absence that counts as unavailable) during this cell */
  isOnVacation: boolean;
  /** Vacation description if on vacation */
  vacationDescription?: string;
  /** Whether this is a recurring vacation day */
  isRecurringVacation?: boolean;
  /** Name of the absence type covering this cell (available or not) */
  absenceName?: string;
  /** Colour of that absence type; undefined for untyped absences */
  absenceColor?: string;
  /** True when the cell has an absence that does not reduce capacity (e.g. Home Office) */
  hasAvailableAbsence?: boolean;
  /** Name of the company event closing the person's site on this day */
  closureName?: string;
  /** Colour of that closure event */
  closureColor?: string;
  /** Available percentage (100 - total, or 0 if on vacation) */
  available: number;
  /**
   * Visual state for styling. `nonworking`: a day that is not a working day
   * (`isWorkingDay`: a weekend while weekends are not working days) — drawn
   * as nothing, whatever is booked or absent on it.
   */
  state: 'empty' | 'partial' | 'full' | 'overloaded' | 'vacation' | 'conflict' | 'nonworking';
}

/**
 * A day inside a run with an absence that leaves the person available
 * (Home Office): drawn as an underline under that day only, in the absence
 * type's colour, and named in the block's title.
 */
export interface AvailableAbsenceDay {
  index: number;
  date: string;
  /** The absence type's colour; undefined for an untyped absence */
  color?: string;
  /** The absence as the tooltip names it ("Home Office: Remote day") */
  label: string;
}

/**
 * One block of the Staff overview: cells `from`…`to` (indices, inclusive)
 * that read the same, drawn with `workload` (the first cell's) and titled
 * `tooltip`, covering `startDate`…`endDate`. `availableAbsenceDays` are the
 * run's days with an available absence (they do not split a run).
 */
export interface WorkloadRun {
  from: number;
  to: number;
  workload: WorkloadCell;
  tooltip: string;
  startDate: string;
  endDate: string;
  availableAbsenceDays: AvailableAbsenceDay[];
}

/**
 * Workload for each timeline cell (pure; the hook below memoizes it).
 * Only absences whose type counts as unavailable (or untyped ones) zero the
 * capacity; an available absence (Home Office) is reported but leaves the
 * capacity untouched. A site closure (company event flagged as such) zeroes
 * the capacity like an unavailable absence, under the event's name and colour.
 *
 * A day that is no working day (`utils/workingDays.ts`, decided on the cell's
 * `dateStr`; `weekendsWorking` = Settings → General → Weekends are working
 * days) is `nonworking` before anything else: precedence nonworking >
 * absence / closure > booking, so a booking across a weekend books nothing on
 * Saturday and Sunday unless weekends are working days — the dashboards' rule.
 */
export function calculateWorkloadCells(
  assignments: AssignmentWithDates[],
  vacations: Vacation[],
  cells: TimelineCell[],
  maxCapacity: number = 100,
  absenceTypesById?: AbsenceTypesById,
  closures?: ClosureLookup,
  weekendsWorking: boolean = false
): WorkloadCell[] {
  const closureOn = (dateStr: string): CompanyEvent | null => {
    if (!closures) return null;
    if (typeof closures === 'function') return closures(dateStr);
    return closures.get(dateStr) ?? null;
  };

  return cells.map((cell) => {
    // Use the pre-formatted dateStr from the cell (local timezone, YYYY-MM-DD format)
    const cellDateStr = cell.dateStr;

    if (!isWorkingDay(cellDateStr, weekendsWorking)) {
      return { total: 0, assignments: [], isOnVacation: false, available: 0, state: 'nonworking' };
    }

    // The vacations passed in all belong to this staff member (null = no staff filter)
    const absence = getAbsenceOn(null, cellDateStr, vacations, absenceTypesById);
    const closure = closureOn(cellDateStr);
    const isOnVacation = !!absence?.unavailable || closure !== null;

    // Find all assignments active on this date (extract date part for comparison).
    // A booking awaiting approval books no capacity until it is approved.
    const activeAssignments = assignments.filter((a) => {
      if (isPendingAssignment(a)) return false;
      const aStart = a.start_date.split('T')[0];
      const aEnd = a.end_date.split('T')[0];
      return cellDateStr >= aStart && cellDateStr <= aEnd;
    });

    // Sum allocations
    const total = activeAssignments.reduce((sum, a) => sum + (a.allocation || 0), 0);

    // Calculate available and state
    let available: number;
    let state: WorkloadCell['state'];

    if (isOnVacation) {
      available = 0;
      // Conflict: unavailable but has work assigned
      state = total > 0 ? 'conflict' : 'vacation';
    } else if (total === 0) {
      available = 100;
      state = 'empty';
    } else if (total > maxCapacity) {
      available = 100 - total; // Will be negative
      state = 'overloaded';
    } else if (total === maxCapacity) {
      available = 0;
      state = 'full';
    } else {
      available = 100 - total;
      state = 'partial';
    }

    const description = absence ? cleanVacationDescription(absence.vacation.description) || undefined : undefined;

    return {
      total,
      assignments: activeAssignments,
      isOnVacation,
      vacationDescription: description,
      isRecurringVacation: absence?.recurring ?? false,
      absenceName: absence ? absenceTypeName(absence.type) : undefined,
      absenceColor: absence ? absenceColor(absence.type) : undefined,
      hasAvailableAbsence: !!absence && !absence.unavailable,
      closureName: closure ? closure.name : undefined,
      closureColor: closure ? closure.color || DEFAULT_EVENT_COLOR : undefined,
      available,
      state,
    };
  });
}

/**
 * Calculate workload data for each cell in the timeline
 * @param maxCapacity - Staff member's max capacity (default 100, e.g. 80 for part-time)
 * @param absenceTypesById - Absence types; without it every absence counts as unavailable
 * @param closures - Site closures affecting this person (see ClosureLookup)
 * @param weekendsWorking - Saturdays and Sundays are working days (`selectWeekendsWorking`)
 */
export function useWorkloadCalculation(
  assignments: AssignmentWithDates[],
  vacations: Vacation[],
  cells: TimelineCell[],
  maxCapacity: number = 100,
  absenceTypesById?: AbsenceTypesById,
  closures?: ClosureLookup,
  weekendsWorking: boolean = false
): WorkloadCell[] {
  return useMemo(
    () =>
      calculateWorkloadCells(assignments, vacations, cells, maxCapacity, absenceTypesById, closures, weekendsWorking),
    [assignments, vacations, cells, maxCapacity, absenceTypesById, closures, weekendsWorking]
  );
}

/**
 * Generate tooltip text for a workload cell
 */
/** The absence of a cell as the tooltip names it: "Type: description (recurring)" */
function absenceText(workload: WorkloadCell): string {
  const recurringNote = workload.isRecurringVacation ? ' (recurring)' : '';
  const absenceLabel = workload.absenceName
    ? (workload.vacationDescription && workload.vacationDescription !== workload.absenceName
        ? `${workload.absenceName}: ${workload.vacationDescription}`
        : workload.absenceName)
    : (workload.vacationDescription || 'Vacation');
  return `${absenceLabel}${recurringNote}`;
}

export function getWorkloadTooltip(workload: WorkloadCell): string {
  return describeWorkload(workload, `${workload.total}%`);
}

/** `getWorkloadTooltip` with the conflict amount spelled `conflictTotal` (a run's "50–170%") */
function describeWorkload(workload: WorkloadCell, conflictTotal: string): string {
  const hasAbsence = !!workload.absenceName || !!workload.vacationDescription;

  if (workload.isOnVacation) {
    // A site closure is named first; an absence on the same day is listed under it
    const label = workload.closureName
      ? `Site closed: ${workload.closureName}${hasAbsence ? `\n${absenceText(workload)}` : ''}`
      : absenceText(workload);
    if (workload.total > 0) {
      const during = workload.closureName ? 'site closure' : 'absence';
      return `${label}\n⚠️ Conflict: ${conflictTotal} assigned during ${during}`;
    }
    return label;
  }

  // An absence that does not reduce capacity (e.g. Home Office) is mentioned
  // on top of the normal workload text.
  const prefix = workload.hasAvailableAbsence ? `${absenceText(workload)}\n` : '';

  if (workload.total === 0) {
    return `${prefix}Available`;
  }
  
  let text = `${prefix}${workload.total}% allocated`;
  
  if (workload.assignments.length > 1) {
    text += ` (${workload.assignments.length} assignments)`;
  }
  
  if (workload.total > 100) {
    text += `\n⚠️ Overloaded by ${workload.total - 100}%`;
  }
  
  return text;
}

/**
 * The badge of a workload block: "OFF" when an absence or a site closure
 * makes the person unavailable, "0%" on a conflict, the allocation otherwise;
 * none for a cell without allocation (an available absence alone) or a
 * non-working day.
 */
export function workloadLabel(workload: WorkloadCell): string | null {
  switch (workload.state) {
    case 'empty':
    case 'nonworking':
      return null;
    case 'vacation':
      return 'OFF';
    case 'conflict':
      return '0%';
    default:
      return `${workload.total}%`;
  }
}

/** A cell the heatmap draws nothing for: no allocation, no absence, or a non-working day */
function drawsNothing(workload: WorkloadCell): boolean {
  if (workload.state === 'nonworking') return true;
  return workload.total === 0 && !workload.isOnVacation && !workload.hasAvailableAbsence;
}

/**
 * A cell as its run reads it: without its available absence (Home Office),
 * which is drawn as an underline and named in the block's title instead --
 * also on a closure day, where the tooltip would otherwise name it.
 */
function withoutAvailableAbsence(workload: WorkloadCell): WorkloadCell {
  if (!workload.hasAvailableAbsence) return workload;
  return workload.isOnVacation
    ? { ...workload, hasAvailableAbsence: false, absenceName: undefined, vacationDescription: undefined, isRecurringVacation: false }
    : { ...workload, hasAvailableAbsence: false };
}

/**
 * Merges the workload cells into runs (pure): cells that draw something and
 * are adjacent by index join one run while they read the same -- the badge,
 * the state, the colour of an absence or closure block and the tooltip (so
 * two different absences both reading "OFF" stay apart). Two things do not
 * split a run: an available absence (Home Office), left out of the key and
 * the tooltip and listed in the run's `availableAbsenceDays` instead (one
 * underline per day), and the amount booked during a closure or absence --
 * every such day reads "0%"; the run's tooltip gives the amount, or its
 * range ("50–170%") when it varies. Adjacency is by index, as in
 * `eventLanes.ts`: with weekends hidden, Friday and the next Monday are
 * neighbours and join. `dates` are the cells' `dateStr`s.
 */
export function workloadRuns(cells: WorkloadCell[], dates: string[]): WorkloadRun[] {
  const runs: WorkloadRun[] = [];
  // The booked amounts of the current conflict run (its tooltip's range)
  let conflictTotals: number[] = [];
  let key: string | null = null;
  cells.forEach((workload, index) => {
    if (drawsNothing(workload)) {
      key = null;
      return;
    }
    const base = withoutAvailableAbsence(workload);
    const offBlock = workload.state === 'vacation' || workload.state === 'conflict';
    const cellKey = JSON.stringify([
      workloadLabel(workload),
      workload.state,
      offBlock ? (workload.closureColor ?? workload.absenceColor ?? null) : null,
      // A conflict's amount does not split the run
      describeWorkload(base, workload.state === 'conflict' ? '' : `${base.total}%`),
    ]);
    const day: AvailableAbsenceDay | null = workload.hasAvailableAbsence
      ? { index, date: dates[index], color: workload.absenceColor, label: absenceText(workload) }
      : null;
    const last = runs[runs.length - 1];
    if (last && key === cellKey && last.to === index - 1) {
      last.to = index;
      last.endDate = dates[index];
      if (day) last.availableAbsenceDays.push(day);
      if (workload.state === 'conflict') {
        conflictTotals.push(workload.total);
        const low = Math.min(...conflictTotals);
        const high = Math.max(...conflictTotals);
        last.tooltip = describeWorkload(withoutAvailableAbsence(last.workload), low === high ? `${low}%` : `${low}–${high}%`);
      }
      return;
    }
    key = cellKey;
    conflictTotals = [workload.total];
    runs.push({
      from: index,
      to: index,
      workload,
      tooltip: getWorkloadTooltip(base),
      startDate: dates[index],
      endDate: dates[index],
      availableAbsenceDays: day ? [day] : [],
    });
  });
  return runs;
}

/**
 * The longest block the Staff overview draws, in cells: a longer run is cut
 * into blocks of at most this many cells, so a label is always in view.
 */
export const MAX_RUN_CELLS = 10;

/**
 * Cuts each run into consecutive pieces of at most `maxCells` cells (pure):
 * a 23-cell run gives 10, 10 and 3. Each piece keeps the run's `workload`
 * and `tooltip`, takes its own `startDate` / `endDate` from `dates` and the
 * run's `availableAbsenceDays` that fall inside it.
 */
export function chunkRuns(runs: WorkloadRun[], dates: string[], maxCells: number = MAX_RUN_CELLS): WorkloadRun[] {
  const size = Math.max(1, Math.floor(maxCells));
  return runs.flatMap((run) => {
    const pieces: WorkloadRun[] = [];
    for (let from = run.from; from <= run.to; from += size) {
      const to = Math.min(run.to, from + size - 1);
      pieces.push({
        ...run,
        from,
        to,
        startDate: dates[from],
        endDate: dates[to],
        availableAbsenceDays: run.availableAbsenceDays.filter((day) => day.index >= from && day.index <= to),
      });
    }
    return pieces;
  });
}

export default useWorkloadCalculation;
