/**
 * ChangeIndicator Component
 * 
 * Shows a brief visual indicator when another user modifies an entity.
 * Used to show real-time changes on the Gantt chart.
 */

import { memo, useEffect, useState } from 'react';
import { useEntityChangeIndicator } from '@/contexts/WebSocketContext';
import styles from './ChangeIndicator.module.css';

interface ChangeIndicatorProps {
  /** Type of entity (phase, subphase, project, assignment) */
  entityType: string;
  /** ID of the entity */
  entityId: number;
  /** Optional custom className */
  className?: string;
}

/**
 * Inline indicator that shows who made a change
 * Auto-fades after a few seconds
 */
export const ChangeIndicator = memo(function ChangeIndicator({
  entityType,
  entityId,
  className = '',
}: ChangeIndicatorProps) {
  const { isChanged, changedBy } = useEntityChangeIndicator(entityType, entityId);
  const [visible, setVisible] = useState(false);

  // Show when change detected, then fade out
  useEffect(() => {
    if (isChanged && changedBy) {
      setVisible(true);
      const timeout = setTimeout(() => setVisible(false), 3000);
      return () => clearTimeout(timeout);
    }
  }, [isChanged, changedBy]);

  if (!visible || !changedBy) return null;

  return (
    <span className={`${styles.indicator} ${className}`}>
      <span className={styles.icon}>✨</span>
      <span className={styles.text}>{changedBy}</span>
    </span>
  );
});

/**
 * Highlight wrapper that adds a glow effect when entity is changed
 */
interface ChangeHighlightProps {
  entityType: string;
  entityId: number;
  children: React.ReactNode;
  className?: string;
}

export const ChangeHighlight = memo(function ChangeHighlight({
  entityType,
  entityId,
  children,
  className = '',
}: ChangeHighlightProps) {
  const { isChanged } = useEntityChangeIndicator(entityType, entityId);
  const [highlight, setHighlight] = useState(false);

  useEffect(() => {
    if (isChanged) {
      setHighlight(true);
      const timeout = setTimeout(() => setHighlight(false), 2000);
      return () => clearTimeout(timeout);
    }
  }, [isChanged]);

  return (
    <div className={`${className} ${highlight ? styles.highlighted : ''}`}>
      {children}
    </div>
  );
});

/**
 * Toast notification for changes (alternative to inline indicator)
 */
interface ChangeToastProps {
  entityType: string;
  entityId: number;
  entityName?: string;
}

export const ChangeToast = memo(function ChangeToast({
  entityType,
  entityId,
  entityName,
}: ChangeToastProps) {
  const { isChanged, changedBy } = useEntityChangeIndicator(entityType, entityId);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isChanged && changedBy) {
      setVisible(true);
      const timeout = setTimeout(() => setVisible(false), 4000);
      return () => clearTimeout(timeout);
    }
  }, [isChanged, changedBy]);

  if (!visible || !changedBy) return null;

  const entityLabel = entityName || `${entityType} #${entityId}`;

  return (
    <div className={styles.toast}>
      <span className={styles.toastIcon}>✨</span>
      <span className={styles.toastText}>
        <strong>{changedBy}</strong> modified {entityLabel}
      </span>
    </div>
  );
});

export default ChangeIndicator;
