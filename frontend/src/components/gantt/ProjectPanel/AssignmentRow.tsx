/**
 * AssignmentRow
 * Display a staff or equipment assignment row with type badge
 */

import { memo } from 'react';
import styles from './AssignmentRow.module.css';

interface AssignmentRowProps {
  type: 'staff' | 'equipment' | 'phase-staff';
  name: string;
  role?: string;
  equipmentType?: string;
  allocation?: number;
  depth: number;
  phaseType?: string;
  phaseColor?: string;
}

export const AssignmentRow = memo(function AssignmentRow({
  type,
  name,
  role,
  equipmentType,
  allocation,
  depth,
  phaseType,
  phaseColor,
}: AssignmentRowProps) {
  const paddingLeft = depth * 16 + 28; // Extra offset for no expand button

  // Phase staff has special styling - shows 📌 and phase type badge
  if (type === 'phase-staff') {
    return (
      <div className={styles.row} style={{ paddingLeft }}>
        {/* Phase type badge with pin icon */}
        <span 
          className={styles.typeBadge}
          style={{ 
            backgroundColor: phaseColor ? `${phaseColor}33` : 'rgba(139, 92, 246, 0.2)',
            color: phaseColor || 'var(--accent-purple)' 
          }}
        >
          📌 {phaseType || 'Phase'}
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
    <div className={styles.row} style={{ paddingLeft }}>
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
