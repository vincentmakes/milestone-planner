/**
 * StaffTimelineBody
 * Timeline body for staff view - shows stacked assignments and vacations
 * Uses same structure as TimelineBody from main Gantt
 * Supports expanded view with detail rows for vacations and assignments
 * Includes workload heatmap visualization per cell
 */

import { forwardRef, useMemo } from 'react';
import {
  useAppStore,
  selectStaffSiteIds,
  selectStaffTeamIds,
  selectTeamSiteById,
  selectAbsenceTypesById,
} from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useTeamFilteredCompanyEvents } from '@/hooks/useTeamFilter';
import { calculateBarPosition, calculateTodayPosition } from '@/components/gantt/utils';
import { TodayLine } from '@/components/gantt/Timeline/TodayLine';
import { useWorkloadCalculation, getWorkloadTooltip, getWorkloadBackground } from '@/hooks';
import {
  parseRecurringPattern,
  absenceTypeFor,
  absenceTypeName,
  absenceColorStyle,
  isUnavailableType,
  cleanVacationDescription,
} from '@/utils/recurringVacation';
import type { AbsenceTypesById } from '@/utils/recurringVacation';
import { getClosureOn } from '@/utils/siteClosure';
import type { ClosureIndex } from '@/utils/siteClosure';
import { BAR_HEIGHT, BAR_GAP, ROW_PADDING, DETAIL_ROW_HEIGHT, INDICATOR_AREA_HEIGHT } from './StaffView';
import type { TimelineCell } from '@/components/gantt/utils';
import type { Staff, Vacation, ViewMode } from '@/types';
import type { StaffAssignmentWithContext } from './StaffView';
import styles from './StaffTimelineBody.module.css';
import { can, canManageAbsencesOf } from '@/utils/permissions';
import { isPendingAssignment } from '@/utils/kanbanCards';

interface StaffTimelineBodyProps {
  staff: Staff[];
  assignmentsMap: Map<number, StaffAssignmentWithContext[]>;
  vacationsMap: Map<number, Vacation[]>;
  rowHeights: Map<number, number>;
  expandedStaff: Set<number>;
  expandedBankHolidays: boolean;
  expandedCompanyEvents: boolean;
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
    expandedCompanyEvents,
    cells, 
    cellWidth, 
    totalWidth,
    viewMode
  }, ref) {
    
    const bankHolidays = useAppStore((s) => s.bankHolidays);
    // Company events narrowed by the header team filter
    const { events: companyEvents } = useTeamFilteredCompanyEvents();
    const currentUser = useAppStore((s) => s.currentUser);
    const absenceTypesById = useAppStore(selectAbsenceTypesById);
    const showWeekends = useAppStore((s) => (s.instanceSettings?.show_weekends ?? 'true') !== 'false');
    // Site closures: staff whose sites intersect a closing event's sites are
    // off (only its teams' members there, when the event names teams)
    const closureIndex = useAppStore((s) => s.closureIndex);
    const staffSiteIds = useAppStore(selectStaffSiteIds);
    const staffTeamIds = useAppStore(selectStaffTeamIds);
    const teamSiteById = useAppStore(selectTeamSiteById);

    const showHighlighting = viewMode === 'week' || viewMode === 'month';
    const renderWeekendMarkers = showHighlighting && showWeekends;
    const renderWeekSeparators = showHighlighting && !showWeekends;
    
    // Calculate today line position
    const todayPosition = useMemo(
      () => calculateTodayPosition(cells, cellWidth),
      [cells, cellWidth]
    );
    
    // Check if user can add vacations for a staff member
    const canManageVacation = (staffId: number) => canManageAbsencesOf(currentUser, staffId);
    
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
            {renderWeekendMarkers && cells.map((cell, index) =>
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
            {showHighlighting && cells.map((cell, index) =>
              cell.isCompanyEvent ? (
                <div
                  key={`event-${index}`}
                  className={`${styles.gridCell} ${styles.companyEvent} ${cell.isSiteClosure ? styles.siteClosure : ''}`}
                  style={{
                    left: index * cellWidth,
                    width: cellWidth,
                    ...(cell.companyEventColor
                      ? ({ ['--event-color' as string]: cell.companyEventColor } as React.CSSProperties)
                      : {}),
                  }}
                />
              ) : null
            )}
            {renderWeekSeparators && cells.map((cell, index) =>
              cell.isFirstOfWeek && index > 0 ? (
                <div
                  key={`week-sep-${index}`}
                  className={styles.weekSeparator}
                  style={{ left: index * cellWidth }}
                />
              ) : null
            )}
          </div>
          
          {/* Today line */}
          {todayPosition !== null && (
            <TodayLine position={todayPosition} />
          )}
          
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
                    absenceTypesById={absenceTypesById}
                    closureIndex={closureIndex}
                    siteIds={staffSiteIds.get(staffMember.id)}
                    teamIds={staffTeamIds.get(staffMember.id)}
                    teamSiteById={teamSiteById}
                    rowHeight={rowHeights.get(staffMember.id) || 44}
                    cells={cells}
                    cellWidth={cellWidth}
                    viewMode={viewMode}
                    canManage={canManage}
                  />
                  
                  {/* Expanded detail rows */}
                  {isExpanded && (
                    <>
                      {/* Vacation detail rows */}
                      {staffVacations.map((vacation) => (
                        <VacationDetailRow
                          key={`v-${vacation.id}`}
                          vacation={vacation}
                          absenceTypesById={absenceTypesById}
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
            
            {/* Company events row */}
            <CompanyEventsTimelineRow
              isExpanded={expandedCompanyEvents}
              events={companyEvents}
              cells={cells}
              cellWidth={cellWidth}
              viewMode={viewMode}
            />
          </div>
          
          {/* Holiday and event tooltip layer - top strip only */}
          {showHighlighting && (
            <div className={styles.tooltipLayer}>
              {cells.map((cell, index) => {
                // Priority: bank holidays first, then company events
                if (cell.isBankHoliday) {
                  return (
                    <div
                      key={`tooltip-${index}`}
                      className={`${styles.tooltipCell} ${styles.holiday}`}
                      style={{ left: index * cellWidth, width: cellWidth }}
                      data-tooltip={cell.bankHolidayName || 'Holiday'}
                    />
                  );
                }
                if (cell.isCompanyEvent) {
                  return (
                    <div
                      key={`tooltip-${index}`}
                      className={`${styles.tooltipCell} ${styles.event}`}
                      style={{
                        left: index * cellWidth,
                        width: cellWidth,
                        ...(cell.companyEventColor
                          ? ({ ['--event-color' as string]: cell.companyEventColor } as React.CSSProperties)
                          : {}),
                      }}
                      data-tooltip={cell.isSiteClosure ? `Site closed: ${cell.companyEventName || 'Company Event'}` : (cell.companyEventName || 'Company Event')}
                    />
                  );
                }
                return null;
              })}
            </div>
          )}
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
  absenceTypesById: AbsenceTypesById;
  /** Day → site-closure events (from the store) */
  closureIndex: ClosureIndex;
  /** Every site of this person; falls back to the row's site when unknown */
  siteIds?: ReadonlySet<number>;
  /** Every team of this person; falls back to the row's teams when unknown */
  teamIds?: ReadonlySet<number>;
  /** Team id → site id (from the store), to place a closure's teams on a site */
  teamSiteById: ReadonlyMap<number, number>;
  rowHeight: number;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
  /**
   * Whether the viewer may edit this person's absences (their own, or
   * admin/superuser) -- the same rule as the left panel. Otherwise the
   * vacation bars are display-only.
   */
  canManage: boolean;
}

function StaffRow({ staffMember, assignments, vacations, absenceTypesById, closureIndex, siteIds, teamIds, teamSiteById, rowHeight, cells, cellWidth, viewMode, canManage }: StaffRowProps) {
  const { openVacationModal } = useUIStore();

  // Get max capacity for this staff member
  const maxCapacity = staffMember.max_capacity ?? 100;

  // Site closures for this person (undefined when no event closes a site)
  const closures = useMemo(() => {
    if (closureIndex.size === 0) return undefined;
    const sites = siteIds ?? new Set([staffMember.site_id]);
    const teams = teamIds ?? new Set(staffMember.team_ids ?? []);
    return (dateStr: string) => getClosureOn(sites, dateStr, closureIndex, teams, teamSiteById);
  }, [closureIndex, siteIds, teamIds, teamSiteById, staffMember.site_id, staffMember.team_ids]);

  // Calculate workload per cell
  const workloadCells = useWorkloadCalculation(assignments, vacations, cells, maxCapacity, absenceTypesById, closures);
  
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
      /** Vacations only: inline --absence-color and whether it blocks capacity */
      absenceStyle?: React.CSSProperties;
      available?: boolean;
      /** Assignments only: a booking awaiting approval */
      pending?: boolean;
      data: StaffAssignmentWithContext | Vacation;
    }> = [];
    
    // Add assignments
    assignments.forEach((assignment) => {
      let label = assignment.projectName;
      if (assignment.phaseName) {
        label += ` - ${assignment.phaseName}`;
      }
      label += ` (${assignment.allocation}%)`;
      // Shown dashed, but not counted until approved.
      const pending = isPendingAssignment(assignment);
      if (pending) label += ' — pending approval';
      
      allItems.push({
        type: 'assignment',
        id: assignment.id,
        startDate: assignment.start_date,
        endDate: assignment.end_date,
        label,
        allocation: assignment.allocation,
        pending,
        data: assignment,
      });
    });
    
    // Add vacations (skip recurring - they show as individual "OFF" indicators instead)
    vacations.forEach((vacation) => {
      // Skip recurring vacations - they're shown as individual day markers
      if (parseRecurringPattern(vacation.description)) {
        return;
      }
      
      const absenceType = absenceTypeFor(vacation, absenceTypesById);
      const typeName = absenceTypeName(absenceType);
      const description = cleanVacationDescription(vacation.description);
      allItems.push({
        type: 'vacation',
        id: vacation.id,
        startDate: vacation.start_date,
        endDate: vacation.end_date,
        label: absenceType && description && description !== typeName
          ? `${typeName}: ${description}`
          : description || typeName,
        absenceStyle: absenceColorStyle(absenceType),
        available: !isUnavailableType(absenceType),
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
      absenceStyle?: React.CSSProperties;
      available?: boolean;
      pending?: boolean;
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
            absenceStyle: item.absenceStyle,
            available: item.available,
            pending: item.pending,
            data: item.data,
          });
        }
      });
    });
    
    return positioned;
  }, [assignments, vacations, absenceTypesById, cells, cellWidth, viewMode]);
  
  const handleBarClick = (bar: typeof stackedBars[0]) => {
    if (bar.type === 'vacation' && canManage) {
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
        // Only render cells with workload or an absence (skip empty cells)
        if (workload.total === 0 && !workload.isOnVacation && !workload.hasAvailableAbsence) return null;
        
        return (
          <div
            key={`workload-${index}`}
            className={`${styles.workloadCell} ${styles[workload.state]} ${workload.hasAvailableAbsence ? styles.availableAbsence : ''}`}
            style={{
              left: index * cellWidth,
              width: cellWidth,
              top: indicatorTop,
              height: INDICATOR_AREA_HEIGHT,
              ...((workload.closureColor ?? workload.absenceColor)
                ? ({ ['--absence-color' as string]: workload.closureColor ?? workload.absenceColor } as React.CSSProperties)
                : {}),
              ...getWorkloadBackground(workload),
            }}
            title={getWorkloadTooltip(workload)}
          >
            {/* Workload indicator badge ("OFF" when an absence or a site closure makes them unavailable) */}
            {workload.state !== 'empty' && (
              <div className={`${styles.workloadIndicator} ${styles[workload.state]}`}>
                {workload.state === 'vacation' ? 'OFF' : 
                 workload.state === 'conflict' ? '0%' :
                 `${workload.total}%`}
              </div>
            )}
          </div>
        );
      })}
      
      {/* Stacked assignment/vacation bars - in the bars area above indicator */}
      {stackedBars.map((bar, index) => (
        <div
          key={`${bar.type}-${bar.id}-${index}`}
          className={`${styles.bar} ${bar.type === 'vacation' ? styles.vacationBar : styles.assignmentBar} ${bar.available ? styles.availableAbsenceBar : ''} ${bar.pending ? styles.pendingBar : ''}`}
          style={{ 
            ...bar.absenceStyle,
            left: bar.left, 
            width: bar.width,
            top: bar.top,
            height: BAR_HEIGHT,
            ...(bar.type === 'vacation' && !canManage ? { cursor: 'default' } : {}),
          }}
          title={bar.label}
          data-testid={`staff-bar-${bar.type}-${bar.id}`}
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
  absenceTypesById: AbsenceTypesById;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function VacationDetailRow({ vacation, absenceTypesById, cells, cellWidth, viewMode }: VacationDetailRowProps) {
  const pos = useMemo(() => 
    calculateBarPosition(vacation.start_date, vacation.end_date, cells, cellWidth, viewMode),
    [vacation, cells, cellWidth, viewMode]
  );
  
  if (!pos) return <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />;

  const absenceType = absenceTypeFor(vacation, absenceTypesById);
  const typeName = absenceTypeName(absenceType);
  const description = cleanVacationDescription(vacation.description);
  
  return (
    <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }}>
      <div
        className={`${styles.detailBar} ${styles.vacationDetailBar} ${isUnavailableType(absenceType) ? '' : styles.availableAbsenceBar}`}
        style={{
          ...absenceColorStyle(absenceType),
          left: pos.left,
          width: pos.width,
          height: 20,
          top: 6,
        }}
        title={absenceType && description && description !== typeName ? `${typeName}: ${description}` : description || typeName}
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
  const canEdit = useAppStore((s) => can(s.currentUser, 'bank_holidays.manage'));
  
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

// Company events timeline row
interface CompanyEventsTimelineRowProps {
  isExpanded: boolean;
  events: Array<{ id: number; name: string; date: string; end_date?: string | null; color?: string | null }>;
  cells: TimelineCell[];
  cellWidth: number;
  viewMode: ViewMode;
}

function CompanyEventsTimelineRow({ isExpanded, events, cells, cellWidth, viewMode }: CompanyEventsTimelineRowProps) {
  const BASE_HEIGHT = 44;
  const canEdit = useAppStore((s) => can(s.currentUser, 'company_events.manage'));

  return (
    <div className={styles.companyEventsWrapper}>
      {/* Main company events row */}
      <div className={styles.row} style={{ height: BASE_HEIGHT }} />

      {/* Expanded event rows */}
      {isExpanded && (
        <>
          {events.map((event) => {
            const pos = calculateBarPosition(event.date, event.end_date || event.date, cells, cellWidth, viewMode);

            return (
              <div key={event.id} className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }}>
                {pos && (
                  <div
                    className={`${styles.detailBar} ${styles.eventDetailBar}`}
                    style={{
                      left: pos.left,
                      width: pos.width,
                      height: 20,
                      top: 6,
                      ...(event.color ? { background: event.color } : {}),
                    }}
                    title={event.name}
                  />
                )}
              </div>
            );
          })}
          
          {/* Empty row if no events */}
          {events.length === 0 && (
            <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />
          )}
          
          {/* Placeholder row for "Add event" button */}
          {canEdit && (
            <div className={styles.row} style={{ height: DETAIL_ROW_HEIGHT }} />
          )}
        </>
      )}
    </div>
  );
}
