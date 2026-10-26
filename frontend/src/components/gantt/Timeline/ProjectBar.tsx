/**
 * ProjectBar
 * Visual bar representing a project on the timeline with confirmed/unconfirmed styling
 * Supports dragging to move entire project (with confirmation on release),
 * with the mouse or a finger (a touch is handed on as a mouse-like event once
 * the finger has moved past a small threshold, so a jittery tap is no move).
 */

import { memo, useCallback } from 'react';
import { barTextColor } from '@/utils/tags';
import { armTouchGesture } from '@/utils/touchEvents';
import styles from './ProjectBar.module.css';

interface ProjectBarProps {
  left: number;
  width: number;
  name: string;
  confirmed: boolean;
  completion?: number | null;
  projectId: number;
  startDate: string;
  endDate: string;
  onDragStart?: (e: React.MouseEvent) => void;
  /**
   * Solid bar colour from the user's "Colour by" choice: the project's item of
   * a field, or its tag (utils/projectFilters.ts projectBarColor). Null/undefined = default gradient. The
   * unconfirmed stripes stay on top either way.
   */
  color?: string | null;
}

export const ProjectBar = memo(function ProjectBar({
  left,
  width,
  name,
  confirmed,
  completion,
  projectId,
  startDate,
  endDate,
  onDragStart,
  color,
}: ProjectBarProps) {
  const textColor = color ? barTextColor(color) : null;
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (onDragStart) armTouchGesture(e, { onStart: onDragStart });
    },
    [onDragStart]
  );
  return (
    <div
      className={`${styles.bar} ${onDragStart ? styles.interactive : ''} ${confirmed ? styles.confirmed : styles.unconfirmed} ${textColor === '#111827' ? styles.darkText : ''} gantt-bar`}
      style={color ? { left, width, background: color, color: textColor ?? undefined } : { left, width }}
      data-tag-color={color ?? undefined}
      title={`${name}${completion != null ? ` (${completion}%)` : ''}\nDrag to move project`}
      data-project-id={projectId}
      data-start={startDate}
      data-end={endDate}
      onMouseDown={onDragStart}
      onTouchStart={onDragStart ? handleTouchStart : undefined}
    >
      {width > 60 && <span className={styles.label}>{name}</span>}
    </div>
  );
});
