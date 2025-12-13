/**
 * ProjectBar
 * Visual bar representing a project on the timeline with confirmed/unconfirmed styling
 * Supports dragging to move entire project (with confirmation on release)
 */

import { memo } from 'react';
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
}: ProjectBarProps) {
  return (
    <div
      className={`${styles.bar} ${confirmed ? styles.confirmed : styles.unconfirmed} gantt-bar`}
      style={{ left, width }}
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
