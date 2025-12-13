/**
 * Staff View
 * Shows all staff members with their assignments on a timeline
 * Uses the same structure as GanttContainer but organized by staff
 * Supports stacked bars for overlapping assignments
 * Expandable rows show vacations and assignments
 */

import { useMemo, useRef, useState, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import { useScrollSync } from '@/hooks';
import { generateTimelineCells, generateTimelineHeaders } from '@/components/gantt/utils/timeline';
import { TimelineHeader } from '@/components/gantt/Timeline/TimelineHeader';
import { StaffTimelineBody } from './StaffTimelineBody';
import { BankHolidaysRow } from './BankHolidaysRow';
import { deleteVacation, getVacations } from '@/api/endpoints/vacations';
import styles from './StaffView.module.css';

// Height constants matching Gantt rows
const BASE_ROW_HEIGHT = 44;
const DETAIL_ROW_HEIGHT = 32;
const BAR_HEIGHT = 14;  // Smaller bars to fit with indicator
const BAR_GAP = 2;
const ROW_PADDING = 4;  // Padding at top of row
const INDICATOR_AREA_HEIGHT = 18;  // Height for workload indicator at bottom

export function StaffView() {
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  
  const staff = useAppStore((s) => s.staff);
  const projects = useAppStore((s) => s.projects);
  const vacations = useAppStore((s) => s.vacations);
  const setVacations = useAppStore((s) => s.setVacations);
  const currentSite = useAppStore((s) => s.currentSite);
  const currentUser = useAppStore((s) => s.currentUser);
  const viewMode = useAppStore((s) => s.viewMode);
  const currentDate = useAppStore((s) => s.currentDate);
  const cellWidth = useAppStore((s) => s.cellWidth);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  
  const { openVacationModal } = useUIStore();
  
  // Track expanded staff and bank holidays row
  const [expandedStaff, setExpandedStaff] = useState<Set<number>>(new Set());
  const [expandedBankHolidays, setExpandedBankHolidays] = useState(false);
  
  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<{
    vacationId: number;
    staffName: string;
    description: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Sync vertical scroll between panel and timeline body
  useScrollSync(panelRef, timelineBodyRef);
  
  // Filter staff for current site
  const siteStaff = useMemo(() => 
    staff.filter((s) => s.site_id === currentSite?.id && s.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [staff, currentSite]
  );
  
  // Generate timeline data
  const cells = useMemo(() => 
    generateTimelineCells(currentDate, viewMode, bankHolidayDates, bankHolidays),
    [currentDate, viewMode, bankHolidayDates, bankHolidays]
  );
  const headers = useMemo(() => 
    generateTimelineHeaders(cells, viewMode),
    [cells, viewMode]
  );
  
  const totalWidth = cells.length * cellWidth;
  
  // Build staff assignments map with stacking info
  const staffAssignmentsMap = useMemo(() => {
    const map = new Map<number, StaffAssignmentWithContext[]>();
    siteStaff.forEach((s) => map.set(s.id, []));
    
    projects.forEach((project) => {
      if (project.archived) return;
      
      // Project-level staff assignments
      project.staffAssignments?.forEach((sa) => {
        const existing = map.get(sa.staff_id) || [];
        existing.push({
          ...sa,
          projectName: project.name,
          projectId: project.id,
          level: 'project',
        });
        map.set(sa.staff_id, existing);
      });
      
      // Phase-level staff assignments
      project.phases?.forEach((phase) => {
        phase.staffAssignments?.forEach((sa) => {
          const existing = map.get(sa.staff_id) || [];
          existing.push({
            ...sa,
            start_date: sa.start_date || phase.start_date,
            end_date: sa.end_date || phase.end_date,
            projectName: project.name,
            projectId: project.id,
            phaseName: phase.name,
            phaseId: phase.id,
            level: 'phase',
          });
          map.set(sa.staff_id, existing);
        });
        
        // Subphase-level staff assignments
        phase.children?.forEach((subphase) => {
          subphase.staffAssignments?.forEach((sa) => {
            const existing = map.get(sa.staff_id) || [];
            existing.push({
              ...sa,
              start_date: sa.start_date || subphase.start_date,
              end_date: sa.end_date || subphase.end_date,
              projectName: project.name,
              projectId: project.id,
              phaseName: phase.name,
              phaseId: phase.id,
              subphaseName: subphase.name,
              subphaseId: subphase.id,
              level: 'subphase',
            });
            map.set(sa.staff_id, existing);
          });
        });
      });
    });
    
    return map;
  }, [projects, siteStaff]);
  
  // Build vacations map
  const staffVacationsMap = useMemo(() => {
    const map = new Map<number, typeof vacations>();
    siteStaff.forEach((s) => map.set(s.id, []));
    
    vacations.forEach((v) => {
      const existing = map.get(v.staff_id) || [];
      existing.push(v);
      map.set(v.staff_id, existing);
    });
    
    return map;
  }, [vacations, siteStaff]);
  
  // Calculate row heights based on stacked assignments
  const rowHeights = useMemo(() => {
    const heights = new Map<number, number>();
    
    siteStaff.forEach((staffMember) => {
      const assignments = staffAssignmentsMap.get(staffMember.id) || [];
      const vacas = staffVacationsMap.get(staffMember.id) || [];
      
      // Calculate max overlapping bars at any point in time
      const maxStack = calculateMaxStack(assignments, vacas);
      
      // Height = padding + bars area + indicator area
      // bars area = (bar_height + gap) * num_bars
      // indicator area = space for the workload indicator at bottom
      const barsHeight = maxStack > 0 
        ? ROW_PADDING + (BAR_HEIGHT + BAR_GAP) * maxStack
        : 0;
      const height = barsHeight + INDICATOR_AREA_HEIGHT + ROW_PADDING;
      
      heights.set(staffMember.id, Math.max(BASE_ROW_HEIGHT, height));
    });
    
    return heights;
  }, [siteStaff, staffAssignmentsMap, staffVacationsMap]);
  
  // Calculate availability
  const calcAvailability = (staffId: number): number => {
    const assignments = staffAssignmentsMap.get(staffId) || [];
    const totalAllocation = assignments.reduce((sum, a) => sum + (a.allocation || 0), 0);
    return 100 - totalAllocation;
  };
  
  // Toggle staff expansion
  const toggleStaffExpand = useCallback((staffId: number) => {
    setExpandedStaff((prev) => {
      const next = new Set(prev);
      if (next.has(staffId)) {
        next.delete(staffId);
      } else {
        next.add(staffId);
      }
      return next;
    });
  }, []);
  
  // Check if user can manage vacation for a staff member
  const canManageVacation = useCallback((staffId: number) => {
    if (!currentUser) return false;
    if (currentUser.role === 'admin' || currentUser.role === 'superuser') return true;
    // Regular users can manage their own vacations
    return currentUser.id === staffId;
  }, [currentUser]);
  
  // Format date range for display
  const formatDateRange = (start: string, end: string) => {
    const s = new Date(start);
    const e = new Date(end);
    const formatDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    if (start === end) return formatDate(s);
    return `${formatDate(s)} - ${formatDate(e)}`;
  };
  
  // Handle vacation delete request (show confirmation)
  const handleDeleteVacationRequest = useCallback((
    vacationId: number,
    staffName: string,
    description: string
  ) => {
    setDeleteConfirm({ vacationId, staffName, description });
  }, []);
  
  // Confirm and execute vacation delete
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    
    setIsDeleting(true);
    try {
      await deleteVacation(deleteConfirm.vacationId);
      const updatedVacations = await getVacations();
      setVacations(updatedVacations);
      setDeleteConfirm(null);
    } catch (err) {
      console.error('Failed to delete vacation:', err);
      // Could add error toast here
    } finally {
      setIsDeleting(false);
    }
  }, [deleteConfirm, setVacations]);
  
  // Cancel delete
  const handleCancelDelete = useCallback(() => {
    setDeleteConfirm(null);
  }, []);
  
  return (
    <div className={styles.container}>
      {/* Left Panel - Staff List */}
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.headerLeft}>
            <span className={styles.headerTitle}>Staff</span>
            <span className={styles.headerCount}>{siteStaff.length}</span>
          </div>
        </div>
        <div className={styles.panelBody} ref={panelRef}>
          {siteStaff.length === 0 ? (
            <div className={styles.empty}>
              <p>No staff found</p>
            </div>
          ) : (
            siteStaff.map((staffMember) => {
              const availability = calcAvailability(staffMember.id);
              const rowHeight = rowHeights.get(staffMember.id) || BASE_ROW_HEIGHT;
              const isExpanded = expandedStaff.has(staffMember.id);
              const staffVacations = staffVacationsMap.get(staffMember.id) || [];
              const staffAssignments = staffAssignmentsMap.get(staffMember.id) || [];
              const canManage = canManageVacation(staffMember.id);
              
              return (
                <div key={staffMember.id} className={styles.staffWrapper}>
                  {/* Main staff row */}
                  <div 
                    className={styles.staffRow}
                    style={{ height: rowHeight }}
                    onClick={() => toggleStaffExpand(staffMember.id)}
                  >
                    <div className={`${styles.expandIcon} ${isExpanded ? styles.expanded : ''}`}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </div>
                    <div className={`${styles.status} ${availability > 0 ? styles.available : styles.overloaded}`} />
                    <div className={styles.staffInfo}>
                      <div className={styles.staffName}>{staffMember.name}</div>
                      <div className={styles.staffMeta}>
                        <span>{staffMember.role || 'No title'}</span>
                        <span> · </span>
                        <span className={availability <= 0 ? styles.overloadedText : ''}>
                          {availability}% available
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  {/* Expanded content - Vacations first, then assignments */}
                  {isExpanded && (
                    <div className={styles.expandedContent}>
                      {/* Vacation rows */}
                      {staffVacations.map((vacation) => (
                        <div 
                          key={`v-${vacation.id}`}
                          className={`${styles.detailRow} ${canManage ? styles.clickable : ''} ${styles.vacationRow}`}
                          onClick={canManage ? () => openVacationModal(vacation, staffMember.id) : undefined}
                        >
                          <span className={`${styles.detailType} ${styles.vacation}`}>Vacation</span>
                          <span className={styles.detailName}>{vacation.description || 'Time Off'}</span>
                          <span className={styles.dateBadge}>{formatDateRange(vacation.start_date, vacation.end_date)}</span>
                          {canManage && (
                            <span 
                              className={styles.deleteBtn}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteVacationRequest(
                                  vacation.id,
                                  staffMember.name,
                                  vacation.description || 'Time Off'
                                );
                              }}
                              title="Delete vacation"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </span>
                          )}
                        </div>
                      ))}
                      
                      {/* Add vacation placeholder */}
                      {canManage && (
                        <div 
                          className={`${styles.detailRow} ${styles.addRow}`}
                          onClick={() => openVacationModal(undefined, staffMember.id)}
                        >
                          <span className={styles.addIcon}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                          </span>
                          <span className={styles.addText}>Add vacation / time off</span>
                        </div>
                      )}
                      
                      {/* Assignment rows */}
                      {staffAssignments.map((assignment) => (
                        <div 
                          key={`a-${assignment.id}-${assignment.level}`}
                          className={`${styles.detailRow} ${styles.clickable}`}
                        >
                          <span className={`${styles.detailType} ${styles.allocation}`}>{assignment.allocation}%</span>
                          <span className={styles.detailName}>
                            {assignment.projectName}
                            {assignment.phaseName && ` › ${assignment.phaseName}`}
                          </span>
                          <span className={styles.dateBadge}>
                            {formatDateRange(assignment.start_date, assignment.end_date)}
                          </span>
                        </div>
                      ))}
                      
                      {staffAssignments.length === 0 && staffVacations.length === 0 && !canManage && (
                        <div className={styles.detailRow}>
                          <span className={styles.noAssignments}>No assignments</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
          
          {/* Bank Holidays Row */}
          <BankHolidaysRow
            isExpanded={expandedBankHolidays}
            onToggle={() => setExpandedBankHolidays(!expandedBankHolidays)}
          />
        </div>
      </div>
      
      {/* Right Side - Timeline */}
      <div className={styles.timeline}>
        <div className={styles.timelineScroll}>
          <div className={styles.timelineContent} style={{ width: totalWidth }}>
            <TimelineHeader
              headers={headers}
              cells={cells}
              cellWidth={cellWidth}
              totalWidth={totalWidth}
              viewMode={viewMode}
            />
            <StaffTimelineBody
              ref={timelineBodyRef}
              staff={siteStaff}
              assignmentsMap={staffAssignmentsMap}
              vacationsMap={staffVacationsMap}
              rowHeights={rowHeights}
              expandedStaff={expandedStaff}
              expandedBankHolidays={expandedBankHolidays}
              cells={cells}
              cellWidth={cellWidth}
              totalWidth={totalWidth}
              viewMode={viewMode}
            />
          </div>
        </div>
      </div>
      
      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className={styles.confirmOverlay} onClick={handleCancelDelete}>
          <div className={styles.confirmModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.confirmIcon}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </div>
            <h3 className={styles.confirmTitle}>Delete Vacation</h3>
            <p className={styles.confirmText}>
              Are you sure you want to delete <strong>{deleteConfirm.description}</strong> for <strong>{deleteConfirm.staffName}</strong>?
            </p>
            <p className={styles.confirmWarning}>This action cannot be undone.</p>
            <div className={styles.confirmActions}>
              <button 
                className={styles.confirmCancel}
                onClick={handleCancelDelete}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button 
                className={styles.confirmDelete}
                onClick={handleConfirmDelete}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Helper function to calculate max overlapping bars
function calculateMaxStack(
  assignments: StaffAssignmentWithContext[], 
  vacations: { start_date: string; end_date: string }[]
): number {
  if (assignments.length === 0 && vacations.length === 0) return 0;
  
  // Collect all date ranges
  const ranges = [
    ...assignments.map((a) => ({ start: a.start_date, end: a.end_date })),
    ...vacations.map((v) => ({ start: v.start_date, end: v.end_date })),
  ];
  
  if (ranges.length === 0) return 0;
  
  // Simple greedy algorithm: count maximum concurrent ranges at any point
  const events: Array<{ date: string; type: 'start' | 'end' }> = [];
  
  ranges.forEach((r) => {
    if (r.start && r.end) {
      events.push({ date: r.start, type: 'start' });
      events.push({ date: r.end, type: 'end' });
    }
  });
  
  // Sort by date, with starts before ends on same day
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.type === 'start' ? -1 : 1;
  });
  
  let maxConcurrent = 0;
  let current = 0;
  
  events.forEach((event) => {
    if (event.type === 'start') {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
    } else {
      current--;
    }
  });
  
  return maxConcurrent;
}

// Types
interface StaffAssignmentWithContext {
  id: number;
  staff_id: number;
  allocation: number;
  start_date: string;
  end_date: string;
  projectName: string;
  projectId: number;
  phaseName?: string;
  phaseId?: number;
  subphaseName?: string;
  subphaseId?: number;
  level: 'project' | 'phase' | 'subphase';
}

export type { StaffAssignmentWithContext };
export { BASE_ROW_HEIGHT, DETAIL_ROW_HEIGHT, BAR_HEIGHT, BAR_GAP, ROW_PADDING, INDICATOR_AREA_HEIGHT };
