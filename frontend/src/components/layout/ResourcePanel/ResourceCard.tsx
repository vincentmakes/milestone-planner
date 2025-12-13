import type { Staff, Equipment, ResourceTab, Project, Vacation } from '@/types';
import { useAppStore } from '@/stores/appStore';
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

// Helper to check if equipment is booked TODAY
function isEquipmentBookedToday(projects: Project[], equipmentId: number): boolean {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  
  for (const project of projects) {
    for (const booking of project.equipmentAssignments || []) {
      if (booking.equipment_id === equipmentId &&
          isActiveToday(booking.start_date, booking.end_date, today)) {
        return true;
      }
    }
    
    for (const phase of project.phases || []) {
      for (const booking of phase.equipmentAssignments || []) {
        if (booking.equipment_id === equipmentId &&
            isActiveToday(phase.start_date, phase.end_date, today)) {
          return true;
        }
      }
      
      // Check subphases recursively
      const checkSubphases = (subphases: typeof phase.children): boolean => {
        for (const subphase of subphases || []) {
          for (const booking of subphase.equipmentAssignments || []) {
            if (booking.equipment_id === equipmentId &&
                isActiveToday(subphase.start_date, subphase.end_date, today)) {
              return true;
            }
          }
          if (subphase.children && checkSubphases(subphase.children)) {
            return true;
          }
        }
        return false;
      };
      
      if (checkSubphases(phase.children)) {
        return true;
      }
    }
  }
  return false;
}

export function ResourceCard({ resource, type, projects }: ResourceCardProps) {
  // Get vacations from store for vacation checking
  const vacations = useAppStore((s) => s.vacations);
  
  // Calculate allocation for TODAY
  const allocation = type === 'staff' 
    ? calculateStaffAllocationToday(projects, resource.id, vacations)
    : isEquipmentBookedToday(projects, resource.id) ? 100 : 0;
  
  const available = 100 - allocation;

  const isStaff = type === 'staff';
  const staffResource = resource as Staff;
  const equipmentResource = resource as Equipment;

  const getAvailabilityColor = (available: number) => {
    if (available <= 0) return 'var(--accent-red)';
    if (available < 30) return 'var(--accent-orange)';
    if (available < 60) return 'var(--accent-yellow)';
    return 'var(--accent-green)';
  };

  return (
    <div className={styles.card}>
      <div className={styles.info}>
        <span className={styles.name}>{resource.name}</span>
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
              backgroundColor: getAvailabilityColor(available),
            }}
          />
        </div>
        <span
          className={styles.percent}
          style={{ color: getAvailabilityColor(available) }}
        >
          {available}%
        </span>
      </div>
    </div>
  );
}
