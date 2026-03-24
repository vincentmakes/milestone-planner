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
import type { Vacation } from '@/types';
import { parseRecurringPattern, isDateOnRecurringVacation } from '@/utils/recurringVacation';

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
  /** Whether staff is on vacation during this cell */
  isOnVacation: boolean;
  /** Vacation description if on vacation */
  vacationDescription?: string;
  /** Whether this is a recurring vacation day */
  isRecurringVacation?: boolean;
  /** Available percentage (100 - total, or 0 if on vacation) */
  available: number;
  /** Visual state for styling */
  state: 'empty' | 'partial' | 'full' | 'overloaded' | 'vacation' | 'conflict';
}

/**
 * Calculate workload data for each cell in the timeline
 * @param maxCapacity - Staff member's max capacity (default 100, e.g. 80 for part-time)
 */
export function useWorkloadCalculation(
  assignments: AssignmentWithDates[],
  vacations: Vacation[],
  cells: TimelineCell[],
  maxCapacity: number = 100
): WorkloadCell[] {
  return useMemo(() => {
    return cells.map((cell) => {
      // Use the pre-formatted dateStr from the cell (local timezone, YYYY-MM-DD format)
      const cellDateStr = cell.dateStr;
      
      // Check if on vacation (extract date part for comparison)
      // Now handles both regular and recurring vacations
      let activeVacation: Vacation | undefined;
      let isRecurring = false;
      
      for (const v of vacations) {
        const vStart = v.start_date.split('T')[0];
        const vEnd = v.end_date.split('T')[0];
        
        // Check if within date range first
        if (cellDateStr >= vStart && cellDateStr <= vEnd) {
          const pattern = parseRecurringPattern(v.description);
          
          if (pattern) {
            // Recurring vacation - check if this day of week matches
            if (isDateOnRecurringVacation(cellDateStr, v, pattern)) {
              activeVacation = { ...v, description: pattern.cleanDescription };
              isRecurring = true;
              break;
            }
          } else {
            // Regular vacation - within range means on vacation
            activeVacation = v;
            isRecurring = false;
            break;
          }
        }
      }
      
      const isOnVacation = !!activeVacation;
      
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
        if (total > 0) {
          // Conflict: on vacation but has work assigned
          state = 'conflict';
        } else {
          state = 'vacation';
        }
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
      
      return {
        total,
        assignments: activeAssignments,
        isOnVacation,
        vacationDescription: activeVacation?.description,
        isRecurringVacation: isRecurring,
        available,
        state,
      };
    });
  }, [assignments, vacations, cells, maxCapacity]);
}

/**
 * Generate tooltip text for a workload cell
 */
export function getWorkloadTooltip(workload: WorkloadCell): string {
  if (workload.isOnVacation) {
    const vacDesc = workload.vacationDescription || 'Vacation';
    const recurringNote = workload.isRecurringVacation ? ' (recurring)' : '';
    if (workload.total > 0) {
      return `${vacDesc}${recurringNote}\n⚠️ Conflict: ${workload.total}% assigned during vacation`;
    }
    return `${vacDesc}${recurringNote}`;
  }
  
  if (workload.total === 0) {
    return 'Available';
  }
  
  let text = `${workload.total}% allocated`;
  
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
  switch (workload.state) {
    case 'vacation':
      return {
        background: 'rgba(139, 92, 246, 0.25)', // Purple
      };
      
    case 'conflict':
      return {
        background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.3), rgba(239, 68, 68, 0.3))',
      };
      
    case 'overloaded':
      // Red gradient from bottom, intensity based on overload amount
      const overloadIntensity = Math.min(100, workload.total - 100);
      const redOpacity = 0.3 + overloadIntensity / 200;
      return {
        background: `linear-gradient(to top, rgba(239, 68, 68, ${redOpacity}) ${Math.min(100, workload.total)}%, transparent ${Math.min(100, workload.total)}%)`,
      };
      
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
