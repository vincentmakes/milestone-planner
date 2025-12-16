/**
 * AssignmentRow
 * Display a staff or equipment assignment row with type badge
 * Right-click to edit/delete assignment
 */

import { memo, useCallback } from 'react';
import { useUIStore } from '@/stores/uiStore';
import { useAppStore } from '@/stores/appStore';
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
}: AssignmentRowProps) {
  const showContextMenu = useUIStore((s) => s.showContextMenu);
  const currentUser = useAppStore((s) => s.currentUser);
  
  const canEdit = currentUser?.role === 'admin' || currentUser?.role === 'superuser';
  
  const paddingLeft = depth * 16 + 28; // Extra offset for no expand button

  // Handle right-click context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!canEdit) return;
    
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
  }, [canEdit, showContextMenu, type, assignmentId, projectId, phaseId, subphaseId, staffId, equipmentId, name, allocation, startDate, endDate]);

  // Phase/subphase staff has special styling - shows 📌 and phase type badge
  if (type === 'phase-staff' || type === 'subphase-staff') {
    return (
      <div 
        className={`${styles.row} ${canEdit ? styles.editable : ''}`} 
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

        {/* Allocation */}
        {allocation !== undefined && (
          <span className={styles.allocation}>{allocation}%</span>
        )}
      </div>
    );
  }

  return (
    <div 
      className={`${styles.row} ${canEdit ? styles.editable : ''}`} 
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

      {/* Allocation */}
      {type === 'staff' && allocation !== undefined && (
        <span className={styles.allocation}>{allocation}%</span>
      )}
    </div>
  );
});
