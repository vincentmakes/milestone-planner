/**
 * GroupByDropdown - "Group by tag group" control of the Gantt project panel.
 *
 * Trigger "Group by" / "Grouped by <group>"; options "No grouping" plus one
 * per tag group (group display order), and Collapse all / Expand all while
 * grouped. Shell, close rules and placement: TagGroupChoiceDropdown.
 */

import { useAppStore } from '@/stores/appStore';
import { useGanttGrouping } from '@/hooks/useGanttGrouping';
import { TagGroupChoiceDropdown } from './TagGroupChoiceDropdown';
// Footer styles live with the shared shell
import styles from './TagGroupChoiceDropdown.module.css';
import { Icon, GroupByIcon } from '@/components/common/Icon';

export function GroupByDropdown() {
  const tagGroups = useAppStore((s) => s.tagGroups);
  const { siteId, group, collapsedKeys, setGroup, collapseAll, expandAll } = useGanttGrouping();

  return (
    <TagGroupChoiceDropdown
      triggerLabel="Group by"
      activeLabel={(g) => `Grouped by ${g.name}`}
      idleTitle="Group projects by tag group"
      headerLabel="Group by"
      dialogLabel="Group projects"
      radioGroupLabel="Group projects by tag group"
      noneLabel="No grouping"
      icon={
        /* Stacked sections icon */
        <Icon icon={GroupByIcon} size={14} />
      }
      value={group}
      groups={tagGroups}
      onChange={setGroup}
      disabled={siteId === null}
      footer={
        group && (
          <div className={styles.footer}>
            <button type="button" className={styles.footerBtn} onClick={collapseAll}>
              Collapse all
            </button>
            <button
              type="button"
              className={styles.footerBtn}
              onClick={expandAll}
              disabled={collapsedKeys.length === 0}
            >
              Expand all
            </button>
          </div>
        )
      }
    />
  );
}
