/**
 * Staff View
 * Shows all staff members with their assignments on a timeline
 * Uses the same structure as GanttContainer but organized by staff
 * Supports stacked bars for overlapping assignments
 * Expandable rows show vacations and assignments
 * 
 * Can be used standalone or embedded below Gantt chart with synchronized scrolling.
 */

import { useMemo, useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import { useScrollSync, useCtrlScrollZoom, useResourceDragDrop } from '@/hooks';
import { generateTimelineCells, generateTimelineHeaders } from '@/components/gantt/utils/timeline';
import { TimelineHeader } from '@/components/gantt/Timeline/TimelineHeader';
import { StaffTimelineBody } from './StaffTimelineBody';
import { BankHolidaysRow } from './BankHolidaysRow';
import { CompanyEventsRow } from './CompanyEventsRow';
import { deleteVacation, getVacations } from '@/api/endpoints/vacations';
import { useTimelineScrollSync } from '@/contexts/TimelineScrollContext';
import { parseRecurringPattern, getRecurringDaysDisplay } from '@/utils/recurringVacation';
import type { Project, Phase, Subphase, StaffAssignment } from '@/types';
import styles from './StaffView.module.css';

// Height constants matching Gantt rows
const BASE_ROW_HEIGHT = 44;  // Minimum row height
const DETAIL_ROW_HEIGHT = 32;
const BAR_HEIGHT = 14;  // Smaller bars to fit with indicator
const BAR_GAP = 2;
const ROW_PADDING = 4;  // Padding at top of row
const INDICATOR_AREA_HEIGHT = 18;  // Height for workload indicator at bottom

interface StaffViewProps {
  /** When true, hides the header and syncs scroll with parent Gantt */
  embedded?: boolean;
  /** Panel width when embedded (controlled by parent) */
  panelWidth?: number;
  /** Callback when panel width changes in embedded mode */
  onPanelWidthChange?: (width: number) => void;
  /** Height when embedded (controlled by parent resizer) */
  height?: number;
}

export function StaffView({ embedded = false, panelWidth, onPanelWidthChange, height }: StaffViewProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineBodyRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  
  // Refs for measuring actual row heights (keyed by staff ID)
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [measuredHeights, setMeasuredHeights] = useState<Map<number, number>>(new Map());
  
  // Local panel width state for standalone mode only
  const [localPanelWidth, setLocalPanelWidth] = useState(320);
  
  // Resizer width constant
  const RESIZER_WIDTH = 4;
  
  // Effective panel width: use prop in embedded mode, local state otherwise
  // When embedded, panelWidth includes the resizer width, so subtract it for the panel itself
  const effectivePanelWidth = embedded ? ((panelWidth || 324) - RESIZER_WIDTH) : localPanelWidth;
  
  const staff = useAppStore((s) => s.staff);
  const projects = useAppStore((s) => s.projects);
  const vacations = useAppStore((s) => s.vacations);
  const setVacations = useAppStore((s) => s.setVacations);
  const currentSite = useAppStore((s) => s.currentSite);
  const currentUser = useAppStore((s) => s.currentUser);
  const skills = useAppStore((s) => s.skills);
  const bankHolidayDates = useAppStore((s) => s.bankHolidayDates);
  const bankHolidays = useAppStore((s) => s.bankHolidays);
  const companyEventDates = useAppStore((s) => s.companyEventDates);
  const companyEvents = useAppStore((s) => s.companyEvents);
  const viewMode = useViewStore((s) => s.viewMode);
  const currentDate = useViewStore((s) => s.currentDate);
  const cellWidth = useViewStore((s) => s.cellWidth);
  
  const { openVacationModal } = useUIStore();
  const scrollToTodayTrigger = useUIStore((s) => s.scrollToTodayTrigger);
  
  // Drag and drop for staff assignment
  const { handleDragStart, handleDragEnd } = useResourceDragDrop();
  
  // Enable Ctrl+Scroll zoom (only when not embedded)
  useCtrlScrollZoom({ containerRef: timelineScrollRef, cellWidth, enabled: !embedded });
  
  // Register for scroll sync when embedded
  const { handleScroll: handleSyncScroll } = useTimelineScrollSync(
    'staff-view',
    timelineScrollRef,
    embedded
  );
  
  // Track expanded staff and bank holidays row
  const [expandedStaff, setExpandedStaff] = useState<Set<number>>(new Set());
  const [expandedBankHolidays, setExpandedBankHolidays] = useState(false);
  const [expandedCompanyEvents, setExpandedCompanyEvents] = useState(false);
  
  // Filter state
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [selectedSkills, setSelectedSkills] = useState<Set<number>>(new Set());
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  
  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<{
    vacationId: number;
    staffName: string;
    description: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Sync vertical scroll between panel and timeline body
  useScrollSync(panelRef, timelineBodyRef);
  
  // Get all staff for current site (unfiltered for role extraction)
  const allSiteStaff = useMemo(() => 
    staff.filter((s) => s.site_id === currentSite?.id && s.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [staff, currentSite]
  );
  
  // Extract unique roles from staff
  const staffRoles = useMemo(() => {
    const roles = new Set<string>();
    allSiteStaff.forEach((s) => {
      if (s.role) roles.add(s.role);
    });
    return Array.from(roles).sort((a, b) => a.localeCompare(b));
  }, [allSiteStaff]);
  
  // Filter staff based on selected roles and skills
  const siteStaff = useMemo(() => {
    let filtered = allSiteStaff;
    
    // Filter by role if any selected
    if (selectedRoles.size > 0) {
      filtered = filtered.filter((s) => s.role && selectedRoles.has(s.role));
    }
    
    // Filter by skill if any selected
    if (selectedSkills.size > 0) {
      filtered = filtered.filter((s) => 
        s.skills?.some((skill) => selectedSkills.has(skill.id))
      );
    }
    
    return filtered;
  }, [allSiteStaff, selectedRoles, selectedSkills]);
  
  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setIsFilterOpen(false);
      }
    };
    
    if (isFilterOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isFilterOpen]);
  
  // Toggle role selection
  const toggleRole = (role: string) => {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) {
        next.delete(role);
      } else {
        next.add(role);
      }
      return next;
    });
  };
  
  // Toggle skill selection
  const toggleSkill = (skillId: number) => {
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) {
        next.delete(skillId);
      } else {
        next.add(skillId);
      }
      return next;
    });
  };
  
  // Clear all filters
  const clearAllFilters = () => {
    setSelectedRoles(new Set());
    setSelectedSkills(new Set());
  };
  
  // Check if any filters are active
  const hasActiveFilters = selectedRoles.size > 0 || selectedSkills.size > 0;
  
  // Generate timeline data
  const cells = useMemo(() => 
    generateTimelineCells(currentDate, viewMode, bankHolidayDates, bankHolidays, companyEventDates, companyEvents),
    [currentDate, viewMode, bankHolidayDates, bankHolidays, companyEventDates, companyEvents]
  );
  const headers = useMemo(() => 
    generateTimelineHeaders(cells, viewMode),
    [cells, viewMode]
  );
  
  const totalWidth = cells.length * cellWidth;
  
  // Scroll to today when trigger changes (only when not embedded - Gantt handles this)
  useEffect(() => {
    if (embedded || !scrollToTodayTrigger || !timelineScrollRef.current) return;
    
    const todayIndex = cells.findIndex((cell) => cell.isToday);
    if (todayIndex === -1) return;
    
    const scrollContainer = timelineScrollRef.current;
    const containerWidth = scrollContainer.clientWidth;
    const todayPosition = todayIndex * cellWidth;
    
    // Center today in the viewport
    const scrollTo = Math.max(0, todayPosition - containerWidth / 2 + cellWidth / 2);
    scrollContainer.scrollTo({ left: scrollTo, behavior: 'smooth' });
  }, [embedded, scrollToTodayTrigger, cells, cellWidth]);
  
  // Build staff assignments map with stacking info
  const staffAssignmentsMap = useMemo(() => {
    const map = new Map<number, StaffAssignmentWithContext[]>();
    siteStaff.forEach((s) => map.set(s.id, []));
    
    let totalAssignments = 0;
    
    // Helper to recursively process subphases
    const processSubphases = (
      subphases: Subphase[] | undefined,
      project: Project,
      phase: Phase
    ) => {
      if (!subphases) return;
      
      for (const subphase of subphases) {
        // Process staff assignments on this subphase
        subphase.staffAssignments?.forEach((sa: StaffAssignment) => {
          totalAssignments++;
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
        
        // Recursively process nested subphases
        if (subphase.children?.length) {
          processSubphases(subphase.children, project, phase);
        }
      }
    };
    
    projects.forEach((project) => {
      if (project.archived) return;
      
      // Project-level staff assignments
      project.staffAssignments?.forEach((sa) => {
        totalAssignments++;
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
          totalAssignments++;
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
        
        // Recursively process all subphases (handles nested subphases)
        processSubphases(phase.children, project, phase);
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
  
  // Calculate minimum row heights based on stacked assignments (for timeline bars)
  const calculatedRowHeights = useMemo(() => {
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
  
  // Measure actual panel row heights after render (for text wrapping)
  useLayoutEffect(() => {
    // Small delay to ensure DOM is fully rendered
    const measureHeights = () => {
      const newMeasured = new Map<number, number>();
      let hasChanges = false;
      
      rowRefs.current.forEach((element, staffId) => {
        if (element) {
          const height = element.offsetHeight;
          newMeasured.set(staffId, height);
          if (measuredHeights.get(staffId) !== height) {
            hasChanges = true;
          }
        }
      });
      
      if (hasChanges || newMeasured.size !== measuredHeights.size) {
        setMeasuredHeights(newMeasured);
      }
    };
    
    // Use requestAnimationFrame to measure after paint
    const rafId = requestAnimationFrame(measureHeights);
    return () => cancelAnimationFrame(rafId);
  }, [siteStaff, localPanelWidth, panelWidth, measuredHeights]);
  
  // Combine calculated heights (for bars) with measured heights (for text wrapping)
  // Use the maximum of both to ensure both content types fit
  const rowHeights = useMemo(() => {
    const heights = new Map<number, number>();
    
    siteStaff.forEach((staffMember) => {
      const calculated = calculatedRowHeights.get(staffMember.id) || BASE_ROW_HEIGHT;
      const measured = measuredHeights.get(staffMember.id) || 0;
      // Use max of calculated (for bars) and measured (for text), with BASE_ROW_HEIGHT as minimum
      heights.set(staffMember.id, Math.max(BASE_ROW_HEIGHT, calculated, measured));
    });
    
    return heights;
  }, [siteStaff, calculatedRowHeights, measuredHeights]);
  
  // Ref callback to register row elements for measurement
  const setRowRef = useCallback((staffId: number) => (element: HTMLDivElement | null) => {
    if (element) {
      rowRefs.current.set(staffId, element);
    } else {
      rowRefs.current.delete(staffId);
    }
  }, []);
  
  // Helper to check if a date range includes today
  const isActiveToday = (startDate: string, endDate: string): boolean => {
    const today = new Date();
    today.setHours(12, 0, 0, 0); // Noon to avoid timezone issues
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    return today >= start && today <= end;
  };
  
  // Calculate availability for TODAY (matches ResourceCard logic)
  // Takes into account max_capacity for part-time workers
  const calcAvailability = (staffId: number): { available: number; maxCapacity: number } => {
    const staffMember = siteStaff.find(s => s.id === staffId) || allSiteStaff.find(s => s.id === staffId);
    const maxCapacity = staffMember?.max_capacity ?? 100;
    
    // Check if on vacation today
    const staffVacations = staffVacationsMap.get(staffId) || [];
    const onVacation = staffVacations.some(v => isActiveToday(v.start_date, v.end_date));
    if (onVacation) {
      return { available: 0, maxCapacity }; // No availability during vacation
    }
    
    const assignments = staffAssignmentsMap.get(staffId) || [];
    // Only sum allocations for assignments active TODAY
    const totalAllocation = assignments
      .filter(a => a.start_date && a.end_date && isActiveToday(a.start_date, a.end_date))
      .reduce((sum, a) => sum + (a.allocation || 0), 0);
    return { available: maxCapacity - totalAllocation, maxCapacity };
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
  
  // Check if user can drag staff to assign
  const canDrag = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  
  // Format date range for display using browser locale
  const formatDateRange = (start: string, end: string) => {
    const s = new Date(start);
    const e = new Date(end);
    const formatDate = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
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
  
  // Handle panel resize (horizontal - width)
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = effectivePanelWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.max(200, Math.min(500, startWidth + delta));
      
      if (embedded && onPanelWidthChange) {
        // In embedded mode, notify parent
        onPanelWidthChange(newWidth);
      } else {
        // In standalone mode, update local state
        setLocalPanelWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [embedded, effectivePanelWidth, onPanelWidthChange]);
  
  // Determine panel style - use effective width
  const panelStyle = { width: effectivePanelWidth };
  
  // Determine container style (height when embedded)
  const containerStyle = embedded && height ? { height } : undefined;
  
  // Count filter label
  const filterLabel = () => {
    const totalFilters = selectedRoles.size + selectedSkills.size;
    if (totalFilters === 0) return 'Filter';
    return `${totalFilters} filter${totalFilters > 1 ? 's' : ''}`;
  };
  
  return (
    <div 
      className={`${styles.container} ${embedded ? styles.embedded : ''}`}
      style={containerStyle}
    >
      {/* Left Panel - Staff List */}
      <div className={styles.panel} style={panelStyle}>
        <div className={styles.panelHeader}>
          <div className={styles.headerLeft}>
            <span className={styles.headerTitle}>Staff Overview</span>
            <span className={styles.headerCount}>{siteStaff.length}{hasActiveFilters ? `/${allSiteStaff.length}` : ''}</span>
          </div>
          
          {/* Filter Dropdown */}
          <div ref={filterRef} className={styles.filterWrapper}>
            <button 
              className={`${styles.filterTrigger} ${hasActiveFilters ? styles.hasFilters : ''}`}
              onClick={() => setIsFilterOpen(!isFilterOpen)}
              aria-expanded={isFilterOpen}
              aria-haspopup="true"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              <span className={styles.filterLabel}>{filterLabel()}</span>
              <svg
                className={`${styles.chevron} ${isFilterOpen ? styles.open : ''}`}
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            
            {isFilterOpen && (
              <div className={styles.filterDropdown}>
                {/* Clear all button */}
                {hasActiveFilters && (
                  <div className={styles.filterActions}>
                    <button className={styles.filterActionBtn} onClick={clearAllFilters}>
                      Clear all filters
                    </button>
                  </div>
                )}
                
                <div className={styles.filterColumns}>
                  {/* Role filters column */}
                  <div className={styles.filterColumn}>
                    <div className={styles.filterSectionTitle}>Roles</div>
                    <div className={styles.filterOptions}>
                      {staffRoles.length > 0 ? (
                        staffRoles.map((role) => (
                          <label key={role} className={styles.filterOption}>
                            <input
                              type="checkbox"
                              className={styles.filterCheckboxInput}
                              checked={selectedRoles.has(role)}
                              onChange={() => toggleRole(role)}
                            />
                            <span className={styles.filterCheckbox}>
                              <svg className={styles.checkIcon} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                            <span className={styles.filterOptionText}>{role}</span>
                          </label>
                        ))
                      ) : (
                        <div className={styles.filterEmptyColumn}>No roles defined</div>
                      )}
                    </div>
                  </div>
                  
                  {/* Skills filters column */}
                  <div className={styles.filterColumn}>
                    <div className={styles.filterSectionTitle}>Skills</div>
                    <div className={styles.filterOptions}>
                      {skills.length > 0 ? (
                        skills.map((skill) => (
                          <label key={skill.id} className={styles.filterOption}>
                            <input
                              type="checkbox"
                              className={styles.filterCheckboxInput}
                              checked={selectedSkills.has(skill.id)}
                              onChange={() => toggleSkill(skill.id)}
                            />
                            <span className={styles.filterCheckbox}>
                              <svg className={styles.checkIcon} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                            <span 
                              className={styles.filterOptionText}
                              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                            >
                              <span 
                                className={styles.skillDot} 
                                style={{ backgroundColor: skill.color }}
                              />
                              {skill.name}
                            </span>
                          </label>
                        ))
                      ) : (
                        <div className={styles.filterEmptyColumn}>No skills defined</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className={styles.panelBody} ref={panelRef}>
          {siteStaff.length === 0 ? (
            <div className={styles.empty}>
              <p>No staff found</p>
            </div>
          ) : (
            siteStaff.map((staffMember) => {
              const { available, maxCapacity } = calcAvailability(staffMember.id);
              const isPartTime = maxCapacity < 100;
              const rowHeight = rowHeights.get(staffMember.id) || BASE_ROW_HEIGHT;
              const isExpanded = expandedStaff.has(staffMember.id);
              const staffVacations = staffVacationsMap.get(staffMember.id) || [];
              const staffAssignments = staffAssignmentsMap.get(staffMember.id) || [];
              const canManage = canManageVacation(staffMember.id);
              
              return (
                <div key={staffMember.id} className={styles.staffWrapper}>
                  {/* Main staff row */}
                  <div 
                    ref={setRowRef(staffMember.id)}
                    className={`${styles.staffRow} ${canDrag ? styles.draggable : ''}`}
                    style={{ minHeight: rowHeight }}
                    onClick={() => toggleStaffExpand(staffMember.id)}
                    draggable={canDrag}
                    onDragStart={canDrag ? (e) => {
                      e.stopPropagation();
                      handleDragStart(e, 'staff', staffMember.id, staffMember.name);
                    } : undefined}
                    onDragEnd={canDrag ? handleDragEnd : undefined}
                  >
                    {canDrag && (
                      <div className={styles.dragHandle} title="Drag to assign">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="9" cy="5" r="2" />
                          <circle cx="9" cy="12" r="2" />
                          <circle cx="9" cy="19" r="2" />
                          <circle cx="15" cy="5" r="2" />
                          <circle cx="15" cy="12" r="2" />
                          <circle cx="15" cy="19" r="2" />
                        </svg>
                      </div>
                    )}
                    <div className={`${styles.expandIcon} ${isExpanded ? styles.expanded : ''}`}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </div>
                    <div 
                      className={`${styles.status} ${available > 0 ? styles.available : styles.overloaded} ${isPartTime ? styles.partTime : ''}`}
                      title={isPartTime ? `Part-time: Max ${maxCapacity}% capacity` : 'Full-time: 100% capacity'}
                    />
                    <div className={styles.staffInfo}>
                      <div className={styles.staffName}>
                        {staffMember.name}
                        {isPartTime && <span className={styles.partTimeBadge}>{maxCapacity}%</span>}
                      </div>
                      <div className={styles.staffMeta}>
                        <span>{staffMember.role || 'No title'}</span>
                        <span> · </span>
                        <span 
                          className={available <= 0 ? styles.overloadedText : ''}
                          title={isPartTime ? `${available}% of ${maxCapacity}% max capacity` : undefined}
                        >
                          {available}% available
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  {/* Expanded content - Vacations first, then assignments */}
                  {isExpanded && (
                    <div className={styles.expandedContent}>
                      {/* Vacation rows */}
                      {staffVacations.map((vacation) => {
                        const recurringPattern = parseRecurringPattern(vacation.description);
                        const displayDescription = recurringPattern 
                          ? recurringPattern.cleanDescription 
                          : (vacation.description || 'Time Off');
                        
                        return (
                          <div 
                            key={`v-${vacation.id}`}
                            className={`${styles.detailRow} ${canManage ? styles.clickable : ''} ${styles.vacationRow} ${recurringPattern ? styles.recurringRow : ''}`}
                            onClick={canManage ? () => openVacationModal(vacation, staffMember.id) : undefined}
                          >
                            <span className={`${styles.detailType} ${styles.vacation}`}>
                              {recurringPattern ? (
                                <span className={styles.recurringBadge} title={getRecurringDaysDisplay(recurringPattern.daysOfWeek)}>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M17 1l4 4-4 4" />
                                    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                                    <path d="M7 23l-4-4 4-4" />
                                    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                                  </svg>
                                  Recurring
                                </span>
                              ) : 'Vacation'}
                            </span>
                            <span className={styles.detailName}>
                              {displayDescription}
                              {recurringPattern && (
                                <span className={styles.recurringDays}>
                                  {getRecurringDaysDisplay(recurringPattern.daysOfWeek)}
                                </span>
                              )}
                            </span>
                            <span className={styles.dateBadge}>{formatDateRange(vacation.start_date, vacation.end_date)}</span>
                            {canManage && (
                              <span 
                                className={styles.deleteBtn}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteVacationRequest(
                                    vacation.id,
                                    staffMember.name,
                                    displayDescription
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
                        );
                      })}
                      
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
          
          {/* Bank Holidays Row - always show to maintain height sync with timeline */}
          <BankHolidaysRow
            isExpanded={embedded ? false : expandedBankHolidays}
            onToggle={embedded ? undefined : () => setExpandedBankHolidays(!expandedBankHolidays)}
          />
          
          {/* Company Events Row - always show to maintain height sync with timeline */}
          <CompanyEventsRow
            isExpanded={embedded ? false : expandedCompanyEvents}
            onToggle={embedded ? undefined : () => setExpandedCompanyEvents(!expandedCompanyEvents)}
          />
        </div>
      </div>
      
      {/* Resizer for panel width */}
      <div
        className={styles.resizer}
        onMouseDown={handleResizeStart}
      />
      
      {/* Right Side - Timeline */}
      <div className={styles.timeline}>
        {/* Purple header spacer in embedded mode - stays fixed above scroll */}
        {embedded && <div className={styles.timelineHeaderSpacer} />}
        
        <div 
          className={styles.timelineScroll} 
          ref={timelineScrollRef}
          onScroll={handleSyncScroll}
        >
          <div className={styles.timelineContent} style={{ width: totalWidth }}>
            {/* Full header when not embedded */}
            {!embedded && (
              <TimelineHeader
                headers={headers}
                cells={cells}
                cellWidth={cellWidth}
                totalWidth={totalWidth}
                viewMode={viewMode}
              />
            )}
            {/* StaffTimelineBody handles its own vertical scrolling */}
            <StaffTimelineBody
              ref={timelineBodyRef}
              staff={siteStaff}
              assignmentsMap={staffAssignmentsMap}
              vacationsMap={staffVacationsMap}
              rowHeights={rowHeights}
              expandedStaff={expandedStaff}
              expandedBankHolidays={embedded ? false : expandedBankHolidays}
              expandedCompanyEvents={embedded ? false : expandedCompanyEvents}
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
