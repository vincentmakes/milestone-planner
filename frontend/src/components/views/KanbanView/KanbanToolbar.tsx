/**
 * Kanban toolbar: project picker, project filter, swimlane grouping, My Todo filter.
 */

import { Select } from '@/components/common';
import { ProjectFilterDropdown } from '@/components/common/ProjectFilterDropdown';
import type { CustomColumn, Project } from '@/types';
import type { KanbanGrouping } from '@/utils/kanbanCards';
import styles from './KanbanToolbar.module.css';
import { Icon, CheckBoxIcon } from '@/components/common/Icon';

interface KanbanToolbarProps {
  projects: Project[];
  selectedProjectId: number | null;
  /** null = all projects in the site. */
  onSelectProject: (projectId: number | null) => void;
  grouping: KanbanGrouping;
  groupingColumnId: number | null;
  listColumns: CustomColumn[];
  onChangeGrouping: (grouping: KanbanGrouping, columnId: number | null) => void;
  myTodoOnly: boolean;
  onToggleMyTodo: () => void;
  cardCount: number;
  totalCount: number;
}

/**
 * Grouping is encoded as a single select value: the fixed modes use their own
 * key, and a custom column uses `column:<id>` so one control drives both the
 * mode and which column it groups by.
 */
const CUSTOM_PREFIX = 'column:';
/** Sentinel for the "All projects" entry — the picker value must be a string. */
const ALL_PROJECTS = '__all__';

export function KanbanToolbar({
  projects,
  selectedProjectId,
  onSelectProject,
  grouping,
  groupingColumnId,
  listColumns,
  onChangeGrouping,
  myTodoOnly,
  onToggleMyTodo,
  cardCount,
  totalCount,
}: KanbanToolbarProps) {
  const groupingValue =
    grouping === 'customColumn' && groupingColumnId !== null
      ? `${CUSTOM_PREFIX}${groupingColumnId}`
      : grouping;

  const groupingOptions = [
    { value: 'none', label: 'No grouping' },
    { value: 'project', label: 'Group by project' },
    { value: 'phase', label: 'Group by phase' },
    { value: 'assignee', label: 'Group by assignee' },
    ...listColumns.map((c) => ({
      value: `${CUSTOM_PREFIX}${c.id}`,
      label: `Group by ${c.name}`,
    })),
  ];

  const handleGroupingChange = (raw: string) => {
    if (raw.startsWith(CUSTOM_PREFIX)) {
      onChangeGrouping('customColumn', Number(raw.slice(CUSTOM_PREFIX.length)));
    } else {
      onChangeGrouping(raw as KanbanGrouping, null);
    }
  };

  return (
    <div className={styles.toolbar}>
      <Select
        aria-label="Project"
        className={styles.projectSelect}
        options={[
          { value: ALL_PROJECTS, label: 'All projects' },
          ...projects.map((p) => ({ value: String(p.id), label: p.name })),
        ]}
        value={selectedProjectId === null ? ALL_PROJECTS : String(selectedProjectId)}
        disabled={projects.length === 0}
        onChange={(e) =>
          onSelectProject(e.target.value === ALL_PROJECTS ? null : Number(e.target.value))
        }
      />

      <ProjectFilterDropdown />

      <Select
        aria-label="Swimlane grouping"
        options={groupingOptions}
        value={groupingValue}
        onChange={(e) => handleGroupingChange(e.target.value)}
      />

      <button
        type="button"
        className={`${styles.todoToggle} ${myTodoOnly ? styles.active : ''}`}
        onClick={onToggleMyTodo}
        aria-pressed={myTodoOnly}
        title="Show only cards assigned to me"
      >
        <Icon icon={CheckBoxIcon} size={14} />
        My Todo
      </button>

      <span className={styles.count}>
        {myTodoOnly && cardCount !== totalCount
          ? `${cardCount} of ${totalCount} cards`
          : `${cardCount} card${cardCount === 1 ? '' : 's'}`}
      </span>
    </div>
  );
}
