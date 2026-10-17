/**
 * useWorkloadCalculation Hook
 * 
 * Calculates per-cell workload data for Staff View heatmap visualization.
 * For each timeline cell (day/week), determines:
 * - Total allocation percentage from all assignments
 * - Whether staff is on vacation (including recurring patterns)
 * - Contributing assignments for tooltip
 * - Visual state (overloaded, full, partial, vacation, conflict)
 */

import { useMemo } from 'react';
import type { TimelineCell } from '@/components/gantt/utils';
import type { CompanyEvent, Vacation } from '@/types';
import { getAbsenceOn, absenceTypeName, absenceColor, cleanVacationDescription } from '@/utils/recurringVacation';
import type { AbsenceTypesById } from '@/utils/recurringVacation';
import { DEFAULT_EVENT_COLOR } from '@/utils/colorSwatches';

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
  /** Visual state for styling */
  state: 'empty' | 'partial' | 'full' | 'overloaded' | 'vacation' | 'conflict';
}

/**
 * Workload for each timeline cell (pure; the hook below memoizes it).
 * Only absences whose type counts as unavailable (or untyped ones) zero the
 * capacity; an available absence (Home Office) is reported but leaves the
 * capacity untouched. A site closure (company event flagged as such) zeroes
 * the capacity like an unavailable absence, under the event's name and colour.
 */
export function calculateWorkloadCells(
  assignments: AssignmentWithDates[],
  vacations: Vacation[],
  cells: TimelineCell[],
  maxCapacity: number = 100,
  absenceTypesById?: AbsenceTypesById,
  closures?: ClosureLookup
): WorkloadCell[] {
  const closureOn = (dateStr: string): CompanyEvent | null => {
    if (!closures) return null;
    if (typeof closures === 'function') return closures(dateStr);
    return closures.get(dateStr) ?? null;
  };

  return cells.map((cell) => {
    // Use the pre-formatted dateStr from the cell (local timezone, YYYY-MM-DD format)
    const cellDateStr = cell.dateStr;

    // The vacations passed in all belong to this staff member (null = no staff filter)
    const absence = getAbsenceOn(null, cellDateStr, vacations, absenceTypesById);
    const closure = closureOn(cellDateStr);
    const isOnVacation = !!absence?.unavailable || closure !== null;

    // Find all assignments active on this date (extract date part for comparison)
    const activeAssignments = assignments.filter((a) => {
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
 */
export function useWorkloadCalculation(
  assignments: AssignmentWithDates[],
  vacations: Vacation[],
  cells: TimelineCell[],
  maxCapacity: number = 100,
  absenceTypesById?: AbsenceTypesById,
  closures?: ClosureLookup
): WorkloadCell[] {
  return useMemo(
    () => calculateWorkloadCells(assignments, vacations, cells, maxCapacity, absenceTypesById, closures),
    [assignments, vacations, cells, maxCapacity, absenceTypesById, closures]
  );
}

/**
 * Generate tooltip text for a workload cell
 */
export function getWorkloadTooltip(workload: WorkloadCell): string {
  const recurringNote = workload.isRecurringVacation ? ' (recurring)' : '';
  const hasAbsence = !!workload.absenceName || !!workload.vacationDescription;
  const absenceLabel = workload.absenceName
    ? (workload.vacationDescription && workload.vacationDescription !== workload.absenceName
        ? `${workload.absenceName}: ${workload.vacationDescription}`
        : workload.absenceName)
    : (workload.vacationDescription || 'Vacation');

  if (workload.isOnVacation) {
    // A site closure is named first; an absence on the same day is listed under it
    const label = workload.closureName
      ? `Site closed: ${workload.closureName}${hasAbsence ? `\n${absenceLabel}${recurringNote}` : ''}`
      : `${absenceLabel}${recurringNote}`;
    if (workload.total > 0) {
      const during = workload.closureName ? 'site closure' : 'absence';
      return `${label}\n⚠️ Conflict: ${workload.total}% assigned during ${during}`;
    }
    return label;
  }

  // An absence that does not reduce capacity (e.g. Home Office) is mentioned
  // on top of the normal workload text.
  const prefix = workload.hasAvailableAbsence ? `${absenceLabel}${recurringNote}\n` : '';

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
 * Get CSS background style for workload visualization
 */
export function getWorkloadBackground(workload: WorkloadCell): React.CSSProperties {
  // A site closure is painted in the event's colour; otherwise the absence
  // type colour, with the historical purple for untyped absences.
  const offColor = workload.closureColor ?? workload.absenceColor;
  switch (workload.state) {
    case 'vacation':
      return {
        background: offColor
          ? `color-mix(in srgb, ${offColor} 25%, transparent)`
          : 'rgba(139, 92, 246, 0.25)',
      };

    case 'conflict':
      return {
        background: offColor
          ? `linear-gradient(135deg, color-mix(in srgb, ${offColor} 30%, transparent), rgba(239, 68, 68, 0.3))`
          : 'linear-gradient(135deg, rgba(139, 92, 246, 0.3), rgba(239, 68, 68, 0.3))',
      };
      
    case 'overloaded': {
      // Red gradient from bottom, intensity based on overload amount
      const overloadIntensity = Math.min(100, workload.total - 100);
      const redOpacity = 0.3 + overloadIntensity / 200;
      return {
        background: `linear-gradient(to top, rgba(239, 68, 68, ${redOpacity}) ${Math.min(100, workload.total)}%, transparent ${Math.min(100, workload.total)}%)`,
      };
    }
      
    case 'full':
      return {
        background: 'rgba(59, 130, 246, 0.25)', // Blue
      };
      
    case 'partial':
      // Blue gradient from bottom proportional to allocation
      return {
        background: `linear-gradient(to top, rgba(59, 130, 246, 0.2) ${workload.total}%, transparent ${workload.total}%)`,
      };
      
    default:
      return {};
  }
}

export default useWorkloadCalculation;
