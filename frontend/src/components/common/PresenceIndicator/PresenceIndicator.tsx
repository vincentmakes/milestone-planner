/**
 * PresenceIndicator Component
 * 
 * Shows avatars/names of users currently viewing or editing a project.
 * Displays warning when others are editing.
 */

import { memo } from 'react';
import { PresenceUser } from '@/api/endpoints/presence';
import styles from './PresenceIndicator.module.css';

interface PresenceIndicatorProps {
  viewers: PresenceUser[];
  /** Compact mode for inline display */
  compact?: boolean;
  /** Maximum avatars to show before "+N" */
  maxAvatars?: number;
}

/**
 * Get initials from name
 */
function getInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

/**
 * Get color for avatar based on user ID (consistent per user)
 */
function getAvatarColor(userId: number): string {
  const colors = [
    '#3b82f6', // blue
    '#8b5cf6', // purple
    '#ec4899', // pink
    '#f97316', // orange
    '#10b981', // green
    '#06b6d4', // cyan
    '#f59e0b', // amber
    '#ef4444', // red
  ];
  return colors[userId % colors.length];
}

export const PresenceIndicator = memo(function PresenceIndicator({
  viewers,
  compact = false,
  maxAvatars = 3,
}: PresenceIndicatorProps) {
  if (viewers.length === 0) return null;

  const hasEditors = viewers.some(v => v.activity === 'editing');
  const displayViewers = viewers.slice(0, maxAvatars);
  const remainingCount = viewers.length - maxAvatars;

  // Build tooltip text
  const tooltipText = viewers
    .map(v => `${v.first_name} ${v.last_name} (${v.activity})`)
    .join('\n');

  if (compact) {
    return (
      <div 
        className={`${styles.compact} ${hasEditors ? styles.hasEditors : ''}`}
        title={tooltipText}
      >
        <span className={styles.icon}>👁️</span>
        <span className={styles.count}>{viewers.length}</span>
      </div>
    );
  }

  return (
    <div className={`${styles.container} ${hasEditors ? styles.hasEditors : ''}`}>
      <div className={styles.avatars} title={tooltipText}>
        {displayViewers.map((viewer) => (
          <div
            key={viewer.user_id}
            className={`${styles.avatar} ${viewer.activity === 'editing' ? styles.editing : ''}`}
            style={{ backgroundColor: getAvatarColor(viewer.user_id) }}
            title={`${viewer.first_name} ${viewer.last_name} (${viewer.activity})`}
          >
            {getInitials(viewer.first_name, viewer.last_name)}
          </div>
        ))}
        {remainingCount > 0 && (
          <div className={styles.moreCount}>+{remainingCount}</div>
        )}
      </div>
      {hasEditors && (
        <span className={styles.editingLabel}>editing</span>
      )}
    </div>
  );
});

/**
 * Warning banner for when there are conflicts or other editors
 */
interface ConflictWarningProps {
  message: string;
  onRefresh?: () => void;
  onDismiss?: () => void;
}

export const ConflictWarning = memo(function ConflictWarning({
  message,
  onRefresh,
  onDismiss,
}: ConflictWarningProps) {
  return (
    <div className={styles.conflictWarning}>
      <span className={styles.warningIcon}>⚠️</span>
      <span className={styles.warningMessage}>{message}</span>
      {onRefresh && (
        <button className={styles.refreshBtn} onClick={onRefresh}>
          Refresh
        </button>
      )}
      {onDismiss && (
        <button className={styles.dismissBtn} onClick={onDismiss}>
          ✕
        </button>
      )}
    </div>
  );
});
