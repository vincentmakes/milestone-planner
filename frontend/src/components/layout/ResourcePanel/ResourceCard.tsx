import type { Staff, Equipment, ResourceTab, Project, Vacation } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { useResourceDragDrop } from '@/hooks/useResourceDragDrop';
import { useEquipmentOverlaps, useEquipmentTodayStatus } from '@/hooks/useEquipmentOverlaps';
import { OverlapWarningIcon } from '@/components/common/OverlapWarningIcon';
import styles from './ResourceCard.module.css';

interface ResourceCardProps {
  resource: Staff | Equipment;
  type: ResourceTab;
  projects: Project[];
}

// Helper to check if a date range contains the current date
function isActiveToday(startDate: string, endDate: string, today: Date): boolean {
  const start = new Date(startDate);
  const end = new Date(endDate);
  // Set times to compare dates only
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return start <= today && end >= today;
}

// Helper to calculate staff allocation for TODAY from projects
function calculateStaffAllocationToday(
  projects: Project[], 
  staffId: number, 
  vacations: Vacation[]
): number {
  const today = new Date();
  today.setHours(12, 0, 0, 0); // Noon to avoid timezone issues
  
  // Check if currently on vacation
  const onVacation = vacations.some(v => {
    if (v.staff_id !== staffId) return false;
    return isActiveToday(v.start_date, v.end_date, today);
  });
  
  if (onVacation) {
    return 100; // Fully allocated (no availability) during vacation
  }
  
  let total = 0;
  
  for (const project of projects) {
    // Project-level assignments - check if assignment dates contain today
    for (const assignment of project.staffAssignments || []) {
      if (assignment.staff_id === staffId && 
          isActiveToday(assignment.start_date, assignment.end_date, today)) {
        total += assignment.allocation || 0;
      }
    }
    
    // Phase-level assignments - check if phase dates contain today
    for (const phase of project.phases || []) {
      for (const assignment of phase.staffAssignments || []) {
        if (assignment.staff_id === staffId &&
            isActiveToday(phase.start_date, phase.end_date, today)) {
          total += assignment.allocation || 0;
        }
      }
      
      // Subphase-level assignments (recursive)
      const processSubphases = (subphases: typeof phase.children) => {
        for (const subphase of subphases || []) {
          for (const assignment of subphase.staffAssignments || []) {
            if (assignment.staff_id === staffId &&
                isActiveToday(subphase.start_date, subphase.end_date, today)) {
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
  const currentUser = useAppStore((s) => s.currentUser);
  const { handleDragStart, handleDragEnd } = useResourceDragDrop();
  const overlapMap = useEquipmentOverlaps();
  const todayStatusMap = useEquipmentTodayStatus();
  const hasEquipmentConflict = type === 'equipment' && overlapMap.get(resource.id)?.hasOverlap === true;
  
  // Calculate allocation for TODAY.
  // For equipment, both bookings and active blocks count as "in use" (100%).
  const allocation = type === 'staff'
    ? calculateStaffAllocationToday(projects, resource.id, vacations)
    : todayStatusMap.get(resource.id) ? 100 : 0;
  
  const available = 100 - allocation;

  const isStaff = type === 'staff';
  const staffResource = resource as Staff;
  const equipmentResource = resource as Equipment;
  
  // Get max capacity (only for staff, equipment is always 100%)
  const maxCapacity = isStaff ? (staffResource.max_capacity ?? 100) : 100;

  // Check if user can drag (superuser or admin)
  const canDrag = Boolean(currentUser && (currentUser.role === 'superuser' || currentUser.role === 'admin'));

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
