import type { Staff, Equipment, ResourceTab, Project, Vacation } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { useResourceDragDrop } from '@/hooks/useResourceDragDrop';
import { useEquipmentOverlaps, useEquipmentTodayStatus } from '@/hooks/useEquipmentOverlaps';
import { OverlapWarningIcon } from '@/components/common/OverlapWarningIcon';
import { isUnavailableOn } from '@/utils/recurringVacation';
import type { AbsenceTypesById } from '@/utils/recurringVacation';
import { EMPTY_TEAM_SET, getClosureOn } from '@/utils/siteClosure';
import type { ClosureIndex } from '@/utils/siteClosure';
import {
  selectStaffSiteIds,
  selectStaffTeamIds,
  selectTeamSiteById,
  selectAbsenceTypesById,
} from '@/stores/appStore';
import { formatDateISO, parseLocalDate } from '@/utils/date';
import { canBookSelf, canManageAnyProject } from '@/utils/permissions';
import { isPendingAssignment } from '@/utils/kanbanCards';
import styles from './ResourceCard.module.css';
import { bookingSpan } from '@/utils/bookingSegments';

interface ResourceCardProps {
  resource: Staff | Equipment;
  type: ResourceTab;
  projects: Project[];
}

// Helper to check if a date range contains the current date
function isActiveToday(startDate: string, endDate: string, today: Date): boolean {
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  // Set times to compare dates only
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return start <= today && end >= today;
}

// Helper to calculate staff allocation for TODAY from projects (bookings
// awaiting approval book nothing yet)
function calculateStaffAllocationToday(
  projects: Project[],
  staffId: number,
  vacations: Vacation[],
  absenceTypesById: AbsenceTypesById,
  staffSiteIds: ReadonlySet<number>,
  closureIndex: ClosureIndex,
  staffTeamIds: ReadonlySet<number>,
  teamSiteById: ReadonlyMap<number, number>
): number {
  const today = new Date();
  today.setHours(12, 0, 0, 0); // Noon to avoid timezone issues
  const todayStr = formatDateISO(today);

  // Unavailable today? Recurring patterns are honoured, and absence types that
  // don't count as unavailable (Home Office) leave the allocation untouched.
  if (isUnavailableOn(staffId, todayStr, vacations, absenceTypesById)) {
    return 100; // Fully allocated (no availability) during the absence
  }
  // A company event closing one of their sites today (for everyone there, or
  // for one of their teams) also takes them off
  if (getClosureOn(staffSiteIds, todayStr, closureIndex, staffTeamIds, teamSiteById)) {
    return 100;
  }
  
  let total = 0;
  
  for (const project of projects) {
    // Project-level assignments - check if assignment dates contain today
    for (const assignment of project.staffAssignments || []) {
      if (assignment.staff_id === staffId && !isPendingAssignment(assignment) &&
          isActiveToday(assignment.start_date, assignment.end_date, today)) {
        total += assignment.allocation || 0;
      }
    }
    
    // Phase-level assignments - check if the booking's effective dates (own
    // when unlinked, else the phase's) contain today
    for (const phase of project.phases || []) {
      for (const assignment of phase.staffAssignments || []) {
        if (assignment.staff_id === staffId && !isPendingAssignment(assignment) &&
            isActiveToday(bookingSpan(assignment, phase).start, bookingSpan(assignment, phase).end, today)) {
          total += assignment.allocation || 0;
        }
      }
      
      // Subphase-level assignments (recursive)
      const processSubphases = (subphases: typeof phase.children) => {
        for (const subphase of subphases || []) {
          for (const assignment of subphase.staffAssignments || []) {
            if (assignment.staff_id === staffId && !isPendingAssignment(assignment) &&
                isActiveToday(bookingSpan(assignment, subphase).start, bookingSpan(assignment, subphase).end, today)) {
              total += assignment.allocation || 0;
            }
          }
          if (subphase.children) {
            processSubphases(subphase.children);
          }
        }
      };
      processSubphases(phase.children);
    }
  }
  
  return total;
}

export function ResourceCard({ resource, type, projects }: ResourceCardProps) {
  // Get vacations from store for vacation checking
  const vacations = useAppStore((s) => s.vacations);
  const absenceTypesById = useAppStore(selectAbsenceTypesById);
  const closureIndex = useAppStore((s) => s.closureIndex);
  const staffSiteIds = useAppStore(selectStaffSiteIds);
  const staffTeamIds = useAppStore(selectStaffTeamIds);
  const teamSiteById = useAppStore(selectTeamSiteById);
  const currentUser = useAppStore((s) => s.currentUser);
  const { handleDragStart, handleDragEnd } = useResourceDragDrop();
  const overlapMap = useEquipmentOverlaps();
  const todayStatusMap = useEquipmentTodayStatus();
  const hasEquipmentConflict = type === 'equipment' && overlapMap.get(resource.id)?.hasOverlap === true;

  // Calculate allocation for TODAY.
  // For equipment, both bookings and active blocks count as "in use" (100%).
  // Staff listed under the current site: their closure check uses every site
  // they belong to (a closure on any of them takes them off).
  const allocation = type === 'staff'
    ? calculateStaffAllocationToday(
        projects,
        resource.id,
        vacations,
        absenceTypesById,
        staffSiteIds.get(resource.id) ?? new Set([resource.site_id]),
        closureIndex,
        staffTeamIds.get(resource.id) ?? EMPTY_TEAM_SET,
        teamSiteById
      )
    : todayStatusMap.get(resource.id) ? 100 : 0;
  
  const available = 100 - allocation;

  const isStaff = type === 'staff';
  const staffResource = resource as Staff;
  const equipmentResource = resource as Equipment;
  
  // Get max capacity (only for staff, equipment is always 100%)
  const maxCapacity = isStaff ? (staffResource.max_capacity ?? 100) : 100;

  // Anyone who manages a project here may drag resources onto it; everyone
  // may drag their own card to book themselves.
  const canDrag =
    canManageAnyProject(currentUser, projects) || (isStaff && canBookSelf(currentUser, resource.id));

  // Color based on allocation vs max capacity:
  // - Below capacity: green
  // - At capacity: blue  
  // - Above capacity: red
  const getAvailabilityColor = () => {
    if (allocation > maxCapacity) return 'var(--accent-red)';
    if (allocation === maxCapacity) return 'var(--accent-blue)';
    return 'var(--accent-green)';
  };

  const onDragStart = (e: React.DragEvent) => {
    handleDragStart(e, type, resource.id, resource.name);
  };

  return (
    <div 
      className={`${styles.card} ${canDrag ? styles.draggable : ''}`}
      draggable={canDrag}
      onDragStart={canDrag ? onDragStart : undefined}
      onDragEnd={canDrag ? handleDragEnd : undefined}
    >
      <div className={styles.info}>
        <span className={styles.name}>
          {resource.name}
          {hasEquipmentConflict && (
            <OverlapWarningIcon
              size={12}
              title="This equipment has overlapping bookings or blocks"
            />
          )}
        </span>
        <span className={styles.detail}>
          {isStaff ? staffResource.role || 'No role' : equipmentResource.type || 'No type'}
        </span>
      </div>
      <div className={styles.availability}>
        <div className={styles.bar}>
          <div
            className={styles.fill}
            style={{
              width: `${Math.max(0, Math.min(100, available))}%`,
              backgroundColor: getAvailabilityColor(),
            }}
          />
        </div>
        <span
          className={styles.percent}
          style={{ color: getAvailabilityColor() }}
        >
          {available}%
        </span>
      </div>
    </div>
  );
}
