/**
 * AssignmentRow
 * Display a staff or equipment assignment row with type badge
 * Right-click to edit/delete assignment
 */

import { memo, useCallback } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useEquipmentOverlaps } from '@/hooks/useEquipmentOverlaps';
import { OverlapWarningIcon } from '@/components/common/OverlapWarningIcon';
import { PendingBadge } from '@/components/common/PendingBadge';
import { canBookEquipment, canEditAssignment } from '@/utils/permissions';
import { isPendingAssignment, requestedAllocation } from '@/utils/kanbanCards';
import type { AssignmentApproval, StaffAssignment } from '@/types';
import styles from './AssignmentRow.module.css';

interface AssignmentRowProps {
  type: 'staff' | 'equipment' | 'phase-staff' | 'subphase-staff';
  assignmentId: number;
  projectId: number;
  phaseId?: number;
  subphaseId?: number;
  staffId?: number;
  equipmentId?: number;
  name: string;
  role?: string;
  equipmentType?: string;
  allocation?: number;
  depth: number;
  phaseType?: string;
  phaseColor?: string;
  startDate?: string;
  endDate?: string;
  /** Staff rows: 'pending' = a booking awaiting approval (shown dashed) */
  approvalStatus?: StaffAssignment['approval_status'];
  /** Staff rows: the open approval request (create, change or removal) */
  approval?: AssignmentApproval | null;
}

export const AssignmentRow = memo(function AssignmentRow({
  type,
  assignmentId,
  projectId,
  phaseId,
  subphaseId,
  staffId,
  equipmentId,
  name,
  role,
  equipmentType,
  allocation,
  depth,
  phaseType,
  phaseColor,
  startDate,
  endDate,
  approvalStatus,
  approval,
}: AssignmentRowProps) {
  const showContextMenu = useUIStore((s) => s.showContextMenu);
  const currentUser = useAppStore((s) => s.currentUser);
  // Only the manager id matters here; a primitive selector keeps the memo cheap.
  const pmId = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.pm_id);
  const overlapMap = useEquipmentOverlaps();
  const hasEquipmentConflict =
    type === 'equipment' && equipmentId !== undefined && overlapMap.get(equipmentId)?.hasOverlap === true;

  // Equipment bookings need equipment_bookings.manage (or managing the
  // project); a staff booking may also be changed by the person it books.
  const canEdit = type === 'equipment'
    ? canBookEquipment(currentUser, { pm_id: pmId })
    : canEditAssignment(currentUser, { pm_id: pmId }, staffId);
  // A decider of the open request opens the menu too (Approve / Reject).
  const canOpenMenu = canEdit || (type !== 'equipment' && approval?.can_decide === true);

  // Own bookings awaiting approval (staff rows only).
  const isStaffRow = type !== 'equipment';
  const pending = isStaffRow && isPendingAssignment({ approval_status: approvalStatus });
  const requested =
    isStaffRow && approval && allocation !== undefined
      ? requestedAllocation({ allocation, approval } as StaffAssignment)
      : null;
  const allocationText =
    allocation === undefined ? null : requested !== null ? `${allocation}% → ${requested}%` : `${allocation}%`;
  const rowClass = [styles.row, canOpenMenu ? styles.editable : '', pending ? styles.pending : '']
    .filter(Boolean)
    .join(' ');
  const badge =
    isStaffRow && (pending || approval) ? (
      <PendingBadge assignment={{ approval_status: approvalStatus, approval }} projectId={projectId} />
    ) : null;
  
  const paddingLeft = depth * 16 + 28; // Extra offset for no expand button

  // Handle right-click context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!canOpenMenu) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    // Determine if this is a staff or equipment assignment
    const assignmentType = type === 'equipment' ? 'equipmentAssignment' : 'staffAssignment';
    
    showContextMenu(
      assignmentType,
      assignmentId,
      e.clientX,
      e.clientY,
      projectId,
      phaseId,
      subphaseId,
      {
        staffId,
        equipmentId,
        name,
        allocation,
        startDate,
        endDate,
      }
    );
  }, [canOpenMenu, showContextMenu, type, assignmentId, projectId, phaseId, subphaseId, staffId, equipmentId, name, allocation, startDate, endDate]);

  // Phase/subphase staff has special styling - shows 📌 and phase type badge
  if (type === 'phase-staff' || type === 'subphase-staff') {
    return (
      <div 
        className={rowClass} 
        style={{ paddingLeft }}
        onContextMenu={handleContextMenu}
      >
        {/* Phase type badge with pin icon */}
        <span 
          className={styles.typeBadge}
          style={{ 
            backgroundColor: phaseColor ? `${phaseColor}33` : 'rgba(139, 92, 246, 0.2)',
            color: phaseColor || 'var(--accent-purple)' 
          }}
        >
          📌 {phaseType || (type === 'subphase-staff' ? 'Subphase' : 'Phase')}
        </span>

        {/* Staff name */}
        <span className={styles.name} title={name}>
          {name}
        </span>

        {badge}

        {/* Allocation */}
        {allocationText !== null && (
          <span className={styles.allocation}>{allocationText}</span>
        )}
      </div>
    );
  }

  return (
    <div 
      className={rowClass} 
      style={{ paddingLeft }}
      onContextMenu={handleContextMenu}
    >
      {/* Type badge */}
      <span className={`${styles.typeBadge} ${styles[type]}`}>
        {type === 'staff' ? 'STAFF' : 'EQUIP'}
      </span>

      {/* Name and role/type */}
      <span className={styles.name} title={`${name}${role ? ` - ${role}` : ''}${equipmentType ? ` - ${equipmentType}` : ''}`}>
        {name}
        {(role || equipmentType) && (
          <span className={styles.detail}> · {role || equipmentType}</span>
        )}
      </span>

      {hasEquipmentConflict && (
        <OverlapWarningIcon
          size={12}
          title="This equipment has overlapping bookings or blocks"
        />
      )}

      {badge}

      {/* Allocation */}
      {type === 'staff' && allocationText !== null && (
        <span className={styles.allocation}>{allocationText}</span>
      )}
    </div>
  );
});
