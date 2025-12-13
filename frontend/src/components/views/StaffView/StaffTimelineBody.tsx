/**
 * StaffTimelineBody
 * Timeline body for staff view - shows stacked assignments and vacations
 * Uses same structure as TimelineBody from main Gantt
 * Supports expanded view with detail rows for vacations and assignments
 * Includes workload heatmap visualization per cell
 */

import { forwardRef, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { calculateBarPosition } from '@/components/gantt/utils';
import { useWorkloadCalculation, getWorkloadTooltip, getWorkloadBackground } from '@/hooks';
import { BAR_HEIGHT, BAR_GAP, ROW_PADDING, DETAIL_ROW_HEIGHT, INDICATOR_AREA_HEIGHT } from './StaffView';
import type { TimelineCell } from '@/components/gantt/utils';
import type { Staff, Vacation, ViewMode } from '@/types';
import type { StaffAssignmentWithContext } from './StaffView';
import styles from './StaffTimelineBody.module.css';

interface StaffTimelineBodyProps {
  staff: Staff[];
  assignmentsMap: Map<number, StaffAssignmentWithContext[]>;
  vacationsMap: Map<number, Vacation[]>;
  rowHeights: Map<number, number>;
  expandedStaff: Set<number>;
  expandedBankHolidays: boolean;
  cells: TimelineCell[];
  cellWidth: number;
  totalWidth: number;
  viewMode: ViewMode;
}

export const StaffTimelineBody = forwardRef<HTMLDivElement, StaffTimelineBodyProps>(
  function StaffTimelineBody({ 
    staff, 
    assignmentsMap, 
    vacationsMap,
    rowHeights,
    expandedStaff,
    expandedBankHolidays,
    cells, 
    cellWidth, 
    totalWidth,
    viewMode 
  }, ref) {
    
    const bankHolidays = useAppStore((s) => s.bankHolidays);
    const currentUser = useAppStore((s) => s.currentUser);
    
    const showHighlighting = viewMode === 'week' || viewMode === 'month';
    
    // Check if user can add vacations for a staff member
    const canManageVacation = (staffId: number) => {
      if (!currentUser) return false;
      if (currentUser.role === 'admin' || currentUser.role === 'superuser') return true;
      return currentUser.id === staffId;
    };
    
    return (
      <div ref={ref} className={styles.body}>
        <div 
          className={styles.content}
          style={{ 
            width: totalWidth,
            '--cell-width': `${cellWidth}px`
          } as React.CSSProperties}
        >
          {/* Grid background */}
          <div className={styles.grid}>
            {showHighlighting && cells.map((cell, index) => 
              cell.isWeekend ? (
                <div
                  key={`weekend-${index}`}
                  className={`${styles.gridCell} ${styles.weekend}`}
                  style={{ left: index * cellWidth, width: cellWidth }}
                />
              ) : null
            )}
            {showHighlighting && cells.map((cell, index) => 
              cell.isBankHoliday ? (
                <div
                  key={`holiday-${index}`}
                  className={`${styles.gridCell} ${styles.holiday}`}
                  style={{ left: index * cellWidth, width: cellWidth }}
                />
              ) : null
            )}
            {cells.map((cell, index) => 
              cell.isToday ? (
                <div
                  key={`today-${index}`}
                  className={`${styles.gridCell} ${styles.today}`}
                  style={{ left: index * cellWidth, width: cellWidth }}
                />
              ) : null
            )}
          </div>
          
          {/* Staff rows */}
          <div className={styles.rows}>
            {staff.map((staffMember) => {
              const isExpanded = expandedStaff.has(staffMember.id);
              const staffVacations = vacationsMap.get(staffMember.id) || [];
              const staffAssignments = assignmentsMap.get(staffMember.id) || [];
              const canManage = canManageVacation(staffMember.id);
              
              return (
                <div key={staffMember.id} className={styles.staffWrapper}>
                  {/* Main row with stacked bars */}
                  <StaffRow
                    staffMember={staffMember}
                    assignments={staffAssignments}
                    vacations={staffVacations}
                    rowHeight={rowHeights.get(staffMember.id) || 44}
                    cells={cells}
                    cellWidth={cellWidth}
                    viewMode={viewMode}
                  />
                  
                  {/* Expanded detail rows */}
                  {isExpanded && (
                    <>
                      {/* Vacation detail rows */}
                      {staffVacations.map((vacation) => (
                        <VacationDetailRow
                          key={`v-${vacation.id}`}
                          vacation={vacation}
                          cells={cells}
                          cellWidth={cellWidth}
                          viewMode={viewMode}
                        />
                      ))}
                      
                      {/* Add vacation placeholder row */}
                      {canManage && (
                        <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />
                      )}
                      
                      {/* Assignment detail rows */}
                      {staffAssignments.map((assignment) => (
                        <AssignmentDetailRow
                          key={`a-${assignment.id}-${assignment.level}`}
                          assignment={assignment}
                          cells={cells}
                          cellWidth={cellWidth}
                          viewMode={viewMode}
                        />
                      ))}
                      
                      {/* Empty placeholder if no items */}
                      {staffAssignments.length === 0 && staffVacations.length === 0 && !canManage && (
                        <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />
                      )}
                    </>
                  )}
                </div>
              );
            })}
            
            {/* Bank holidays row */}
            <BankHolidaysTimelineRow
              isExpanded={expandedBankHolidays}
              holidays={bankHolidays}
              cells={cells}
              cellWidth={cellWidth}
              viewMode={viewMode}
            />
          </div>
        </div>
      </div>
    );
  }
);

// Individual staff row with stacked bars and workload heatmap
interface StaffRowProps {
  staffMember: Staff;
  assignments: StaffAssignmentWithContext[];
  vacations: Vacation[];
  rowHeight: number;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function StaffRow({ assignments, vacations, rowHeight, cells, cellWidth, viewMode }: StaffRowProps) {
  const { openVacationModal } = useUIStore();
  
  // Calculate workload per cell
  const workloadCells = useWorkloadCalculation(assignments, vacations, cells);
  
  // Only show workload heatmap in week/month view (not quarter/year - cells too small)
  const showWorkloadHeatmap = viewMode === 'week' || viewMode === 'month';
  
  // Calculate bar positions and stack them
  const stackedBars = useMemo(() => {
    // Combine all items with their positions
    const allItems: Array<{
      type: 'assignment' | 'vacation';
      id: number;
      startDate: string;
      endDate: string;
      label: string;
      allocation?: number;
      data: StaffAssignmentWithContext | Vacation;
    }> = [];
    
    // Add assignments
    assignments.forEach((assignment) => {
      let label = assignment.projectName;
      if (assignment.phaseName) {
        label += ` - ${assignment.phaseName}`;
      }
      label += ` (${assignment.allocation}%)`;
      
      allItems.push({
        type: 'assignment',
        id: assignment.id,
        startDate: assignment.start_date,
        endDate: assignment.end_date,
        label,
        allocation: assignment.allocation,
        data: assignment,
      });
    });
    
    // Add vacations
    vacations.forEach((vacation) => {
      allItems.push({
        type: 'vacation',
        id: vacation.id,
        startDate: vacation.start_date,
        endDate: vacation.end_date,
        label: vacation.description || 'Vacation',
        data: vacation,
      });
    });
    
    // Sort by start date
    allItems.sort((a, b) => a.startDate.localeCompare(b.startDate));
    
    // Assign stack positions (greedy algorithm)
    const stacks: Array<{ end: string; items: typeof allItems }> = [];
    
    allItems.forEach((item) => {
      // Find a stack where this item can fit (no overlap)
      let placed = false;
      for (const stack of stacks) {
        if (item.startDate > stack.end) {
          stack.end = item.endDate;
          stack.items.push(item);
          placed = true;
          break;
        }
      }
      
      if (!placed) {
        // Need new stack
        stacks.push({ end: item.endDate, items: [item] });
      }
    });
    
    // Calculate positions - bars are positioned from the top, leaving space for indicator at bottom
    const positioned: Array<{
      type: 'assignment' | 'vacation';
      id: number;
      left: number;
      width: number;
      top: number;
      label: string;
      allocation?: number;
      data: StaffAssignmentWithContext | Vacation;
    }> = [];
    
    stacks.forEach((stack, stackIndex) => {
      stack.items.forEach((item) => {
        const pos = calculateBarPosition(item.startDate, item.endDate, cells, cellWidth, viewMode);
        if (pos) {
          positioned.push({
            type: item.type,
            id: item.id,
            left: pos.left,
            width: pos.width,
            top: ROW_PADDING + stackIndex * (BAR_HEIGHT + BAR_GAP),
            label: item.label,
            allocation: item.allocation,
            data: item.data,
          });
        }
      });
    });
    
    return positioned;
  }, [assignments, vacations, cells, cellWidth, viewMode]);
  
  const handleBarClick = (bar: typeof stackedBars[0]) => {
    if (bar.type === 'vacation') {
      openVacationModal(bar.data as Vacation);
    }
    // For assignments, we could open an assignment modal in the future
  };
  
  // Calculate the top position for the indicator area (at the bottom of the row)
  const indicatorTop = rowHeight - INDICATOR_AREA_HEIGHT;
  
  return (
    <div className={styles.row} style={{ height: rowHeight }}>
      {/* Workload heatmap cells - only in the indicator area at bottom */}
      {showWorkloadHeatmap && workloadCells.map((workload, index) => {
        // Only render cells with actual workload or vacation (skip empty cells)
        if (workload.total === 0 && !workload.isOnVacation) return null;
        
        return (
          <div
            key={`workload-${index}`}
            className={`${styles.workloadCell} ${styles[workload.state]}`}
            style={{
              left: index * cellWidth,
              width: cellWidth,
              top: indicatorTop,
              height: INDICATOR_AREA_HEIGHT,
              ...getWorkloadBackground(workload),
            }}
            title={getWorkloadTooltip(workload)}
          >
            {/* Workload indicator badge */}
            <div className={`${styles.workloadIndicator} ${styles[workload.state]}`}>
              {workload.state === 'vacation' ? 'OFF' : 
               workload.state === 'conflict' ? '0%' :
               `${workload.total}%`}
            </div>
          </div>
        );
      })}
      
      {/* Stacked assignment/vacation bars - in the bars area above indicator */}
      {stackedBars.map((bar, index) => (
        <div
          key={`${bar.type}-${bar.id}-${index}`}
          className={`${styles.bar} ${bar.type === 'vacation' ? styles.vacationBar : styles.assignmentBar}`}
          style={{ 
            left: bar.left, 
            width: bar.width,
            top: bar.top,
            height: BAR_HEIGHT,
          }}
          title={bar.label}
          onClick={() => handleBarClick(bar)}
        >
          <span className={styles.barLabel}>{bar.label}</span>
        </div>
      ))}
    </div>
  );
}

// Vacation detail row (shown when staff is expanded)
interface VacationDetailRowProps {
  vacation: Vacation;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function VacationDetailRow({ vacation, cells, cellWidth, viewMode }: VacationDetailRowProps) {
  const pos = useMemo(() => 
    calculateBarPosition(vacation.start_date, vacation.end_date, cells, cellWidth, viewMode),
    [vacation, cells, cellWidth, viewMode]
  );
  
  if (!pos) return <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />;
  
  return (
    <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }}>
      <div
        className={`${styles.detailBar} ${styles.vacationDetailBar}`}
        style={{
          left: pos.left,
          width: pos.width,
          height: 20,
          top: 6,
        }}
        title={vacation.description || 'Vacation'}
      />
    </div>
  );
}

// Assignment detail row (shown when staff is expanded)
interface AssignmentDetailRowProps {
  assignment: StaffAssignmentWithContext;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function AssignmentDetailRow({ assignment, cells, cellWidth, viewMode }: AssignmentDetailRowProps) {
  const pos = useMemo(() => 
    calculateBarPosition(assignment.start_date, assignment.end_date, cells, cellWidth, viewMode),
    [assignment, cells, cellWidth, viewMode]
  );
  
  if (!pos) return <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />;
  
  return (
    <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }}>
      <div
        className={`${styles.detailBar} ${styles.assignmentDetailBar}`}
        style={{
          left: pos.left,
          width: pos.width,
          height: 20,
          top: 6,
        }}
        title={`${assignment.projectName} (${assignment.allocation}%)`}
      />
    </div>
  );
}

// Bank holidays timeline row
interface BankHolidaysTimelineRowProps {
  isExpanded: boolean;
  holidays: Array<{ id: number; name: string; date: string; end_date?: string | null; is_custom?: boolean }>;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function BankHolidaysTimelineRow({ isExpanded, holidays, cells, cellWidth, viewMode }: BankHolidaysTimelineRowProps) {
  const BASE_HEIGHT = 44;
  const currentUser = useAppStore((s) => s.currentUser);
  const canEdit = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  
  return (
    <div className={styles.bankHolidaysWrapper}>
      {/* Main bank holidays row */}
      <div className={styles.row} style={{ height: BASE_HEIGHT }} />
      
      {/* Expanded holiday rows */}
      {isExpanded && (
        <>
          {holidays.map((holiday) => {
            const pos = calculateBarPosition(holiday.date, holiday.end_date || holiday.date, cells, cellWidth, viewMode);
            
            return (
              <div key={holiday.id} className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }}>
                {pos && (
                  <div
                    className={`${styles.detailBar} ${styles.holidayDetailBar} ${holiday.is_custom ? styles.customHolidayBar : ''}`}
                    style={{
                      left: pos.left,
                      width: pos.width,
                      height: 20,
                      top: 6,
                    }}
                    title={holiday.name}
                  />
                )}
              </div>
            );
          })}
          
          {/* Empty row if no holidays */}
          {holidays.length === 0 && (
            <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />
          )}
          
          {/* Placeholder row for "Add custom holiday" button */}
          {canEdit && (
            <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />
          )}
        </>
      )}
    </div>
  );
}
