/**
 * SectionRow - header of one Gantt "Group by" section in the project tree:
 * chevron + item pill (the field item's colour) + project count. Clicking
 * anywhere toggles it.
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
import { Icon, ChevronDownIcon } from '@/components/common/Icon';

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
  const pillStyle = section.option
    ? { backgroundColor: section.option.color, color: barTextColor(section.option.color) }
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
        <Icon icon={ChevronDownIcon} size={12} className={`${styles.chevron} ${collapsed ? styles.chevronCollapsed : ''}`} />
      </button>
      <span className={`${styles.pill} ${section.option ? '' : styles.pillNone}`} style={pillStyle}>
        {section.label}
      </span>
      <span className={styles.count}>
        {count} {count === 1 ? 'project' : 'projects'}
      </span>
    </div>
  );
});
