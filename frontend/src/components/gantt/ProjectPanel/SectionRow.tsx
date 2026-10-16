/**
 * SectionRow - header of one "Group by tag group" section in the project
 * tree: chevron + tag pill + project count. Clicking anywhere toggles it.
 *
 * Its height (--section-row-height + 1 px border) must equal the timeline's
 * `groupBand` (TimelineBody) and SECTION_ROW_TOTAL_HEIGHT (rowPositions.ts).
 * Class names deliberately avoid "row": drag/resize hooks and the dependency
 * layer locate rows with `[class*="row"]` selectors.
 */

import { memo } from 'react';
import { barTextColor } from '@/utils/tags';
import type { GanttSection } from '../utils/projectSections';
import styles from './SectionRow.module.css';

interface SectionRowProps {
  section: GanttSection;
  collapsed: boolean;
  onToggle: (key: string) => void;
  /** Width of the name column: the pill + count stay inside it. */
  width: number;
}

export const SectionRow = memo(function SectionRow({ section, collapsed, onToggle, width }: SectionRowProps) {
  const count = section.projects.length;
  const toggle = () => onToggle(section.key);
  const pillStyle = section.tag
    ? { backgroundColor: section.tag.color, color: barTextColor(section.tag.color) }
    : undefined;

  return (
    <div
      className={styles.groupHeader}
      onClick={toggle}
      data-section-key={section.key}
      style={{ '--name-column-width': `${width}px` } as React.CSSProperties}
    >
      <button
        type="button"
        className={styles.collapseBtn}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${section.label}`}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        <svg
          className={`${styles.chevron} ${collapsed ? styles.chevronCollapsed : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <span className={`${styles.pill} ${section.tag ? '' : styles.pillNone}`} style={pillStyle}>
        {section.label}
      </span>
      <span className={styles.count}>
        {count} {count === 1 ? 'project' : 'projects'}
      </span>
    </div>
  );
});
