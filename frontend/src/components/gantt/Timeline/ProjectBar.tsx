/**
 * ProjectBar
 * Visual bar representing a project on the timeline with confirmed/unconfirmed styling
 * Supports dragging to move entire project (with confirmation on release)
 */

import { memo } from 'react';
import { barTextColor } from '@/utils/tags';
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
   * Solid bar colour from the project's tag in the "colours projects" group
   * (utils/tags.ts projectBarColor). Null/undefined = default gradient. The
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
  return (
    <div
      className={`${styles.bar} ${confirmed ? styles.confirmed : styles.unconfirmed} ${textColor === '#111827' ? styles.darkText : ''} gantt-bar`}
      style={color ? { left, width, background: color, color: textColor ?? undefined } : { left, width }}
      data-tag-color={color ?? undefined}
      title={`${name}${completion != null ? ` (${completion}%)` : ''}\nDrag to move project`}
      data-project-id={projectId}
      data-start={startDate}
      data-end={endDate}
      onMouseDown={onDragStart}
    >
      {width > 60 && <span className={styles.label}>{name}</span>}
    </div>
  );
});
