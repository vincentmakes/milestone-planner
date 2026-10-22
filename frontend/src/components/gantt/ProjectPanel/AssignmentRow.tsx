/**
 * AssignmentRow
 * Display a staff or equipment assignment row with type badge
 * Right-click to edit/delete assignment
 */

import { memo, useCallback } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
import { useUndoStore } from '@/stores/undoStore';
import { updateStaffAssignment } from '@/api/endpoints/projects';
import { isPendingResponse } from '@/api/endpoints/approvals';
import { flashSentForApproval, markRequestPendingLocally } from '@/utils/pendingBookings';
import { patchStaffAssignmentLocally } from '@/utils/localProjectTree';
import { recoverFromPersistFailure } from '@/utils/persistFailure';
import { toDateOnly } from '@/utils/date';
import { useEquipmentOverlaps } from '@/hooks/useEquipmentOverlaps';
import { OverlapWarningIcon } from '@/components/common/OverlapWarningIcon';
import { PendingBadge } from '@/components/common/PendingBadge';
import { canBookEquipment, canEditAssignment } from '@/utils/permissions';
import { isPendingAssignment, requestedAllocation } from '@/utils/kanbanCards';
import type { AssignmentApproval, StaffAssignment, UpdateStaffAssignmentRequest } from '@/types';
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
  /** Phase / subphase staff rows: follows the card (true, the default) or has its own dates */
  linked?: boolean;
  /** Phase / subphase staff rows: the card's dates (an unlink starts from them) */
  cardStartDate?: string;
  cardEndDate?: string;
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
  linked = true,
  cardStartDate,
  cardEndDate,
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
        ...(type === 'phase-staff' || type === 'subphase-staff' ? { linked } : {}),
      }
    );
  }, [canOpenMenu, showContextMenu, type, assignmentId, projectId, phaseId, subphaseId, staffId, equipmentId, name, allocation, startDate, endDate, linked]);

  // The pin: a card booking follows its card (📌) or has its own dates (📍).
  // Whoever may change the booking toggles it; a pending booking, or one with
  // my own request open, is locked like in the context menu.
  const isRequester = Boolean(approval && currentUser && approval.requester_id === currentUser.id);
  const canTogglePin = canEdit && !pending && !isRequester && Boolean(cardStartDate && cardEndDate);
  const handlePinClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!cardStartDate || !cardEndDate) return;
    const level = type === 'subphase-staff' ? 'subphase' : 'phase';
    const cardStart = toDateOnly(cardStartDate);
    const cardEnd = toDateOnly(cardEndDate);
    // Unlink: own dates, starting as the card's. Relink: null dates.
    const body: UpdateStaffAssignmentRequest = linked
      ? { start_date: cardStart, end_date: cardEnd }
      : { start_date: null, end_date: null };
    const before = { linked, start_date: startDate ?? cardStart, end_date: endDate ?? cardEnd };
    useUndoStore.getState().saveState(useAppStore.getState().projects, 'booking dates');
    patchStaffAssignmentLocally(projectId, assignmentId, level, {
      linked: !linked,
      start_date: cardStart,
      end_date: cardEnd,
    });
    try {
      const res = await updateStaffAssignment(assignmentId, body, level);
      if (isPendingResponse(res)) {
        // Sent for approval: the booking keeps its dates until someone decides.
        patchStaffAssignmentLocally(projectId, assignmentId, level, before);
        const me = useAppStore.getState().currentUser;
        if (me) markRequestPendingLocally(projectId, assignmentId, level, me.id, 'assignments.self_update', res, body);
        flashSentForApproval();
      }
    } catch (err) {
      useUIStore.getState().showFlash(err instanceof Error ? err.message : 'Could not change the booking');
      await recoverFromPersistFailure('Booking', err);
    }
  }, [type, linked, cardStartDate, cardEndDate, startDate, endDate, projectId, assignmentId]);

  // Phase/subphase staff has special styling - shows the pin and phase type badge
  if (type === 'phase-staff' || type === 'subphase-staff') {
    const cardWord = type === 'subphase-staff' ? 'subphase' : 'phase';
    const pinTitle = linked
      ? `Follows the ${cardWord} dates — click to give it its own dates`
      : `Own dates — click to follow the ${cardWord} dates again`;
    const badgeStyle = {
      backgroundColor: phaseColor ? `${phaseColor}33` : 'rgba(139, 92, 246, 0.2)',
      color: phaseColor || 'var(--accent-purple)',
    };
    const badgeText = `${linked ? '📌' : '📍'} ${phaseType || (type === 'subphase-staff' ? 'Subphase' : 'Phase')}`;
    return (
      <div 
        className={rowClass} 
        style={{ paddingLeft }}
        onContextMenu={handleContextMenu}
      >
        {/* Phase type badge with the pin: a toggle for whoever may change the booking */}
        {canTogglePin ? (
          <button
            type="button"
            className={`${styles.typeBadge} ${styles.pinBadge}`}
            style={badgeStyle}
            aria-pressed={!linked}
            aria-label={`Own dates for ${name}`}
            title={pinTitle}
            onClick={handlePinClick}
          >
            {badgeText}
          </button>
        ) : (
          <span
            className={styles.typeBadge}
            style={badgeStyle}
            title={linked ? `Follows the ${cardWord} dates` : 'Own dates'}
          >
            {badgeText}
          </span>
        )}

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
