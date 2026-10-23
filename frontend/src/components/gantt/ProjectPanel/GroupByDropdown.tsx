/**
 * GroupByDropdown - "Group by" control of the Gantt project panel.
 *
 * Trigger "Group by" / "Grouped by <field>"; options "No grouping" plus one
 * per dropdown project field applying to the site (field display order), and
 * Collapse all / Expand all while grouped. Renders nothing when no field is
 * available. Shell, close rules and placement: FieldChoiceDropdown.
 */

import { useGanttGrouping } from '@/hooks/useGanttGrouping';
import { FieldChoiceDropdown } from './FieldChoiceDropdown';
// Footer styles live with the shared shell
import styles from './FieldChoiceDropdown.module.css';
import { Icon, GroupByIcon } from '@/components/common/Icon';

export function GroupByDropdown() {
  const { siteId, field, fields, collapsedKeys, setField, collapseAll, expandAll } = useGanttGrouping();

  return (
    <FieldChoiceDropdown
      triggerLabel="Group by"
      activeLabel={(f) => `Grouped by ${f.name}`}
      idleTitle="Group projects by a field"
      headerLabel="Group by"
      dialogLabel="Group projects"
      radioGroupLabel="Group projects by a field"
      noneLabel="No grouping"
      icon={<Icon icon={GroupByIcon} size={14} />}
      value={field}
      choices={fields}
      onChange={setField}
      disabled={siteId === null}
      footer={
        field && (
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
